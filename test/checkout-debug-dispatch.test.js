'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function checkoutDispatch(env) {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('async function spawnWorkerWithBrowser(');
    const end = source.indexOf('\n/**', source.indexOf('function spawnCheckoutDebugWorker(', start));
    const withBrowserSlot = vi.fn(async (_, run) => run({ slotId: 0, port: 19222, cdpUrl: 'http://127.0.0.1:19222' }));
    const runCheckoutScript = vi.fn(async () => ({ output: 'CHECKOUT_DEBUG_SUCCESS', timedOut: false }));
    const sandbox = {
        process: { env }, __dirname: path.join(__dirname, '..'), path, console,
        browserPool: { getRuntimeEnabled: () => true, withBrowserSlot },
        buildWorkerRuntimeEnv: (base, _, mode) => ({ ...base, BROWSER_RUNTIME_MODE: mode }),
        buildHcaptchaEnvFromConfig: () => ({ env: {} }),
        store: { getActiveProxy: async () => '', getHcaptchaConfig: async () => ({}), updateTaskLog: vi.fn() },
        logTask: vi.fn(), runCheckoutScript,
        analyzeCheckoutDebugOutput: () => ({ status: 'success', checkoutUrl: 'https://chatgpt.com/checkout/test' }),
        extractScreenshotsFromOutput: () => []
    };
    vm.runInNewContext(source.slice(start, end), sandbox);
    return { ...sandbox, withBrowserSlot };
}

describe('admin Checkout debug dispatch', () => {
    const args = { task: { jobKey: 'checkout-test' }, token: 'test-token', sessionRaw: '{}', planType: 'plus', region: 'PH' };

    it('defaults to auto instead of silently forcing API-only mode', async () => {
        const dispatch = checkoutDispatch({});
        await dispatch.spawnCheckoutDebugWorker(args);
        expect(dispatch.runCheckoutScript).toHaveBeenCalledOnce();
        expect(dispatch.runCheckoutScript.mock.calls[0][2]).toMatchObject({
            CHECKOUT_DEBUG_ONLY: '1', CHECKOUT_MODE: 'auto'
        });
    });

    it('preserves explicit API-only mode', async () => {
        const dispatch = checkoutDispatch({ CHECKOUT_MODE: 'api' });
        await dispatch.spawnCheckoutDebugWorker(args);
        expect(dispatch.runCheckoutScript.mock.calls[0][2].CHECKOUT_MODE).toBe('api');
    });

    it('does not reserve a pool slot for an explicit headed deployment', async () => {
        const dispatch = checkoutDispatch({ HEADFUL: '1' });
        await dispatch.spawnCheckoutDebugWorker(args);
        expect(dispatch.withBrowserSlot).not.toHaveBeenCalled();
        expect(dispatch.runCheckoutScript.mock.calls[0][2].BROWSER_RUNTIME_MODE).toBe('standalone');
    });
});
