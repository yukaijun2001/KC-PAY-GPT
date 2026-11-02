'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const { requestBrowserCheckout } = require('../src/checkout/checkout-browser-request');

const browserAvailable = fs.existsSync(chromium.executablePath());
const origin = 'https://chatgpt.com';
const checkoutInput = {
    accessToken: 'local-browser-fixture',
    payload: { plan_name: 'chatgptplusplan', billing_details: { country: 'PH', currency: 'PHP' } }
};

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(!browserAvailable)('Sentinel SDK lifecycle in intercepted Chromium', () => {
    let browser;
    let context;

    beforeAll(async () => {
        browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    });
    beforeEach(() => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '1000');
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '1000');
        vi.stubEnv('CHECKOUT_API_TIMEOUT_MS', '1000');
    });
    afterEach(async () => {
        if (context) await context.close();
        context = undefined;
        vi.unstubAllEnvs();
    });
    afterAll(async () => { if (browser) await browser.close(); });

    async function fixture({ sdkBody = '', sdkGate = Promise.resolve() } = {}) {
        // A new context has no real cookies or storage. Every request is fulfilled
        // or aborted locally: neither the origin nor a real Checkout is contacted.
        context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage();
        const checkoutRequests = [];
        const unexpected = [];
        const sdkRequested = deferred();
        const sdkDelivered = deferred();
        await context.route('**/*', async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.href === `${origin}/` && request.isNavigationRequest()) {
                return route.fulfill({
                    contentType: 'text/html',
                    body: '<!doctype html><html><head><title>Local SDK fixture</title></head><body><main>Local fixture only</main></body></html>'
                });
            }
            if (url.href === `${origin}/backend-api/sentinel/sdk.js`) {
                sdkRequested.resolve();
                await sdkGate;
                await route.fulfill({ contentType: 'application/javascript', body: sdkBody });
                sdkDelivered.resolve();
                return;
            }
            if (url.href === `${origin}/backend-api/payments/checkout`) {
                checkoutRequests.push({
                    method: request.method(), body: request.postDataJSON(),
                    headers: request.headers(), frame: request.frame()
                });
                return route.fulfill({
                    contentType: 'application/json',
                    body: JSON.stringify({ checkout_session_id: 'cs_test_local_lifecycle' })
                });
            }
            unexpected.push(url.href);
            return route.abort('blockedbyclient');
        });
        await page.goto(`${origin}/`);
        await page.evaluate(() => {
            window.fixtureDocument = 'original-document';
            window.sdkCalls = [];
        });
        return { page, checkoutRequests, unexpected, sdkRequested, sdkDelivered };
    }

    async function expectSamePage(run) {
        expect(context.pages()).toEqual([run.page]);
        expect(run.page.url()).toBe(`${origin}/`);
        expect(await run.page.evaluate(() => window.fixtureDocument)).toBe('original-document');
        expect(run.unexpected).toEqual([]);
    }

    it.each(['pending init', 'in-place token'])('follows a delayed %s handoff and fetches Checkout once on the same page', async mode => {
        const run = await fixture();
        await run.page.evaluate(mode => {
            const readyToken = flow => {
                window.sdkCalls.push(`ready-token:${flow}`);
                return 'local-ready-proof';
            };
            if (mode === 'pending init') {
                window.SentinelSDK = {
                    init(flow) {
                        window.sdkCalls.push(`loader-init:${flow}`);
                        setTimeout(() => {
                            window.SentinelSDK = {
                                init(flow) { window.sdkCalls.push(`ready-init:${flow}`); },
                                token: readyToken
                            };
                        }, 70);
                        return new Promise(() => {});
                    },
                    token() { window.sdkCalls.push('unexpected-loader-token'); }
                };
            } else {
                window.SentinelSDK = {
                    token(flow) {
                        window.sdkCalls.push(`pending-token:${flow}`);
                        setTimeout(() => { window.SentinelSDK.token = readyToken; }, 70);
                        return new Promise(resolve => { window.finishOldToken = resolve; });
                    }
                };
            }
        }, mode);

        const result = await requestBrowserCheckout(run.page, checkoutInput);
        expect(result.status).toBe(200);
        expect(result.diagnostics.sentinelTimings.handoffs).toBe(1);
        expect(run.checkoutRequests).toHaveLength(1);
        expect(run.checkoutRequests[0]).toMatchObject({
            method: 'POST', body: checkoutInput.payload,
            headers: { 'openai-sentinel-token': 'local-ready-proof' }
        });
        expect(run.checkoutRequests[0].frame).toBe(run.page.mainFrame());
        expect(await run.page.evaluate(() => window.sdkCalls)).toEqual(mode === 'pending init'
            ? ['loader-init:chatgpt_checkout', 'ready-init:chatgpt_checkout', 'ready-token:chatgpt_checkout']
            : ['pending-token:chatgpt_checkout', 'ready-token:chatgpt_checkout']);

        // An obsolete implementation settling after success cannot initiate a
        // second token flow or a second Checkout request.
        await run.page.evaluate(() => window.finishOldToken?.('obsolete-local-proof'));
        await run.page.waitForTimeout(100);
        expect(run.checkoutRequests).toHaveLength(1);
        await expectSamePage(run);
    });

    it('does not resume token or Checkout after a timed-out script arrives late', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_INIT_TIMEOUT_MS', '100');
        const gate = deferred();
        const run = await fixture({
            sdkGate: gate.promise,
            sdkBody: `
                window.lateSdkLoaded = true;
                window.SentinelSDK = {
                    init() { window.sdkCalls.push('late-init'); },
                    token() { window.sdkCalls.push('late-token'); return 'late-local-proof'; }
                };
            `
        });
        const pending = requestBrowserCheckout(run.page, checkoutInput).catch(error => error);
        await run.sdkRequested.promise;
        const error = await pending;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/Sentinel.*超时.*stage=load/);
        expect(await run.page.locator('script[src="/backend-api/sentinel/sdk.js"]').count()).toBe(0);

        gate.resolve();
        await run.sdkDelivered.promise;
        // Removing an injected script does not guarantee cancellation of its
        // network response. Even if its code executes late, the caller is stopped.
        await run.page.waitForFunction(() => window.lateSdkLoaded === true, undefined, { timeout: 1000 });
        await run.page.waitForTimeout(100);
        expect(await run.page.evaluate(() => window.sdkCalls)).toEqual([]);
        expect(run.checkoutRequests).toHaveLength(0);
        await expectSamePage(run);
    });

    it('does not fetch Checkout when a token settles after its deadline', async () => {
        vi.stubEnv('CHECKOUT_SENTINEL_TIMEOUT_MS', '100');
        const run = await fixture();
        await run.page.evaluate(() => {
            window.SentinelSDK = {
                token(flow) {
                    window.sdkCalls.push(`token:${flow}`);
                    return new Promise(resolve => { window.finishLateToken = resolve; });
                }
            };
        });
        await expect(requestBrowserCheckout(run.page, checkoutInput)).rejects.toThrow(/Sentinel.*超时.*stage=token/);
        await run.page.evaluate(() => window.finishLateToken('late-local-proof'));
        await run.page.waitForTimeout(100);
        expect(await run.page.evaluate(() => window.sdkCalls)).toEqual(['token:chatgpt_checkout']);
        expect(run.checkoutRequests).toHaveLength(0);
        await expectSamePage(run);
    });
});
