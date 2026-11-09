'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { chromium } = require('playwright');
const adminAuth = require('../src/admin/admin-auth');
const subscription = require('../src/checkout/subscription-check');

const root = path.join(__dirname, '..');
const SESSION_ERROR = 'Session 无效或已过期，请重新获取 Session';
const operations = [
    ['cancel', '/api/admin/subscription/cancel-auto-renew', '#cancel_renewal_btn'],
    ['enable', '/api/admin/subscription/enable-auto-renew', '#enable_renewal_btn']
];
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const sessionToken = [encode({ typ: 'JWT', alg: 'RS256' }), encode({
    iss: 'https://auth.openai.com', exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'local-fixture-account' }
}), 'synthetic-signature'].join('.');
const rawSession = JSON.stringify({ accessToken: sessionToken, user: { email: 'fixture@example.invalid' } });
const renewalData = {
    email: 'fixture@example.invalid', plan: 'ChatGPT Plus', subscriptionChannel: 'Web',
    autoRenew: '否', autoRenewRaw: false, hasActiveSubscription: true, cancelled: true,
    message: '已成功关闭自动续费，当前周期仍可继续使用'
};

let listener;
let base;
let adminToken;
let services;
let store;

beforeAll(async () => {
    const filename = path.join(root, 'server.js');
    const realRequire = createRequire(filename);
    store = {
        ensureReady: vi.fn(async () => {}),
        getAdminPaths: vi.fn(async () => ({ loginPath: 'admin-login', panelPath: 'admin' })),
        getAdminAuthConfig: vi.fn(async () => ({ passwordVersion: 1 }))
    };
    services = { cancel: vi.fn(), enable: vi.fn() };
    const module = { exports: {} };
    const context = vm.createContext({
        module, exports: module.exports, __dirname: root, __filename: filename,
        require: name => {
            if (name === './src/persistence/mysql-store') return store;
            if (name === './src/checkout/subscription-check') return {
                ...subscription, cancelAutoRenew: services.cancel, resumeAutoRenew: services.enable
            };
            return realRequire(name);
        },
        process: { env: { ...process.env, IS_PRODUCT_FLOW: 'true' }, on: vi.fn(), pid: process.pid,
            platform: process.platform, cwd: () => root, exit: vi.fn() },
        console: { log() {}, warn() {}, error() {} },
        Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = app;', context, { filename });
    listener = await new Promise(resolve => {
        const server = module.exports.listen(0, '127.0.0.1', () => resolve(server));
    });
    base = `http://127.0.0.1:${listener.address().port}`;
    adminToken = adminAuth.issueAdminToken(1).token;
});

afterAll(async () => {
    if (listener) await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
    store.getAdminAuthConfig.mockResolvedValue({ passwordVersion: 1 });
    for (const service of Object.values(services)) {
        service.mockReset().mockResolvedValue({ ok: false, statusCode: 401, error: SESSION_ERROR });
    }
});

function request(endpoint, { token = adminToken, session = rawSession } = {}) {
    return fetch(base + endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ session, timezone_offset_min: 480 })
    });
}

describe.each(operations)('%s renewal API authentication boundary', (operation, endpoint) => {
    it('reports a rejected ChatGPT Session without returning an admin-login HTTP 401', async () => {
        const res = await request(endpoint);
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({
            success: false, code: 'CHATGPT_SESSION_EXPIRED', upstreamStatus: 401, message: SESSION_ERROR
        });
        expect(services[operation]).toHaveBeenCalledExactlyOnceWith(sessionToken, expect.objectContaining({ timezoneOffsetMin: 480 }));
        const adminSession = await fetch(base + '/api/admin/session', { headers: { Authorization: `Bearer ${adminToken}` } });
        expect(adminSession.status).toBe(200);
    });

    it.each(['', 'invalid-admin-token'])('keeps rejecting missing/invalid administrator credentials (%s)', async token => {
        const res = await request(endpoint, { token });
        expect(res.status).toBe(401);
        expect((await res.json()).message).toContain('重新登录');
        expect(services[operation]).not.toHaveBeenCalled();
    });

    it('keeps rejecting a revoked administrator token before contacting the renewal service', async () => {
        store.getAdminAuthConfig.mockResolvedValue({ passwordVersion: 2 });
        const res = await request(endpoint);
        expect(res.status).toBe(401);
        expect(services[operation]).not.toHaveBeenCalled();
    });

    it.each(['', 'not-a-session'])('keeps input validation separate from administrator authentication (%s)', async session => {
        const res = await request(endpoint, { session });
        expect(res.status).toBe(400);
        expect(services[operation]).not.toHaveBeenCalled();
    });

    it.each([400, 403, 429, 502])('preserves non-auth service errors with HTTP %s', async statusCode => {
        services[operation].mockResolvedValue({ ok: false, statusCode, error: '本地订阅操作失败' });
        const res = await request(endpoint);
        expect(res.status).toBe(statusCode);
        expect(await res.json()).toMatchObject({ success: false, message: '本地订阅操作失败' });
    });

    it('preserves successful renewal responses', async () => {
        services[operation].mockResolvedValue({ ok: true, data: renewalData });
        const res = await request(endpoint);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: renewalData });
    });
});

describe.skipIf(!fs.existsSync(chromium.executablePath()))('renewal admin login regression in Chromium', () => {
    let browser;
    let context;
    let page;
    let state;

    beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() }); });
    afterAll(async () => { if (browser) await browser.close(); });
    afterEach(async () => { if (context) await context.close(); });

    async function openRenewalPage() {
        context = await browser.newContext();
        page = await context.newPage();
        state = { renewalRequests: [], loginRequests: 0, external: [], errors: [] };
        page.on('pageerror', error => state.errors.push(error.message));
        page.on('dialog', dialog => dialog.accept());
        // Keep the real admin HTML, auth middleware, session and renewal routes.
        // All other calls are local fixtures; no real account or renewal action.
        await page.route('**/*', async route => {
            const req = route.request();
            const url = new URL(req.url());
            if (url.hostname === 'unpkg.com') return route.fulfill({ contentType: 'text/javascript', body: 'window.lucide={createIcons(){}};' });
            if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
            if (url.origin !== base) { state.external.push(url.hostname); return route.abort(); }
            if (url.pathname === '/admin-login') {
                state.loginRequests++;
                return route.fulfill({ contentType: 'text/html', body: '<h1>本地管理员登录</h1>' });
            }
            if (operations.some(([, endpoint]) => endpoint === url.pathname)) {
                state.renewalRequests.push({ path: url.pathname, body: req.postDataJSON(), auth: req.headers().authorization });
                return route.continue();
            }
            if (['/admin', '/admin-ui.css', '/admin-ui.js', '/favicon.png', '/images/gpt-logo.png', '/api/public/admin-paths', '/api/admin/session'].includes(url.pathname)) {
                return route.continue();
            }
            let json = { success: true };
            if (url.pathname === '/api/admin/data') json = { stats: { total: 128 }, config: { card_pool: [] }, logs: [] };
            if (url.pathname === '/api/admin/region') json = { success: true, region: 'PH', label: '菲律宾', currency: 'PHP' };
            if (url.pathname === '/api/admin/sessions') json = [];
            return route.fulfill({ json });
        });
        // Seed localStorage once: do not restore a cleared token on navigation.
        await page.goto(base + '/admin-login');
        await page.evaluate(token => localStorage.setItem('plus_admin_token', token), adminToken);
        state.loginRequests = 0;
        await page.goto(base + '/admin');
        await page.waitForFunction(() => document.getElementById('stat_total')?.textContent === '128');
        await page.evaluate(() => switchPage('cancel_renewal'));
        await page.locator('#cancel_renewal_session').fill(rawSession);
    }

    it.each(operations)('keeps the %s page, administrator token and input when ChatGPT rejects the Session', async (operation, endpoint, button) => {
        await openRenewalPage();
        const response = page.waitForResponse(res => new URL(res.url()).pathname === endpoint);
        await page.locator(button).click();
        await response;
        await page.waitForFunction(() => location.pathname === '/admin-login'
            || document.getElementById('message_container')?.textContent.includes('Session 无效'), undefined, { timeout: 5000 });
        expect(page.url()).toBe(base + '/admin');
        expect(state.loginRequests).toBe(0);
        expect(await page.evaluate(() => localStorage.getItem('plus_admin_token'))).toBe(adminToken);
        expect(await page.locator('#cancel_renewal_session').inputValue()).toBe(rawSession);
        expect(await page.locator('#message_container').innerText()).toContain(SESSION_ERROR);
        expect(await page.locator(button).isEnabled()).toBe(true);
        expect(await page.locator('#cancel_renewal_result').isHidden()).toBe(true);
        expect(state.renewalRequests).toEqual([{ path: endpoint, body: { session: rawSession, timezone_offset_min: expect.any(Number) }, auth: `Bearer ${adminToken}` }]);
        expect(services[operation]).toHaveBeenCalledOnce();
        expect(state.errors).toEqual([]);
        expect(state.external).toEqual([]);

        // A fresh Session can be retried immediately without another admin login.
        const replacementSession = rawSession.replace('synthetic-signature', 'replacement-signature');
        const successData = operation === 'cancel' ? renewalData : {
            ...renewalData, cancelled: false, resumed: true, autoRenewRaw: true, autoRenew: '是',
            message: '已成功开启自动续费'
        };
        services[operation].mockResolvedValue({ ok: true, data: successData });
        await page.locator('#cancel_renewal_session').fill(replacementSession);
        const retryResponse = page.waitForResponse(res => new URL(res.url()).pathname === endpoint);
        await page.locator(button).click();
        expect((await retryResponse).status()).toBe(200);
        await page.locator('#cancel_renewal_result').waitFor({ state: 'visible' });
        expect(await page.locator('#cancel_renewal_status').textContent()).toBe(successData.message);
        expect(await page.evaluate(() => localStorage.getItem('plus_admin_token'))).toBe(adminToken);
        expect(state.loginRequests).toBe(0);
        expect(services[operation]).toHaveBeenCalledTimes(2);
        expect(state.renewalRequests[1].body.session).toBe(replacementSession);
        expect(state.errors).toEqual([]);
    });

    it.each(operations)('keeps the %s page when Session input is empty', async (operation, endpoint, button) => {
        await openRenewalPage();
        await page.locator('#cancel_renewal_session').fill('');
        await page.locator(button).click();
        await page.waitForFunction(() => document.getElementById('message_container')?.textContent.includes('请先粘贴'));
        expect(page.url()).toBe(base + '/admin');
        expect(await page.evaluate(() => localStorage.getItem('plus_admin_token'))).toBe(adminToken);
        expect(state.renewalRequests).toEqual([]);
        expect(services[operation]).not.toHaveBeenCalled();
        expect(state.loginRequests).toBe(0);
    });

    it('still redirects and clears the administrator token when it is revoked', async () => {
        await openRenewalPage();
        store.getAdminAuthConfig.mockResolvedValue({ passwordVersion: 2 });
        await page.locator('#cancel_renewal_btn').click();
        await page.waitForURL(base + '/admin-login');
        expect(await page.evaluate(() => localStorage.getItem('plus_admin_token'))).toBeNull();
        expect(services.cancel).not.toHaveBeenCalled();
    });
});
