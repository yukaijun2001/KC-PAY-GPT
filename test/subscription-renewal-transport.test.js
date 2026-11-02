'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function subscription(willRenew) {
    return { accounts: { default: {
        account: { account_id: 'synthetic-account' },
        entitlement: { has_active_subscription: true, subscription_plan: 'plus' },
        last_active_subscription: { will_renew: willRenew, purchase_origin_platform: 'chatgpt_web' }
    } } };
}

function response(status, body) {
    return { status: () => status, json: async () => body };
}

function fixture() {
    const get = vi.fn().mockResolvedValueOnce(response(200, subscription(true)))
        .mockResolvedValueOnce(response(200, subscription(false)));
    const post = vi.fn(async () => response(200, {}));
    const contexts = [];
    const newContext = vi.fn(async (options) => {
        const context = { options, get, fetch: post, dispose: vi.fn(async () => {}) };
        contexts.push(context);
        return context;
    });
    const axios = vi.fn(async () => ({ status: 200, data: {} }));
    axios.get = vi.fn().mockResolvedValueOnce({ status: 200, data: subscription(true) })
        .mockResolvedValueOnce({ status: 200, data: subscription(false) });
    const cleanup = vi.fn(async () => {});
    const preparePlaywrightProxy = vi.fn(async (value) => ({
        proxyConfig: value ? { server: value } : null, cleanup
    }));
    const agents = [];
    class ProxyAgent {
        constructor(options) { this.options = options; this.destroy = vi.fn(); agents.push(this); }
    }
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/checkout/subscription-check.js'), 'utf8'), {
        module, Buffer, console,
        process: { env: { PROXY: 'http://environment-proxy.invalid:8080' } },
        require: (name) => {
            if (name === 'axios') return axios;
            if (name === 'proxy-agent') return { ProxyAgent };
            if (name === 'playwright') return { request: { newContext } };
            if (name === '../browser/session-auth') return { extractProfileFromToken: () => ({ accountId: 'synthetic-account' }) };
            if (name === '../browser/playwright-proxy') return { preparePlaywrightProxy };
            throw new Error(`Unexpected import: ${name}`);
        }
    });
    return { ...module.exports, get, post, newContext, contexts, axios, preparePlaywrightProxy, agents, cleanup };
}

describe('subscription cancellation and confirmation transport', () => {
    const proxy = 'http://task-proxy.invalid:8080';

    it('checks, cancels and verifies through the same task proxy', async () => {
        const run = fixture();
        const result = await run.cancelAutoRenew('synthetic', { proxy });
        expect(result).toMatchObject({ ok: true, data: { cancelled: true, autoRenewRaw: false, hasActiveSubscription: true } });
        expect(run.get).toHaveBeenCalledTimes(2);
        expect(run.post).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/backend-api/subscriptions/cancel', expect.objectContaining({
            method: 'POST', data: { account_id: 'synthetic-account' }
        }));
        expect(run.contexts).toHaveLength(3);
        for (const context of run.contexts) {
            expect(context.options.proxy.server).toBe(proxy);
            expect(context.dispose).toHaveBeenCalledOnce();
        }
        expect(run.cleanup).toHaveBeenCalledTimes(3);
        expect(run.axios).not.toHaveBeenCalled();
    });

    it('does not bypass the task proxy when falling back from Playwright to Axios', async () => {
        const run = fixture();
        run.get.mockReset().mockResolvedValue(response(503, {}));
        run.post.mockResolvedValue(response(503, {}));
        const result = await run.cancelAutoRenew('synthetic', { proxy });
        expect(result.data.autoRenewRaw).toBe(false);
        expect(run.axios).toHaveBeenCalledOnce();
        expect(run.axios.get).toHaveBeenCalledTimes(2);
        expect(run.agents).toHaveLength(3);
        for (const agent of run.agents) {
            expect(agent.options.getProxyForUrl()).toBe(proxy);
            expect(agent.destroy).toHaveBeenCalledOnce();
        }
        for (const [options] of run.axios.mock.calls) expect(options).toMatchObject({ proxy: false, httpAgent: expect.anything(), httpsAgent: expect.anything() });
        for (const [, options] of run.axios.get.mock.calls) expect(options).toMatchObject({ proxy: false, httpAgent: expect.anything(), httpsAgent: expect.anything() });
    });

    it('honors explicitly direct task traffic instead of picking the global proxy', async () => {
        const run = fixture();
        run.get.mockReset().mockResolvedValue(response(503, {}));
        run.post.mockResolvedValue(response(503, {}));
        await run.cancelAutoRenew('synthetic', { proxy: '' });
        expect(run.agents).toHaveLength(0);
        for (const context of run.contexts) expect(context.options.proxy).toBeUndefined();
        expect(run.axios.mock.lastCall[0].proxy).toBe(false);
        for (const [, options] of run.axios.get.mock.calls) expect(options.proxy).toBe(false);
    });

    it('cleans up a proxy relay even if creating an HTTP context fails', async () => {
        const run = fixture();
        run.newContext.mockRejectedValue(new Error('context initialization failed'));
        const result = await run.cancelAutoRenew('synthetic', { proxy });
        expect(result.data.autoRenewRaw).toBe(false);
        expect(run.cleanup).toHaveBeenCalledTimes(3);
        for (const agent of run.agents) expect(agent.destroy).toHaveBeenCalledOnce();
    });

    it('does not issue another cancel for an already non-renewing active subscription', async () => {
        const run = fixture();
        run.get.mockReset().mockResolvedValue(response(200, subscription(false)));
        expect(await run.cancelAutoRenew('synthetic', { proxy })).toMatchObject({ ok: true, data: { alreadyCancelled: true, autoRenewRaw: false } });
        expect(run.post).not.toHaveBeenCalled();
    });
});
