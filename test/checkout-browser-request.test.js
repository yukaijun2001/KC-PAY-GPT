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
        setTimeout, clearTimeout, Date, URL, console
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

    it.each(['void', 'pending'])('follows a delayed SDK replacement when loader init is %s', async (initialization) => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '250');
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '250');
        const run = browserPage();
        const token = vi.fn(async () => 'test-sentinel-token');
        const init = vi.fn(async () => {});
        run.window.SentinelSDK = {
            init: () => {
                setTimeout(() => { run.window.SentinelSDK = { init, token }; }, 10);
                if (initialization === 'pending') return new Promise(() => {});
            },
            token: () => new Promise(() => {})
        };
        await expect(openApiCheckout(run.page, checkoutOptions)).resolves.toMatchObject({
            checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_test_browser'
        });
        expect(init).toHaveBeenCalledOnce();
        expect(token).toHaveBeenCalledOnce();
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it('follows an in-place token implementation replacement', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '250');
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '250');
        const run = browserPage();
        const token = vi.fn(async () => 'test-sentinel-token');
        run.window.SentinelSDK = { token: () => new Promise(() => {}) };
        setTimeout(() => { run.window.SentinelSDK.token = token; }, 10);
        await openApiCheckout(run.page, checkoutOptions);
        expect(token).toHaveBeenCalledOnce();
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it('does not invoke token after initialization completes beyond its deadline', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '20');
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '20');
        const token = vi.fn(async () => 'test-sentinel-token');
        const run = browserPage({ sdk: { init: () => new Promise(resolve => setTimeout(resolve, 60)), token } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow(/Sentinel.*超时/);
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(token).not.toHaveBeenCalled();
        expect(run.fetch).not.toHaveBeenCalled();
    });

    it('preserves the SDK receiver for init and token methods', async () => {
        const sdk = {
            initialized: false,
            init() { this.initialized = true; },
            token() { return this.initialized ? 'fixture-sentinel' : ''; }
        };
        const run = browserPage({ sdk });
        await openApiCheckout(run.page, checkoutOptions);
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it('initializes once when init installs the token implementation in place', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '100');
        const token = vi.fn(async () => 'fixture-sentinel');
        const init = vi.fn(function () {
            this.token = (...args) => token(...args);
        });
        const run = browserPage({ sdk: { init, token: () => new Promise(() => {}) } });
        await openApiCheckout(run.page, checkoutOptions);
        expect(init).toHaveBeenCalledOnce();
        expect(token).toHaveBeenCalledOnce();
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it.each(['pending', 'late rejection'])('follows an in-place token handoff while loader init is %s', async completion => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '250');
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '250');
        const token = vi.fn(() => new Promise(resolve => setTimeout(() => resolve('fixture-sentinel'), 35)));
        const init = vi.fn(function () {
            setTimeout(() => { this.token = token; }, 10);
            return new Promise((_, reject) => {
                if (completion === 'late rejection') setTimeout(() => reject(new Error('obsolete-init-private-data')), 30);
            });
        });
        const run = browserPage({ sdk: { init, token: vi.fn(() => new Promise(() => {})) } });
        await openApiCheckout(run.page, checkoutOptions);
        expect(init).toHaveBeenCalledOnce();
        expect(token).toHaveBeenCalledOnce();
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it('follows an in-place init replacement without waiting for the stale init promise', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '250');
        const run = browserPage();
        const init = vi.fn(async () => {});
        const token = vi.fn(async () => 'fixture-sentinel');
        run.window.SentinelSDK = {
            init: () => {
                setTimeout(() => { run.window.SentinelSDK.init = init; }, 10);
                return new Promise(() => {});
            },
            token
        };
        await openApiCheckout(run.page, checkoutOptions);
        expect(init).toHaveBeenCalledOnce();
        expect(token).toHaveBeenCalledOnce();
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it('allocates independent initialization and token budgets', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '100');
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '100');
        const run = browserPage({ sdk: {
            init: () => new Promise(resolve => setTimeout(resolve, 60)),
            token: () => new Promise(resolve => setTimeout(() => resolve('fixture-sentinel'), 60))
        } });
        await openApiCheckout(run.page, checkoutOptions);
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it('does not reset the token deadline or retry the same pending implementation', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '30');
        const token = vi.fn(() => new Promise(() => {}));
        const run = browserPage({ sdk: { token } });
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow(/超时.*stage=token.*elapsed_ms=/);
        expect(token).toHaveBeenCalledOnce();
        expect(run.fetch).not.toHaveBeenCalled();
    });

    it.each(['init', 'token'])('keeps the absolute %s deadline across repeated SDK handoffs', async stage => {
        vi.useFakeTimers();
        try {
            vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '100');
            vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '100');
            const token = vi.fn(() => stage === 'token' ? new Promise(() => {}) : 'fixture-sentinel');
            const nextSdk = () => stage === 'init'
                ? { init: () => new Promise(() => {}), token }
                : { token: (...args) => token(...args) };
            const run = browserPage({ sdk: nextSdk() });
            const pending = openApiCheckout(run.page, checkoutOptions).catch(error => error);
            await vi.advanceTimersByTimeAsync(0);
            for (let i = 0; i < 4; i += 1) {
                await vi.advanceTimersByTimeAsync(20);
                run.window.SentinelSDK = nextSdk();
            }
            await vi.advanceTimersByTimeAsync(20);
            const error = await pending;
            expect(error.message).toMatch(new RegExp(`超时.*stage=${stage}, elapsed_ms=100`));
            expect(run.fetch).not.toHaveBeenCalled();
            expect(token).toHaveBeenCalledTimes(stage === 'init' ? 0 : 4);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('absorbs stale token rejection after the active implementation succeeds', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '250');
        const run = browserPage();
        let rejectOld;
        const token = vi.fn(async () => 'fixture-current-sentinel');
        run.window.SentinelSDK = { token: () => new Promise((_, reject) => { rejectOld = reject; }) };
        setTimeout(() => { run.window.SentinelSDK = { token }; }, 10);
        await openApiCheckout(run.page, checkoutOptions);
        rejectOld(new Error('private obsolete SDK failure'));
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(token).toHaveBeenCalledOnce();
        expect(run.fetch).toHaveBeenCalledOnce();
        expect(run.fetch.mock.calls[0][1].headers['openai-sentinel-token']).toBe('fixture-current-sentinel');
    });

    it('cleans owned script handlers on timeout and ignores a captured late onload', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '20');
        const run = browserPage();
        const remove = vi.fn();
        let onload;
        let script;
        run.window.SentinelSDK = undefined;
        run.document.createElement = () => ({ remove });
        run.document.head.appendChild = value => { script = value; onload = value.onload; };
        await expect(openApiCheckout(run.page, checkoutOptions)).rejects.toThrow(/超时.*stage=load/);
        expect(remove).toHaveBeenCalledOnce();
        expect(script.onload).toBeNull();
        expect(script.onerror).toBeNull();
        const token = vi.fn(async () => 'fixture-late-sentinel');
        run.window.SentinelSDK = { token };
        onload();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(token).not.toHaveBeenCalled();
        expect(run.fetch).not.toHaveBeenCalled();
    });

    it('waits for a page-owned SDK script without injecting or removing another script', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '250');
        const run = browserPage();
        run.window.SentinelSDK = undefined;
        const existingScript = { remove: vi.fn() };
        run.document.querySelector = () => existingScript;
        setTimeout(() => { run.window.SentinelSDK = { token: async () => 'fixture-sentinel' }; }, 10);
        await openApiCheckout(run.page, checkoutOptions);
        expect(run.document.head.appendChild).not.toHaveBeenCalled();
        expect(existingScript.remove).not.toHaveBeenCalled();
        expect(run.fetch).toHaveBeenCalledOnce();
    });

    it.each(['init', 'token'])('reports only the failing %s stage, not private SDK error text', async (method) => {
        const sdk = { token: async () => 'fixture-sentinel' };
        sdk[method] = () => Promise.reject(new Error('private SDK payload must not escape'));
        const run = browserPage({ sdk });
        const error = await openApiCheckout(run.page, checkoutOptions).catch(value => value);
        expect(error.message).toContain(`stage=${method}`);
        expect(error.message).not.toContain('private SDK payload');
        expect(run.fetch).not.toHaveBeenCalled();
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
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '15');
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
