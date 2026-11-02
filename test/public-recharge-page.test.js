'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');
const { PLAN_TYPE_LABELS } = require('../src/config/plans');

const publicDir = path.join(__dirname, '../public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const stylesheet = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const browserAvailable = fs.existsSync(chromium.executablePath());

describe('public recharge page contract', () => {
    it('uses the canonical labels for all five plans and contains no retired Pro 5X', () => {
        const mappingSource = html.match(/const PLAN_LABELS = (\{[\s\S]*?\});/)?.[1];
        expect(mappingSource).toBeTruthy();
        expect({ ...vm.runInNewContext(`(${mappingSource})`) }).toEqual(PLAN_TYPE_LABELS);
        const cards = [...html.matchAll(/<article class="plan-card(?: highlight)?" data-plan-type="([^"]+)">[\s\S]*?<h3>([^<]+)<\/h3>/g)];
        expect(cards.map(([, type, label]) => [type, label])).toEqual(Object.entries(PLAN_TYPE_LABELS));
        expect(html).not.toMatch(/pro[\s_-]*5x/i);
    });

    it('removes the requested panels and their page polling without removing the invoice notice', () => {
        expect(html).not.toMatch(/notice-banner|publicRuntimeCard|paymentRegionHint|前台并发|当前账单地区/);
        expect(html).not.toContain('/api/public/runtime');
        expect(html).not.toContain('/api/public/payment-region');
        const invoice = fs.readFileSync(path.join(publicDir, 'subscription.html'), 'utf8');
        expect(invoice).toContain('invoice-page');
        expect(invoice).toContain('/recharge-ui.css');
        expect(invoice).toContain('notice-banner');
        expect(invoice).toContain('Go / Plus / Pro');
        expect(html).not.toContain('>套餐说明<');
        expect(html).toContain('invoice-heartbeat');
    });
});

describe.skipIf(!browserAvailable)('public recharge page in Chromium (mocked backend)', () => {
    let browser;

    beforeAll(async () => {
        browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ['--use-mock-keychain', '--password-store=basic'] });
    });

    afterAll(async () => {
        if (browser) await browser.close();
    });

    async function openPage({ planType = 'plus', planLabel, viewport = { width: 1280, height: 900 }, reducedMotion = 'no-preference', verifyError = false, presentation = true } = {}) {
        const context = await browser.newContext({ viewport, reducedMotion });
        const page = await context.newPage();
        const requests = [];
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => requests.push(request.url()));
        await page.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.hostname === 'ui.test' && url.pathname === '/') {
                return route.fulfill({ status: 200, contentType: 'text/html', body: html });
            }
            if (url.hostname === 'ui.test' && url.pathname === '/subscription') {
                return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(publicDir, 'subscription.html'), 'utf8') });
            }
            if (url.hostname === 'ui.test' && url.pathname === '/style.css') {
                return route.fulfill({ status: 200, contentType: 'text/css', body: stylesheet });
            }
            if (url.hostname === 'ui.test' && ['/recharge-ui.css', '/recharge-ui.js', '/favicon.png', '/images/gpt-logo.png'].includes(url.pathname)) {
                if (!presentation && url.pathname === '/recharge-ui.js') return route.abort();
                const contentType = url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.js') ? 'text/javascript' : 'image/png';
                return route.fulfill({ contentType, body: fs.readFileSync(path.join(publicDir, url.pathname)) });
            }
            if (url.hostname === 'ui.test' && url.pathname === '/api/verify-cdk') {
                if (verifyError) return route.fulfill({ status: 400, json: { success: false, message: '卡密无效（本地测试）' } });
                return route.fulfill({ status: 200, json: { success: true, data: { plan_type: planType, plan_label: planLabel } } });
            }
            if (url.hostname === 'ui.test' && url.pathname === '/api/cdk/query') {
                return route.fulfill({ status: 200, json: { success: true, data: { status: '未使用' } } });
            }
            if (url.hostname === 'unpkg.com') {
                return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.lucide = { createIcons() {} };' });
            }
            return route.abort();
        });
        await page.goto('http://ui.test/', { waitUntil: 'load' });
        if (presentation) await page.waitForFunction(() => document.documentElement.dataset.rechargeUiReady === 'true');
        return { context, page, requests, errors };
    }

    it.each([
        ['desktop', { width: 1280, height: 900 }],
        ['mobile', { width: 375, height: 812 }],
        ['small mobile', { width: 320, height: 700 }]
    ])('summarizes the five plans and expands without horizontal overflow on %s', async (_, viewport) => {
        const { context, page, requests, errors } = await openPage({ viewport });
        try {
            const cards = page.locator('.plan-card');
            expect(await cards.count()).toBe(5);
            expect(await cards.first().isVisible()).toBe(false);
            expect(await page.locator('.plan-summary').textContent()).toContain('Go · Plus · Pro 10X · Pro 20X · Pro 50X');
            expect(await page.locator('.plan-toggle .when-closed').isVisible()).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await page.locator('.plan-summary').click();
            expect(await page.locator('.plan-toggle .when-open').isVisible()).toBe(true);
            for (const [type, label] of Object.entries(PLAN_TYPE_LABELS)) {
                expect(await page.locator(`[data-plan-type="${type}"] h3`).textContent()).toBe(label);
                await page.locator(`[data-plan-type="${type}"]`).waitFor({ state: 'visible' });
                expect(await page.locator(`[data-plan-type="${type}"]`).isVisible()).toBe(true);
            }
            expect(await page.locator('.notice-banner, #publicRuntimeCard, #paymentRegionHint').count()).toBe(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            expect(requests.some((url) => /\/api\/public\/(runtime|payment-region)/.test(url))).toBe(false);
            await page.locator('.plan-summary').click();
            await cards.first().waitFor({ state: 'hidden' });
            expect(await cards.first().isVisible()).toBe(false);
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
    });

    it('opens and closes plan details with the keyboard while retaining the entered CDK', async () => {
        const { context, page, errors } = await openPage();
        try {
            await page.locator('#cdkInput').fill('TEST-KEEP-INPUT');
            await page.locator('.plan-summary').press('Enter');
            expect(await page.locator('.plan-disclosure').evaluate(element => element.open)).toBe(true);
            expect(await page.locator('#cdkInput').inputValue()).toBe('TEST-KEEP-INPUT');
            await page.locator('.plan-summary').press('Space');
            expect(await page.locator('.plan-disclosure').evaluate(element => element.open)).toBe(false);
            expect(await page.locator('#cdkInput').inputValue()).toBe('TEST-KEEP-INPUT');
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
    });

    it('shows the invoice entry hint and navigates to the existing invoice assistant', async () => {
        const { context, page, errors } = await openPage();
        try {
            const entry = page.getByRole('link', { name: '打开发票助手，查询订阅与发票' }).first();
            expect(await entry.evaluate(element => getComputedStyle(element).animationName)).toContain('invoice-heartbeat');
            await entry.click();
            await page.waitForURL('**/subscription');
            expect(await page.getByRole('heading', { name: '发票助手', exact: true }).isVisible()).toBe(true);
            expect(await page.locator('body').getAttribute('class')).toContain('invoice-page');
            expect(await page.locator('.landing-brand').isVisible()).toBe(true);
            expect(await page.locator('#checkBtn').isVisible()).toBe(true);
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
    });

    it('traps mobile-menu focus, closes with Escape and restores the opener', async () => {
        const { context, page, errors } = await openPage({ viewport: { width: 390, height: 844 } });
        try {
            const toggle = page.locator('#landing_menu_toggle');
            await toggle.click();
            const dialog = page.locator('#landing_nav_dialog');
            await dialog.waitFor({ state: 'visible' });
            expect(await toggle.getAttribute('aria-expanded')).toBe('true');
            for (let i = 0; i < 8; i++) {
                await page.keyboard.press('Tab');
                expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
            }
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'hidden' });
            expect(await toggle.getAttribute('aria-expanded')).toBe('false');
            expect(await toggle.evaluate(element => document.activeElement === element)).toBe(true);
            expect(errors).toEqual([]);
        } finally { await context.close(); }
    });

    it('closes the menu on its backdrop and opens plans from the page link', async () => {
        const { context, page, errors } = await openPage({ viewport: { width: 390, height: 844 } });
        try {
            const toggle = page.locator('#landing_menu_toggle');
            const dialog = page.locator('#landing_nav_dialog');
            await toggle.click();
            await page.mouse.click(8, 180);
            await dialog.waitFor({ state: 'hidden' });
            await page.locator('#cdkInput').fill('TEST-KEEP-INPUT');
            await page.locator('.plan-summary').click();
            await page.waitForFunction(() => document.getElementById('plans').open);
            expect(await page.locator('#cdkInput').inputValue()).toBe('TEST-KEEP-INPUT');
            expect(await page.locator('.plan-summary').evaluate(element => document.activeElement === element)).toBe(true);
            expect(errors).toEqual([]);
        } finally { await context.close(); }
    });

    it('adds the frosted navigation after scrolling and resets it at the top', async () => {
        const { context, page } = await openPage({ viewport: { width: 390, height: 600 } });
        try {
            await page.evaluate(() => window.scrollTo({ top: 200, behavior: 'instant' }));
            await page.waitForFunction(() => document.getElementById('landing_header').classList.contains('is-scrolled'));
            expect(await page.locator('#landing_header').getAttribute('class')).toContain('is-scrolled');
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
            await page.waitForFunction(() => !document.getElementById('landing_header').classList.contains('is-scrolled'));
        } finally { await context.close(); }
    });

    it('respects reduced motion in the title, floating layers, menu and form-state changes', async () => {
        const { context, page, errors } = await openPage({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
        try {
            for (const selector of ['.shine-text', '.floating-note', '.checkout-glow', '.hero-eyebrow']) {
                expect(await page.locator(selector).first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
            }
            await page.locator('#landing_menu_toggle').click();
            expect(await page.locator('#landing_nav_dialog').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
            await page.keyboard.press('Escape');
            await page.locator('#landing_nav_dialog').waitFor({ state: 'hidden' });
            await page.locator('#cdkInput').fill('TEST-CDK');
            await page.locator('#redeemBtn').click();
            await page.locator('#tokenInput').waitFor({ state: 'visible' });
            expect(await page.locator('#step2').evaluate(element => element.getAnimations().length)).toBe(0);
            expect(errors).toEqual([]);
        } finally { await context.close(); }
    });

    it('retains the card input and retry control after a verification error', async () => {
        const { context, page, errors } = await openPage({ verifyError: true });
        try {
            await page.locator('#cdkInput').fill('TEST-INVALID-INPUT');
            await page.locator('#redeemBtn').click();
            await page.getByText('卡密无效（本地测试）').waitFor({ state: 'visible' });
            expect(await page.locator('#cdkInput').inputValue()).toBe('TEST-INVALID-INPUT');
            expect(await page.locator('#redeemBtn').isEnabled()).toBe(true);
            expect(await page.locator('#step1').isVisible()).toBe(true);
            expect(errors).toEqual([]);
        } finally { await context.close(); }
    });

    it('keeps the form and native plan disclosure usable if the presentation script does not load', async () => {
        const { context, page, errors } = await openPage({ presentation: false });
        try {
            await page.locator('.plan-summary').click();
            expect(await page.locator('.plan-disclosure').evaluate(element => element.open)).toBe(true);
            await page.locator('#cdkInput').fill('TEST-CDK');
            await page.locator('#redeemBtn').click();
            await page.locator('#tokenInput').waitFor({ state: 'visible' });
            expect(await page.locator('#redeemPlanInfo').textContent()).toContain('ChatGPT Plus');
            expect(errors).toEqual([]);
        } finally { await context.close(); }
    });

    it('focuses the current query input from the header action without resetting the tab', async () => {
        const { context, page, errors } = await openPage({ reducedMotion: 'reduce' });
        try {
            await page.locator('[data-tab="query"]').click();
            await page.locator('#queryInput').fill('TEST-QUERY-INPUT');
            await page.locator('.landing-nav-cta').click();
            await page.waitForFunction(() => document.activeElement === document.getElementById('queryInput'));
            expect(await page.locator('#queryInput').inputValue()).toBe('TEST-QUERY-INPUT');
            expect(await page.locator('#querySection').isVisible()).toBe(true);
            expect(errors).toEqual([]);
        } finally { await context.close(); }
    });

    it.each(Object.entries(PLAN_TYPE_LABELS))('shows the %s card plan after CDK verification', async (type, label) => {
        const { context, page, errors } = await openPage({ planType: type });
        try {
            await page.locator('#cdkInput').fill('TEST-CDK');
            await page.locator('#redeemBtn').click();
            await page.locator('#redeemPlanInfo strong').waitFor({ state: 'visible' });
            expect(await page.locator('#redeemPlanInfo strong').textContent()).toBe(label);
            expect(await page.locator('#tokenInput').isVisible()).toBe(true);
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
    });

    it('preserves status lookup and the post-payment renewal message', async () => {
        const { context, page, errors } = await openPage();
        try {
            await page.locator('[data-tab="query"]').click();
            await page.locator('#queryInput').fill('TEST-CDK');
            await page.locator('#queryBtn').click();
            await page.getByText('自助激活码').waitFor({ state: 'visible' });
            await page.evaluate(() => applyTaskState({ status: 'success', message: '充值成功；已确认关闭自动续费' }));
            expect(await page.locator('#statusMessage').textContent()).toContain('已确认关闭自动续费');
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
    });
});
