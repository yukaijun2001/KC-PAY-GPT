'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRuntime() {
    const standalone = vi.fn(async (options) => ({ mode: 'standalone', ...options }));
    const pool = vi.fn(async (options) => ({ mode: 'pool', ...options }));
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/browser/browser-runtime.js'), 'utf8'), {
        module, process, console,
        require: (name) => ({
            './browser-standalone': { connectStandaloneBrowser: standalone },
            './browser-pool-client': { connectPoolBrowser: pool }
        }[name] || require(name))
    });
    return { ...module.exports, standalone, pool };
}

describe('headed Checkout browser runtime', () => {
    const env = {
        BROWSER_RUNTIME_MODE: 'pool', BROWSER_POOL: '1',
        BROWSER_POOL_CDP_URL: 'http://127.0.0.1:19222', BROWSER_POOL_SLOT: '0',
        CDP_PORT: '19222'
    };

    it('does not treat a headless pool connection as a headed browser', async () => {
        const runtime = loadRuntime();
        await runtime.connectTaskBrowser({ headful: true, env, proxyConfig: { server: 'http://proxy.test' } });
        expect(runtime.pool).not.toHaveBeenCalled();
        expect(runtime.standalone).toHaveBeenCalledWith(expect.objectContaining({
            headful: true, proxyConfig: { server: 'http://proxy.test' }
        }));
        const port = runtime.standalone.mock.calls[0][0].cdpPort;
        expect(Number(port)).toBeGreaterThan(0);
        expect(String(port)).not.toBe(env.CDP_PORT);
    });

    it('preserves pool mode for ordinary API attempts', async () => {
        const runtime = loadRuntime();
        await runtime.connectTaskBrowser({ headful: false, env });
        expect(runtime.standalone).not.toHaveBeenCalled();
        expect(runtime.pool).toHaveBeenCalledOnce();
    });

    it('closes only an owned browser, never the shared pool', async () => {
        const runtime = loadRuntime();
        const browser = { close: vi.fn(async () => {}) };
        await runtime.closeTaskBrowser({ ownsBrowser: false }, browser);
        expect(browser.close).not.toHaveBeenCalled();
        await runtime.closeTaskBrowser({ ownsBrowser: true }, browser);
        expect(browser.close).toHaveBeenCalledOnce();
    });
});
