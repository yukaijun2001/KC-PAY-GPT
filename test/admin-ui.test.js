'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const plans = { go: 'chatgptgoplan', plus: 'chatgptplusplan', pro_10x: 'chatgptprolite', pro_20x: 'chatgptpro', pro_50x: 'chatgptpromax' };
const defaults = { go: 'EG', plus: 'PH', pro_10x: 'PH', pro_20x: 'PH', pro_50x: 'PH' };
const data = {
    stats: { total: 128, success: 116, failed: 12, cdk_total: 256, cdk_used: 116, cdk_unused: 140, billing_revenue: 2320, billing_paid_count: 116 },
    config: { card_pool: [], max_concurrent_activations: 2 },
    runtime: { active_foreground_jobs: 0, system: { cpu: { percent: 12.4, text: '4 核心 · 12.4%' }, memory: { percent: 31.6, text: '2.5 GB / 8 GB' }, disk: { percent: 18.3, usedText: '36.6 GB', totalText: '200 GB' }, uptime: { seconds: 93675 } } }, logs: []
};
const iconStub = `window.lucide={createIcons(){document.querySelectorAll('i[data-lucide]').forEach(i=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('width','18');s.setAttribute('height','18');s.setAttribute('aria-hidden','true');s.innerHTML='<path fill="none" stroke="currentColor" d="M4 4h16v16H4z"/>';s.classList.add(...i.classList);i.replaceWith(s)})}};`;
let browser;
const contexts = [];

async function fixture(options = {}) {
    const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 1000 }, reducedMotion: options.reducedMotion || 'no-preference' });
    contexts.push(context);
    if (options.authenticated !== false) await context.addInitScript(() => localStorage.setItem('plus_admin_token', 'local-ui-fixture'));
    const page = await context.newPage();
    const state = {
        requests: [], external: [], errors: [], failRegion: false, failRefresh: false,
        captchaConfig: { api_url: 'https://api.captcha-run.com', timeout_sec: 20, api_token_saved: false, token_source: 'none' },
        captchaStoredToken: '', captchaSaveFails: false, captchaTestFails: false,
        proxies: [
            { id: 1, region_code: 'PH', is_active: true, protocol: 'socks5', proxy_url_masked: 'socks5://ph-residential-session-{session}:***@proxy.example.com:1000', last_check_ok: true, last_check_ip: '192.0.2.12', last_check_latency_ms: 307 },
            { id: 2, region_code: 'EG', is_active: true, protocol: 'socks5', proxy_url_masked: 'socks5://eg-residential-session-{session}:***@proxy.example.com:1000', last_check_ok: true, last_check_ip: '198.51.100.24', last_check_latency_ms: 232 },
            { id: 3, region_code: '', is_active: false, protocol: 'http', proxy_url_masked: 'http://backup-session-{session}:***@proxy.example.com:8080', last_check_ok: null }
        ]
    };
    page.on('pageerror', error => state.errors.push(error.message));
    // Every request, including CDN assets and polling, is intercepted locally. No live sessions or payment calls.
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.hostname === 'unpkg.com') return route.fulfill({ contentType: 'text/javascript', body: iconStub });
        if (url.hostname !== 'admin-ui.test') { state.external.push(url.hostname); return route.abort(); }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8') });
        if (url.pathname === '/admin-ui.css' || url.pathname === '/admin-ui.js') return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(root, 'public', url.pathname), 'utf8') });
        if (url.pathname === '/admin-login') return route.fulfill({ contentType: 'text/html', body: '<h1>本地鉴权入口</h1>' });
        if (url.pathname === '/favicon.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
        state.requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON(), auth: request.headers().authorization });
        let response = { success: true };
        if (url.pathname === '/api/admin/data') response = data;
        if (url.pathname === '/api/public/admin-paths') response = { success: true, loginUrl: '/admin-login' };
        if (url.pathname === '/api/admin/region') response = { success: true, region: 'US', label: '美国', currency: 'USD' };
        if (url.pathname === '/api/admin/checkout/plans') {
            if (state.plansGate) await state.plansGate;
            response = { success: true, plans, default_regions: defaults };
        }
        if (url.pathname === '/api/admin/checkout/generate') response = { success: true, jobKey: 'ui-test-job' };
        if (url.pathname === '/api/admin/checkout/status/ui-test-job') response = { success: true, status: 'success', screenshots: [], checkout_url: '' };
        if (url.pathname === '/api/admin/runtime-logs') response = { success: true, entries: [], nextAfter: 0 };
        if (url.pathname === '/api/admin/captcharun') {
            if (request.method() === 'PUT') {
                if (state.captchaSaveFails) return route.fulfill({ status: 500, json: { success: false, message: '保存失败（测试）' } });
                const body = request.postDataJSON();
                if (body.clear_token) state.captchaStoredToken = '';
                else if (body.api_token) state.captchaStoredToken = body.api_token;
                state.captchaConfig = { ...state.captchaConfig, timeout_sec: body.timeout_sec, api_token_saved: Boolean(state.captchaStoredToken), token_source: state.captchaStoredToken ? 'database' : 'none' };
            }
            response = { success: true, config: state.captchaConfig };
        }
        if (url.pathname === '/api/admin/captcharun/test') {
            if (state.captchaTestFails) return route.fulfill({ status: 400, json: { success: false, message: '账户测试失败（测试）' } });
            response = { success: true, message: '账户连接正常', wallet: { balance: '12.123456789', credit: '100', cumulativeRecharge: '20', share: '1' } };
        }
        if (url.pathname === '/api/admin/proxies') {
            if (request.method() === 'POST') {
                const body = request.postDataJSON();
                state.proxies.push({ id: 4, region_code: body.region_code, is_active: true, protocol: 'http', proxy_url_masked: 'http://new-proxy.example.com:8080' });
            }
            if (state.failRefresh && request.method() === 'GET') return route.fulfill({ status: 503, json: { success: false, message: '本地刷新失败' } });
            response = { success: true, proxies: state.proxies };
        }
        if (/^\/api\/admin\/proxies\/\d+$/.test(url.pathname)) {
            if (url.pathname.endsWith('/1') && state.regionGate) await state.regionGate;
            if (state.failRegion) return route.fulfill({ status: 500, json: { success: false, message: '本地保存失败' } });
            const item = state.proxies.find(item => item.id === Number(url.pathname.split('/').pop()));
            Object.assign(item, request.postDataJSON());
        }
        if (url.pathname === '/api/admin/cdks' || url.pathname === '/api/admin/sessions') response = [];
        if (url.pathname === '/api/admin/cards') response = { success: true, cards: [] };
        return route.fulfill({ json: response });
    });
    await page.goto('http://admin-ui.test/');
    if (options.authenticated !== false) await page.waitForFunction(() => document.getElementById('stat_total')?.textContent === '128');
    return { page, state, context };
}

async function navigate(page, id) {
    await page.evaluate(id => switchPage(id), id);
    await page.waitForFunction(id => document.getElementById(id)?.classList.contains('active'), id);
}

// No network installs in tests. UI cases run when Playwright Chromium is present.
describe.skipIf(!fs.existsSync(chromium.executablePath()))('admin workspace — isolated Chromium contract', () => {
    beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() }); });
    afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
    afterAll(async () => { await browser?.close(); });

    it('manages the separate CaptchaRun token and tests unsaved credentials without saving', async () => {
        const { page, state } = await fixture();
        await navigate(page, 'config');
        await page.waitForFunction(() => captcharunAccountLoaded === true);
        expect(await page.locator('#captcharun_token_hint').textContent()).toContain('尚未配置');
        expect(await page.locator('#captcharun_clear_btn').isDisabled()).toBe(true);
        await page.locator('#captcharun_api_token').fill('unsaved-token');
        await page.locator('#captcharun_test_btn').click();
        await page.waitForFunction(() => !document.getElementById('captcharun_wallet').hidden);
        expect(await page.locator('#captcharun_balance').textContent()).toBe('12.123456789');
        expect(await page.locator('#captcharun_status').textContent()).toContain('未保存');
        expect(state.captchaStoredToken).toBe('');
        expect(state.requests.find(r => r.path === '/api/admin/captcharun/test').body.api_token).toBe('unsaved-token');
        await page.locator('#captcharun_timeout').fill('30');
        await page.locator('#captcharun_save_btn').click();
        await page.waitForFunction(() => document.getElementById('captcharun_status').textContent === '账户配置已保存。');
        expect(state.captchaStoredToken).toBe('unsaved-token');
        expect(await page.locator('#captcharun_api_token').inputValue()).toBe('');
        expect(await page.locator('#captcharun_token_hint').textContent()).toContain('留空');
        expect(await page.locator('#captcharun_wallet').isHidden()).toBe(true);
        expect(await page.locator('#captcharun_clear_btn').isEnabled()).toBe(true);
        await page.locator('#captcharun_timeout').fill('31');
        await page.locator('#captcharun_save_btn').click();
        await page.waitForFunction(() => !captcharunAccountBusy && captcharunSavedTimeout === '31');
        expect(state.captchaStoredToken).toBe('unsaved-token');
        expect(state.requests.filter(r => r.path === '/api/admin/captcharun' && r.method === 'PUT').at(-1).body.api_token).toBe('');
        expect(state.errors).toEqual([]);
    });

    it('keeps edits on save failure, hides stale balance on test failure and confirms clear', async () => {
        const { page, state } = await fixture();
        state.captchaStoredToken = 'existing-token';
        state.captchaConfig = { ...state.captchaConfig, api_token_saved: true, token_source: 'database' };
        await navigate(page, 'config');
        await page.waitForFunction(() => captcharunAccountLoaded === true);
        await page.locator('#captcharun_test_btn').click();
        await page.waitForFunction(() => !document.getElementById('captcharun_wallet').hidden);
        state.captchaTestFails = true;
        await page.locator('#captcharun_test_btn').click();
        await page.waitForFunction(() => document.getElementById('captcharun_status').textContent.includes('失败'));
        expect(await page.locator('#captcharun_wallet').isHidden()).toBe(true);
        state.captchaSaveFails = true;
        await page.locator('#captcharun_api_token').fill('edited-token');
        await page.locator('#captcharun_save_btn').click();
        await page.waitForFunction(() => document.getElementById('captcharun_status').textContent.includes('保存失败'));
        expect(await page.locator('#captcharun_api_token').inputValue()).toBe('edited-token');
        expect(state.captchaStoredToken).toBe('existing-token');
        state.captchaSaveFails = false;
        await page.locator('#captcharun_clear_btn').click();
        await page.locator('#admin_confirm_ok').click();
        await page.waitForFunction(() => document.getElementById('captcharun_status').textContent.includes('已清除'));
        expect(state.captchaStoredToken).toBe('');
        expect(await page.locator('#captcharun_api_token').inputValue()).toBe('');
        expect(await page.locator('#captcharun_clear_btn').isDisabled()).toBe(true);
    });

    it('renders country labels, keeps untagged entries, and reserves spaced action buttons', async () => {
        const { page, state } = await fixture();
        await navigate(page, 'proxies');
        await page.locator('#proxy_region_1').waitFor();
        expect(await page.locator('#proxy_region_1').inputValue()).toBe('PH');
        expect(await page.locator('#proxy_region_2').inputValue()).toBe('EG');
        expect(await page.locator('#proxy_region_3').inputValue()).toBe('');
        expect(await page.locator('#proxy_region_1 option').allTextContents()).toEqual(['未标记', '菲律宾 (PH)', '美国 (US)', '新加坡 (SG)', '马来西亚 (MY)', '埃及 (EG)']);
        expect(await page.locator('#proxy_row_1 > td').count()).toBe(8);
        const buttons = page.locator('#proxy_row_1 .proxy-actions button');
        const first = await buttons.nth(0).boundingBox();
        const second = await buttons.nth(1).boundingBox();
        expect(second.x - (first.x + first.width)).toBeGreaterThanOrEqual(10);
        expect(Math.min(first.height, second.height)).toBeGreaterThanOrEqual(38);
        expect(await page.locator('#workspace_page_name').textContent()).toBe('代理池');
        expect(state.requests.find(r => r.path === '/api/admin/proxies').auth).toBe('Bearer local-ui-fixture');
        expect(state.errors).toEqual([]);
    });

    it('saves a country independently, rereads authoritative list, and restores after rejection', async () => {
        const { page, state } = await fixture();
        await navigate(page, 'proxies');
        await page.locator('#proxy_region_1').selectOption('EG');
        await page.waitForFunction(() => {
            const select = document.querySelector('#proxy_region_1');
            return !proxyRegionPending.has(1) && select?.dataset.region === 'EG' && !select.disabled;
        });
        expect(state.requests.find(r => r.method === 'PUT').body).toEqual({ region_code: 'EG' });
        expect(state.requests.filter(r => r.path === '/api/admin/proxies' && r.method === 'GET').length).toBe(2);
        state.failRegion = true;
        await page.locator('#proxy_region_1').selectOption('SG');
        await page.waitForFunction(() => document.querySelector('#proxy_region_state_1')?.textContent.includes('已恢复'));
        expect(await page.locator('#proxy_region_1').inputValue()).toBe('EG');
        expect(await page.locator('#proxy_region_1').isEnabled()).toBe(true);
        expect(await page.evaluate(() => proxyPoolList[0].region_code)).toBe('EG');
        expect(state.proxies[0].region_code).toBe('EG');
        expect(state.errors).toEqual([]);
    });

    it('distinguishes saved-but-refresh-failed from a failed update', async () => {
        const { page, state } = await fixture();
        await navigate(page, 'proxies');
        await page.locator('#proxy_region_1').waitFor();
        state.failRefresh = true;
        await page.locator('#proxy_region_1').selectOption('EG');
        await page.waitForFunction(() => document.querySelector('#proxy_region_state_1')?.textContent === '已保存，刷新失败');
        expect(await page.locator('#proxy_region_1').isEnabled()).toBe(true);
        expect(await page.locator('#proxy_region_1').inputValue()).toBe('EG');
        expect(await page.evaluate(() => proxyPoolList[0].region_code)).toBe('EG');
        expect(state.proxies[0].region_code).toBe('EG');
    });

    it('submits selected country with bulk add and keeps enable mutations separate', async () => {
        const { page, state } = await fixture();
        await navigate(page, 'proxies');
        await page.locator('#proxy_region_1').waitFor();
        await page.locator('#proxy_add_input').fill('http://new-proxy.example.com:8080');
        await page.locator('#proxy_add_region').selectOption('MY');
        await page.locator('button[onclick="saveProxyPool()"]').click();
        await page.locator('#proxy_region_4').waitFor();
        expect(state.requests.find(r => r.path === '/api/admin/proxies' && r.method === 'POST').body).toEqual({ proxies: ['http://new-proxy.example.com:8080'], region_code: 'MY' });
        expect(await page.locator('#proxy_add_input').inputValue()).toBe('');
        const enabled = page.waitForResponse(response => response.url().endsWith('/api/admin/proxies/3') && response.request().method() === 'PUT');
        await page.locator('#proxy_row_3 input').check({ force: true });
        await enabled;
        await page.waitForFunction(() => proxyPoolList.find(item => item.id === 3)?.is_active === true);
        expect(state.requests.find(r => r.path === '/api/admin/proxies/3' && r.method === 'PUT').body).toEqual({ is_active: true });
    });

    it('keeps an in-flight region edit disabled and stable across another row redraw', async () => {
        const { page, state } = await fixture();
        await navigate(page, 'proxies');
        await page.locator('#proxy_region_1').waitFor();
        let release;
        state.regionGate = new Promise(resolve => { release = resolve; });
        await page.locator('#proxy_region_1').selectOption('EG');
        await page.waitForFunction(() => proxyRegionPending.has(1));
        const enabled = page.waitForResponse(response => response.url().endsWith('/api/admin/proxies/3') && response.request().method() === 'PUT');
        await page.locator('#proxy_row_3 input').check({ force: true });
        await enabled;
        await page.waitForFunction(() => proxyPoolList.find(item => item.id === 3)?.is_active === true);
        expect(await page.locator('#proxy_region_1').inputValue()).toBe('EG');
        expect(await page.locator('#proxy_region_1').isDisabled()).toBe(true);
        await page.evaluate(() => setProxyRegion(1, 'SG', document.getElementById('proxy_region_1')));
        expect(state.requests.filter(r => r.path === '/api/admin/proxies/1' && r.method === 'PUT')).toHaveLength(1);
        release();
        await page.waitForFunction(() => !proxyRegionPending.has(1));
        expect(await page.locator('#proxy_region_1').inputValue()).toBe('EG');
        expect(state.proxies[0].region_code).toBe('EG');
    });

    it('uses plan-specific defaults, honors manual country and does not mutate global settings', async () => {
        const { page, state } = await fixture();
        await navigate(page, 'checkout_debug');
        await page.waitForFunction(() => document.querySelector('#checkout_plan_type option')?.textContent.includes('chatgptgoplan'));
        await page.locator('#checkout_plan_type').selectOption('go');
        expect(await page.locator('#checkout_region_selector').inputValue()).toBe('EG');
        for (const plan of ['plus', 'pro_10x', 'pro_20x', 'pro_50x']) {
            await page.locator('#checkout_plan_type').selectOption(plan);
            expect(await page.locator('#checkout_region_selector').inputValue()).toBe('PH');
            expect(await page.locator('#checkout_plan_name').inputValue()).toBe(plans[plan]);
        }
        await page.locator('#checkout_plan_type').selectOption('go');
        await page.locator('#checkout_region_selector').selectOption('SG');
        await page.locator('#checkout_session_input').fill('{"local_fixture":true}');
        await page.locator('#checkout_plan_name').fill('manual-plan-override');
        await page.locator('#checkout_generate_btn').click();
        await page.waitForFunction(() => document.querySelector('#checkout_job_hint').textContent.includes('ui-test-job'));
        const generate = state.requests.find(r => r.path === '/api/admin/checkout/generate');
        expect(generate.body).toEqual({ session: '{"local_fixture":true}', plan_type: 'go', plan_name: 'manual-plan-override', country: 'SG' });
        expect(await page.evaluate(() => currentRegion)).toBe('US');
        expect(state.requests.filter(r => r.path === '/api/admin/region' && r.method !== 'GET')).toEqual([]);
        await navigate(page, 'dashboard');
        await navigate(page, 'checkout_debug');
        expect(await page.locator('#checkout_region_selector').inputValue()).toBe('SG');
        expect(state.errors).toEqual([]);
    });

    it('preserves early manual country edits while plan defaults are loading', async () => {
        const { page, state } = await fixture();
        let release;
        state.plansGate = new Promise(resolve => { release = resolve; });
        await navigate(page, 'checkout_debug');
        await page.locator('#checkout_plan_type').selectOption('go');
        await page.locator('#checkout_region_selector').selectOption('SG');
        const loaded = page.waitForResponse(response => response.url().endsWith('/api/admin/checkout/plans'));
        release();
        await loaded;
        await page.waitForFunction(() => checkoutDebugInitialized === true);
        expect(await page.locator('#checkout_plan_type').inputValue()).toBe('go');
        expect(await page.locator('#checkout_region_selector').inputValue()).toBe('SG');
        expect(await page.evaluate(() => currentRegion)).toBe('US');
    });

    it('keeps all existing page navigation reachable and does not animate polling table rows', async () => {
        const { page, state } = await fixture();
        const pages = await page.locator('.page-view').evaluateAll(elements => elements.map(el => el.id));
        for (const id of pages) {
            await navigate(page, id);
            expect(await page.locator('.page-view.active').count()).toBe(1);
            expect((await page.locator('#workspace_page_name').textContent()).length).toBeGreaterThan(0);
        }
        await navigate(page, 'proxies');
        await page.locator('#proxy_row_1').waitFor();
        expect(await page.locator('#proxy_row_1').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
        await page.evaluate(() => renderProxyPoolTable());
        expect(await page.locator('#proxy_row_1').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
        expect(state.errors).toEqual([]);
    });

    it('tracks real submenu toggle clicks, selected indicator and keyboard-visible switch focus', async () => {
        const { page } = await fixture({ reducedMotion: 'reduce' });
        await navigate(page, 'runtime_logs');
        const group = page.locator('#nav_group_business .nav-group-toggle');
        await group.click();
        await page.waitForFunction(() => document.querySelector('#nav_group_business .nav-group-toggle').getAttribute('aria-expanded') === 'true');
        await page.waitForFunction(() => Math.abs(document.querySelector('.kc-nav-indicator').getBoundingClientRect().y - document.querySelector('.nav-menu .nav-item.active').getBoundingClientRect().y) < 1);
        const expanded = await page.locator('.kc-nav-indicator').boundingBox();
        const active = await page.locator('.nav-menu .nav-item.active').boundingBox();
        expect(Math.abs(expanded.y - active.y)).toBeLessThan(1);
        await group.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('#nav_group_business .nav-group-toggle').getAttribute('aria-expanded') === 'false');
        await page.waitForFunction(() => Math.abs(document.querySelector('.kc-nav-indicator').getBoundingClientRect().y - document.querySelector('.nav-menu .nav-item.active').getBoundingClientRect().y) < 1);
        const collapsed = await page.locator('.kc-nav-indicator').boundingBox();
        const nextActive = await page.locator('.nav-menu .nav-item.active').boundingBox();
        expect(Math.abs(collapsed.y - nextActive.y)).toBeLessThan(1);
        expect(collapsed.y).toBeLessThan(expanded.y);
        await navigate(page, 'checkout_debug');
        await group.click();
        await page.waitForFunction(() => document.querySelector('#nav_group_business .nav-group-toggle').getAttribute('aria-expanded') === 'false');
        await page.waitForFunction(() => Math.abs(document.querySelector('.kc-nav-indicator').getBoundingClientRect().y - document.querySelector('#nav_group_business .nav-group-toggle').getBoundingClientRect().y) < 1);
        await navigate(page, 'proxies');
        await page.locator('#proxy_row_1 input').focus();
        expect(await page.locator('#proxy_row_1 .toggle-switch').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    });

    it('plays page/first-entry transitions, skips repeated panel entrance, and has a reduced-motion path', async () => {
        const { page } = await fixture();
        await navigate(page, 'proxies');
        await page.waitForFunction(() => document.querySelector('#proxies').classList.contains('kc-first-enter'));
        expect(await page.locator('#proxies').evaluate(el => getComputedStyle(el).animationName)).toBe('kc-page');
        expect(await page.locator('#proxies > .panel').first().evaluate(el => getComputedStyle(el).animationName)).toBe('kc-panel');
        await page.waitForFunction(() => !document.querySelector('#proxies').classList.contains('kc-first-enter'));
        await navigate(page, 'dashboard');
        await navigate(page, 'proxies');
        expect(await page.locator('#proxies > .panel').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none');
        expect(await page.locator('#proxies').evaluate(el => getComputedStyle(el).animationName)).toBe('kc-page');
        for (let i = 0; i < 4; i++) {
            await navigate(page, 'dashboard');
            await navigate(page, 'proxies');
        }
        expect(await page.locator('.page-view.active').count()).toBe(1);
        await page.waitForFunction(() => document.querySelector('#proxies').getAnimations().every(animation => animation.playState === 'finished'));
        expect(await page.locator('#proxies').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
    });

    it.each([390, 720])('contains tables and forms at %ipx without page overflow', async width => {
        const { page } = await fixture({ viewport: { width, height: 900 } });
        for (const id of ['dashboard', 'proxies', 'checkout_debug', 'config', 'browser_pool', 'tax_addresses', 'billing']) {
            await navigate(page, id);
            const measurements = await page.locator('.main-content').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
            expect(measurements.scroll, `${id} scroll width`).toBeLessThanOrEqual(measurements.client + 1);
        }
    });

    it.each(['no-preference', 'reduce'])('opens mobile drawer, traps focus and restores focus (%s)', async reducedMotion => {
        const { page } = await fixture({ viewport: { width: 390, height: 844 }, reducedMotion });
        const menu = page.locator('#workspace_menu_toggle');
        expect(await page.locator('#admin_sidebar').getAttribute('inert')).toBe('');
        await menu.click();
        expect(await menu.getAttribute('aria-expanded')).toBe('true');
        if (reducedMotion === 'reduce') {
            const styles = await page.locator('#admin_sidebar .nav-menu').evaluate(el => ({ visibility: getComputedStyle(el).visibility, transition: getComputedStyle(el).transitionProperty }));
            expect(styles).toEqual({ visibility: 'visible', transition: 'none' });
        }
        await page.waitForFunction(() => document.activeElement.closest('#admin_sidebar')?.id === 'admin_sidebar');
        expect(await page.evaluate(() => document.activeElement.closest('#admin_sidebar')?.id)).toBe('admin_sidebar');
        await page.keyboard.press('Shift+Tab');
        expect(await page.evaluate(() => document.activeElement.textContent.trim())).toBe('退出登录');
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement.textContent.trim())).toBe('概览中心');
        await page.keyboard.press('Escape');
        expect(await menu.getAttribute('aria-expanded')).toBe('false');
        expect(await menu.evaluate(el => el === document.activeElement)).toBe(true);
        await menu.click();
        await page.locator('#sidebar_scrim').click({ position: { x: 365, y: 100 } });
        expect(await menu.getAttribute('aria-expanded')).toBe('false');
        await menu.click();
        await page.evaluate(() => document.getElementById('workspace_menu_toggle').focus());
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement.textContent.trim())).toBe('概览中心');
    });

    it('reduces motion and retains the existing unauthenticated login gate', async () => {
        const { page, state } = await fixture({ reducedMotion: 'reduce' });
        const duration = await page.locator('#dashboard').evaluate(el => parseFloat(getComputedStyle(el).animationDuration));
        expect(duration).toBeLessThanOrEqual(0.001);
        expect(await page.locator('#dashboard').evaluate(el => getComputedStyle(el).animationIterationCount)).toBe('1');
        expect(state.errors).toEqual([]);
        const noAuth = await fixture({ authenticated: false });
        await noAuth.page.waitForURL('**/admin-login');
        expect(noAuth.state.requests.filter(r => r.path.startsWith('/api/admin/'))).toEqual([]);
    });
});
