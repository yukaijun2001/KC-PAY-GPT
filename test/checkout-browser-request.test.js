'use strict';

const vm = require('vm');
const { openApiCheckout } = require('../src/checkout/chatgpt');

function browserPage({ sdk, fetchResponse, appendScript, url = 'https://chatgpt.com/' } = {}) {
    const fetch = vi.fn(async () => fetchResponse || {
        status: 200,
        text: async () => JSON.stringify({ checkout_session_id: 'cs_test_browser' })
    });
    const window = { SentinelSDK: sdk || { init: vi.fn(), token: vi.fn(async () => 'test-sentinel-token') } };
    const document = {
        cookie: 'oai-did=device-from-session; oai-did=device-from-session',
        getElementById: () => null,
        createElement: () => ({}),
        head: { appendChild: appendScript || vi.fn() }
    };
    const sandbox = {
        window, document, location: { origin: 'https://chatgpt.com' },
        navigator: { language: 'en-US' }, fetch, AbortController,
        setTimeout, clearTimeout, URL, console
    };
    const post = vi.fn(async () => {
        throw new Error('Checkout must run in the browser, not context.request');
    });
    const page = {
        url: () => url,
        context: () => ({ request: { post } }),
        evaluate: vi.fn(async (fn, args) => vm.runInNewContext(`(${fn.toString()})(input)`, { ...sandbox, input: args }))
    };
    return { page, fetch, post, window, document };
}

const checkoutOptions = {
    accessToken: 'test-token', planType: 'plus',
    country: 'PH', currency: 'PHP', verifyPage: false
};

function syntheticTokenWithAccountId(accountId) {
    const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId } };
    return ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
}

describe('browser Checkout API', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each([
        ['go', 'chatgptgoplan'],
        ['plus', 'chatgptplusplan'],
        ['pro_10x', 'chatgptprolite'],
        ['pro_20x', 'chatgptpro'],
        ['pro_50x', 'chatgptpromax']
    ])('sends the requested %s plan name', async (planType, expectedPlanName) => {
        const run = browserPage();
        await openApiCheckout(run.page, { ...checkoutOptions, planType });
        expect(JSON.parse(run.fetch.mock.calls[0][1].body).plan_name).toBe(expectedPlanName);
    });

    it('rejects removed or unknown plan types even with a plan name override', async () => {
        for (const planType of ['pro_5x', 'unknown']) {
            const run = browserPage();
            await expect(openApiCheckout(run.page, {
                ...checkoutOptions, planType, planNameOverride: 'chatgptplusplan'
            })).rejects.toThrow('不支持的套餐类型');
            expect(run.fetch).not.toHaveBeenCalled();
        }
    });

    it('gets a fresh SDK token and creates Checkout in the same browser/session', async () => {
        const run = browserPage();
        const result = await openApiCheckout(run.page, checkoutOptions);
        expect(result.checkoutUrl).toBe('https://chatgpt.com/checkout/openai_llc/cs_test_browser');
        expect(run.window.SentinelSDK.token).toHaveBeenCalledWith('chatgpt_checkout');
        expect(run.fetch).toHaveBeenCalledOnce();
        const [url, init] = run.fetch.mock.calls[0];
        expect(url).toBe('/backend-api/payments/checkout');
        expect(init).toMatchObject({
            method: 'POST',
            credentials: 'include',
            headers: {
                Authorization: `Bearer ${checkoutOptions.accessToken}`,
                'openai-sentinel-token': 'test-sentinel-token',
                'oai-device-id': 'device-from-session',
                'oai-did': 'device-from-session'
            }
        });
        expect(init.headers['openai-sentinel-so-token']).toBeUndefined();
        expect(init.headers['x-openai-checkout-source']).toBeUndefined();
        expect(init.headers['x-openai-web-frontend']).toBeUndefined();
        expect(init.headers['x-openai-codex-window-type']).toBeUndefined();
        expect(JSON.parse(init.body)).toMatchObject({
            plan_name: 'chatgptplusplan', billing_details: { country: 'PH', currency: 'PHP' }
        });
        expect(run.post).not.toHaveBeenCalled();
    });

    it('serializes structured SDK tokens instead of using [object Object]', async () => {
        const run = browserPage({ sdk: { token: async () => ({ token: 'test-sentinel-token' }) } });
        await openApiCheckout(run.page, checkoutOptions);
        expect(run.fetch.mock.calls[0][1].headers['openai-sentinel-token']).toBe('{"token":"test-sentinel-token"}');
    });

    it('does not block Checkout on an unverified second SDK flow', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '30');
        const token = vi.fn(async (flow) => {
            if (flow === 'checkout_session_approval') return new Promise(() => {});
            return 'test-sentinel-token';
        });
        const run = browserPage({ sdk: { token } });
        const result = await openApiCheckout(run.page, checkoutOptions);
        expect(result.checkoutUrl).toContain('cs_test_browser');
        expect(token).toHaveBeenCalledTimes(1);
        expect(token).toHaveBeenCalledWith('chatgpt_checkout');
        expect(run.fetch.mock.calls[0][1].headers['openai-sentinel-so-token']).toBeUndefined();
    });

    it('loads the site SDK when it is not already present', async () => {
        const run = browserPage();
        run.window.SentinelSDK = undefined;
        run.document.head.appendChild = vi.fn((script) => {
            expect(script.src).toBe('/backend-api/sentinel/sdk.js');
            run.window.SentinelSDK = { token: async () => 'test-sentinel-token' };
            script.onload();
        });
        await openApiCheckout(run.page, checkoutOptions);
        expect(run.document.head.appendChild).toHaveBeenCalledOnce();
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it('reports SDK script load errors without sending Checkout', async () => {
        const run = browserPage();
        run.window.SentinelSDK = undefined;
        run.document.head.appendChild = vi.fn((script) => script.onerror());
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow('Sentinel SDK 加载失败');
        expect(run.fetch).not.toHaveBeenCalled();
    });

    it('uses the real SDK after the loader replaces its temporary stub object', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '25');
        const run = browserPage();
        run.window.SentinelSDK = undefined;
        const token = vi.fn(async () => 'test-sentinel-token');
        run.document.head.appendChild = (script) => {
            run.window.SentinelSDK = {
                init: async () => { run.window.SentinelSDK = { token }; },
                token: () => new Promise(() => {})
            };
            script.onload();
        };
        await openApiCheckout(run.page, checkoutOptions);
        expect(token).toHaveBeenCalledOnce();
        expect(token).toHaveBeenCalledWith('chatgpt_checkout');
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it('uses the active page account rather than an invented account ID', async () => {
        const run = browserPage();
        run.document.getElementById = () => ({ textContent: JSON.stringify({ session: { account: { id: 'account-from-session' } } }) });
        await openApiCheckout(run.page, checkoutOptions);
        expect(run.fetch.mock.calls[0][1].headers['chatgpt-account-id']).toBe('account-from-session');
    });

    it('uses the injected session account when the page bootstrap session lacks one', async () => {
        const run = browserPage();
        run.document.getElementById = () => ({ textContent: JSON.stringify({ session: { user: { id: 'user-id' } } }) });
        run.window.__CHATGPT_BOOTSTRAP_SESSION__ = { account: { id: 'account-from-injected-session' } };
        await openApiCheckout(run.page, { ...checkoutOptions, accessToken: syntheticTokenWithAccountId('account-from-token') });
        expect(run.fetch.mock.calls[0][1].headers['chatgpt-account-id']).toBe('account-from-injected-session');
    });

    it('uses the current access-token account claim when no page session has an account id', async () => {
        const run = browserPage();
        await openApiCheckout(run.page, { ...checkoutOptions, accessToken: syntheticTokenWithAccountId('account-from-token') });
        expect(run.fetch.mock.calls[0][1].headers['chatgpt-account-id']).toBe('account-from-token');
    });

    it('keeps the page bootstrap account ahead of other candidate account ids', async () => {
        const run = browserPage();
        run.document.getElementById = () => ({ textContent: JSON.stringify({ session: { account: { id: 'account-from-page' } } }) });
        run.window.__CHATGPT_BOOTSTRAP_SESSION__ = { account: { id: 'account-from-injected-session' } };
        await openApiCheckout(run.page, { ...checkoutOptions, accessToken: syntheticTokenWithAccountId('account-from-token') });
        expect(run.fetch.mock.calls[0][1].headers['chatgpt-account-id']).toBe('account-from-page');
    });

    it('does not fabricate an account header when no account candidate is available', async () => {
        const run = browserPage();
        await openApiCheckout(run.page, checkoutOptions);
        expect(run.fetch.mock.calls[0][1].headers['chatgpt-account-id']).toBeUndefined();
    });

    it('rejects invalid account-id header values from decoded claims', async () => {
        const run = browserPage();
        await openApiCheckout(run.page, { ...checkoutOptions, accessToken: syntheticTokenWithAccountId('invalid\r\nheader') });
        expect(run.fetch.mock.calls[0][1].headers['chatgpt-account-id']).toBeUndefined();
    });

    it('falls back to the token account if the page bootstrap is JSON null', async () => {
        const run = browserPage();
        run.document.getElementById = () => ({ textContent: 'null' });
        await openApiCheckout(run.page, { ...checkoutOptions, accessToken: syntheticTokenWithAccountId('account-from-token') });
        expect(run.fetch.mock.calls[0][1].headers['chatgpt-account-id']).toBe('account-from-token');
    });

    it('logs only non-sensitive context flags for comparing against the browser request', async () => {
        const sentinel = JSON.stringify({ flow: 'chatgpt_checkout', id: 'device-from-session', proof: 'private-proof' });
        const run = browserPage({ sdk: { token: async () => sentinel } });
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await openApiCheckout(run.page, { ...checkoutOptions, accessToken: syntheticTokenWithAccountId('account-from-token') });
            const output = spy.mock.calls.map(args => args.join(' ')).join('\n');
            expect(output).toContain('[Checkout] 请求上下文');
            expect(output).toContain('account=token');
            expect(output).toContain('sentinel_flow=match');
            expect(output).toContain('sentinel_device_match=yes');
            expect(output).not.toContain('account-from-token');
            expect(output).not.toContain('device-from-session');
            expect(output).not.toContain('private-proof');
        } finally {
            spy.mockRestore();
        }
    });

    it('reports mismatches as flags even when the creation request is rejected', async () => {
        const sentinel = JSON.stringify({ flow: 'other_flow', id: 'other-device', proof: 'private-proof' });
        const message = 'Our systems have detected unusual activity. Please try again later.';
        const run = browserPage({
            sdk: { token: async () => sentinel },
            fetchResponse: { status: 400, text: async () => JSON.stringify({ detail: message }) }
        });
        run.document.getElementById = () => ({ textContent: JSON.stringify({ session: { account: { id: 'page-account' } } }) });
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await expect(openApiCheckout(run.page, { ...checkoutOptions, accessToken: syntheticTokenWithAccountId('token-account') })).rejects.toThrow(message);
            const output = spy.mock.calls.map(args => args.join(' ')).join('\n');
            expect(output).toContain('account=page');
            expect(output).toContain('account_matches_token=no');
            expect(output).toContain('sentinel_flow=different');
            expect(output).toContain('sentinel_device_match=no');
            expect(output).not.toContain('page-account');
            expect(output).not.toContain('token-account');
            expect(output).not.toContain('other-device');
            expect(output).not.toContain('private-proof');
        } finally {
            spy.mockRestore();
        }
    });

    it('does not invent an oai-did header when the cookie is absent', async () => {
        const run = browserPage();
        run.document.cookie = '';
        await openApiCheckout(run.page, checkoutOptions);
        expect(run.fetch.mock.calls[0][1].headers['oai-did']).toBeUndefined();
    });

    it('ignores a malformed device cookie and keeps a real bootstrap device id', async () => {
        const run = browserPage();
        run.document.cookie = ['oai', 'did'].join('-') + '=' + '%E0%A4%A';
        run.document.getElementById = () => ({ textContent: JSON.stringify({ statsigContext: { deviceId: 'bootstrap-device' } }) });
        await openApiCheckout(run.page, checkoutOptions);
        const headers = run.fetch.mock.calls[0][1].headers;
        expect(headers['oai-device-id']).toBe('bootstrap-device');
        expect(headers['oai-did']).toBeUndefined();
    });

    it('does not send a bare request if the SDK returns an empty token', async () => {
        const run = browserPage({ sdk: { token: async () => '' } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow(/Sentinel/);
        expect(run.fetch).not.toHaveBeenCalled();
    });

    it('preserves the reported server error for the fallback decision', async () => {
        const message = 'Our systems have detected unusual activity. Please try again later.';
        const run = browserPage({ fetchResponse: { status: 403, text: async () => JSON.stringify({ detail: message }) } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow(`API 创建 Checkout 失败: ${message}`);
    });

    it('accepts a successful 201 response only when it actually contains a link', async () => {
        const run = browserPage({ fetchResponse: { status: 201, text: async () => JSON.stringify({ url: 'https://chatgpt.com/checkout/openai_llc/cs_test_created' }) } });
        const result = await openApiCheckout(run.page, checkoutOptions);
        expect(result.checkoutUrl).toContain('cs_test_created');
    });

    it('does not treat an HTTP-200 response without a checkout as success', async () => {
        const run = browserPage({ fetchResponse: { status: 200, text: async () => '{}' } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow('API 未返回 checkout_session_id 或 url');
    });

    it('uses the processor entity returned in an oaics creation response', async () => {
        const run = browserPage({ fetchResponse: { status: 200, text: async () => JSON.stringify({
            checkout_session_id: 'oaics_fixture_123', processor_entity: 'openai_fixture', url: null
        }) } });
        const result = await openApiCheckout(run.page, checkoutOptions);
        expect(result.checkoutUrl).toBe('https://chatgpt.com/checkout/openai_fixture/oaics_fixture_123');
    });

    it('does not construct a path from an invalid processor entity', async () => {
        const run = browserPage({ fetchResponse: { status: 200, text: async () => JSON.stringify({
            checkout_session_id: 'oaics_fixture_123', processor_entity: '../invalid', url: null
        }) } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow('API 未返回 checkout_session_id 或 url');
    });

    it('does not interpolate an invalid checkout id into a URL', async () => {
        const run = browserPage({ fetchResponse: { status: 200, text: async () => JSON.stringify({
            checkout_session_id: '../invalid', processor_entity: 'openai_fixture', url: null
        }) } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow('API 未返回 checkout_session_id 或 url');
    });

    it('does not expose response values when an ostensibly successful response has no link', async () => {
        const marker = ['fixture', 'value', 'must-not-appear'].join('-');
        const run = browserPage({ fetchResponse: { status: 200, text: async () => JSON.stringify({
            client_secret: marker, status: 'open'
        }) } });
        const error = await openApiCheckout(run.page, checkoutOptions).catch(err => err);
        expect(error.message).toContain('API 未返回 checkout_session_id 或 url');
        expect(error.message).not.toContain(marker);
    });

    it('keeps an HTTP error readable even if the body is JSON null', async () => {
        const run = browserPage({ fetchResponse: { status: 403, text: async () => 'null' } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow('API 创建 Checkout 失败: null');
    });

    it('bounds SDK waits so an unresponsive SDK can fall back to UI', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '15');
        const run = browserPage({ sdk: { token: () => new Promise(() => {}) } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow(/Sentinel.*超时/);
        expect(run.fetch).not.toHaveBeenCalled();
    });

    it('bounds initialization as well as token generation', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '15');
        const run = browserPage({ sdk: { init: () => new Promise(() => {}), token: vi.fn() } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow(/Sentinel.*超时/);
        expect(run.fetch).not.toHaveBeenCalled();
    });

    it('never sends credentials from an unexpected origin', async () => {
        const run = browserPage({ url: 'https://example.test/' });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow(/chatgpt.com/);
        expect(run.fetch).not.toHaveBeenCalled();
        expect(run.post).not.toHaveBeenCalled();
    });
});
