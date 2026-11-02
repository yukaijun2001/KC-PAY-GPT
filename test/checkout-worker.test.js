'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const unusualActivity = 'API 创建 Checkout 失败: Our systems have detected unusual activity. Please try again later.';
const checkoutUrl = 'https://chatgpt.com/checkout/openai_llc/cs_test_debug';

// Run the actual worker without starting MySQL, a browser, or a payment.
async function runDebugWorker({ mode = 'auto', apiError, uiError, launchError, installError, fallbackLaunchError, env = {} } = {}) {
    const output = [];
    const page = {
        on: vi.fn(),
        isClosed: () => false,
        url: () => checkoutUrl,
        screenshot: vi.fn(),
        video: () => null
    };
    const context = {
        addInitScript: vi.fn(),
        newPage: vi.fn(async () => page),
        close: vi.fn(),
        storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
        addCookies: vi.fn(),
        pages: () => [page]
    };
    const browser = { newContext: vi.fn(async () => context), close: vi.fn() };
    const openApiCheckout = apiError
        ? vi.fn().mockRejectedValue(new Error(apiError))
        : vi.fn().mockResolvedValue({ checkoutUrl });
    const openPricingCheckout = uiError
        ? vi.fn().mockRejectedValue(new Error(uiError))
        : vi.fn().mockResolvedValue(checkoutUrl);
    const executePaymentWithRetry = vi.fn();
    const connectTaskBrowser = vi.fn(async (options) => {
        if (launchError) throw new Error(launchError);
        if (options.forceStandalone && fallbackLaunchError) throw new Error(fallbackLaunchError);
        return {
            mode: options.forceStandalone ? 'standalone' : 'pool',
            browser,
            ownsBrowser: Boolean(options.forceStandalone),
            headful: Boolean(options.headful && options.forceStandalone),
            realUserAgent: 'Mozilla/5.0 Chrome/147.0.0.0'
        };
    });
    const closeTaskBrowser = vi.fn();
    const proxyCleanup = vi.fn();
    const installChatGptSession = vi.fn(async () => {
        if (installError) throw new Error(installError);
        return { sessionData: {}, cookieVerified: true };
    });
    const bootstrapChatGptSession = vi.fn(async () => ({ session: { accessToken: 'test-token' } }));
    const modules = {
        './src/payments/payment-retry': { executePaymentWithRetry },
        './src/checkout/pricing-checkout': { openPricingCheckout },
        './src/checkout/chatgpt': { openApiCheckout },
        './src/persistence/mysql-store': { getPaymentRegion: async () => 'PH', resolvePlanName: () => 'chatgptplusplan' },
        './src/config/region-config': require('../src/config/region-config'),
        './src/browser/session-auth': { installChatGptSession, bootstrapChatGptSession },
        './src/browser/browser-runtime': { connectTaskBrowser, applyCdpEnv: vi.fn(), closeTaskBrowser },
        './src/browser/playwright-proxy': { preparePlaywrightProxy: async () => ({ proxyConfig: null, cleanup: proxyCleanup }) },
        fs: { mkdirSync: vi.fn() },
        path
    };
    const workerProcess = {
        env: {
            CHECKOUT_DEBUG_ONLY: '1',
            CHECKOUT_MODE: mode,
            CHATGPT_TOKEN: 'test-token',
            RECORD_VIDEO: '0',
            ...env
        },
        exit: vi.fn()
    };
    const log = (...args) => output.push(args.join(' '));
    await vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), {
        require: (name) => modules[name] || require(path.join(__dirname, '..', name)),
        __dirname: path.join(__dirname, '..'),
        console: { log, warn: log, error: log },
        process: workerProcess,
        setTimeout: () => ({ unref() {} }),
        URL
    }, { filename: 'index.js' });
    return {
        output: output.join('\n'), workerProcess, page, context, browser,
        openApiCheckout, openPricingCheckout, executePaymentWithRetry,
        connectTaskBrowser, closeTaskBrowser, proxyCleanup,
        installChatGptSession, bootstrapChatGptSession
    };
}

describe('checkout debug worker', () => {
    it('falls back to a headed UI after the reported API error, without making a payment', async () => {
        const run = await runDebugWorker({ apiError: unusualActivity });
        expect(run.output).toContain(unusualActivity);
        expect(run.openPricingCheckout).toHaveBeenCalledOnce();
        expect(run.connectTaskBrowser).toHaveBeenLastCalledWith(expect.objectContaining({
            headful: true,
            forceStandalone: true
        }));
        expect(run.output).toContain(`CHECKOUT_URL: ${checkoutUrl}`);
        expect(run.output).toContain('CHECKOUT_DEBUG_SUCCESS');
        expect(run.executePaymentWithRetry).not.toHaveBeenCalled();
        expect(run.workerProcess.exitCode || 0).toBe(0);
        expect(run.proxyCleanup).toHaveBeenCalledOnce();
        expect(run.context.storageState).toHaveBeenCalledOnce();
        expect(run.browser.newContext).toHaveBeenLastCalledWith(expect.objectContaining({
            storageState: { cookies: [], origins: [] }
        }));
        expect(run.installChatGptSession).toHaveBeenCalledTimes(2);
        expect(run.bootstrapChatGptSession).toHaveBeenCalledTimes(2);
    });

    it('keeps API success on the existing browser and stops before payment', async () => {
        const run = await runDebugWorker();
        expect(run.openApiCheckout).toHaveBeenCalledWith(run.page, expect.objectContaining({ verifyPage: false }));
        expect(run.connectTaskBrowser).toHaveBeenCalledOnce();
        expect(run.openPricingCheckout).not.toHaveBeenCalled();
        expect(run.executePaymentWithRetry).not.toHaveBeenCalled();
        expect(run.output).toContain('CHECKOUT_DEBUG_SUCCESS');
    });

    it('does not fall back when API-only mode is explicitly requested', async () => {
        const run = await runDebugWorker({ mode: 'api', apiError: unusualActivity });
        expect(run.openPricingCheckout).not.toHaveBeenCalled();
        expect(run.output).not.toContain('CHECKOUT_DEBUG_SUCCESS');
        expect(run.workerProcess.exitCode).toBe(1);
    });

    it('allows UI-only debug mode, without calling the API or making a payment', async () => {
        const run = await runDebugWorker({ mode: 'ui' });
        expect(run.openApiCheckout).not.toHaveBeenCalled();
        expect(run.openPricingCheckout).toHaveBeenCalledOnce();
        expect(run.output).toContain('CHECKOUT_DEBUG_SUCCESS');
        expect(run.executePaymentWithRetry).not.toHaveBeenCalled();
    });

    it('reports a failed UI fallback without claiming success', async () => {
        const run = await runDebugWorker({ apiError: unusualActivity, uiError: 'UI checkout timed out' });
        expect(run.openPricingCheckout).toHaveBeenCalledOnce();
        expect(run.output).toContain('UI checkout timed out');
        expect(run.output).not.toContain('CHECKOUT_DEBUG_SUCCESS');
        expect(run.workerProcess.exitCode).toBe(1);
        expect(run.executePaymentWithRetry).not.toHaveBeenCalled();
    });

    it('supports an explicit non-headed UI deployment without relaunching the browser', async () => {
        const run = await runDebugWorker({ apiError: unusualActivity, env: { CHECKOUT_UI_HEADFUL: '0' } });
        expect(run.connectTaskBrowser).toHaveBeenCalledOnce();
        expect(run.openPricingCheckout).toHaveBeenCalledOnce();
        expect(run.output).toContain('CHECKOUT_DEBUG_SUCCESS');
        expect(run.context.close).toHaveBeenCalledOnce();
    });

    it('cleans up after a failed headed launch and never reports success', async () => {
        const run = await runDebugWorker({ apiError: unusualActivity, fallbackLaunchError: '有头 UI 需要 DISPLAY' });
        expect(run.output).toContain('有头 UI 需要 DISPLAY');
        expect(run.output).not.toContain('CHECKOUT_DEBUG_SUCCESS');
        expect(run.proxyCleanup).toHaveBeenCalledOnce();
        expect(run.context.close).toHaveBeenCalledOnce();
        expect(run.workerProcess.exitCode).toBe(1);
    });

    it('cleans up the proxy if the initial browser launch fails', async () => {
        const run = await runDebugWorker({ launchError: 'browser launch failed' });
        expect(run.output).toContain('browser launch failed');
        expect(run.workerProcess.exitCode).toBe(1);
        expect(run.proxyCleanup).toHaveBeenCalledOnce();
    });

    it('closes the context if initial Session setup fails', async () => {
        const run = await runDebugWorker({ installError: 'invalid session' });
        expect(run.workerProcess.exitCode).toBe(1);
        expect(run.context.close).toHaveBeenCalledOnce();
        expect(run.proxyCleanup).toHaveBeenCalledOnce();
    });
});
