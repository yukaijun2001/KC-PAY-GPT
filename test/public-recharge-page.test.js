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
        expect(invoice).toContain('notice-banner');
        expect(invoice).toContain('Go / Plus / Pro');
    });
});

describe.skipIf(!browserAvailable)('public recharge page in Chromium (mocked backend)', () => {
    let browser;

    beforeAll(async () => {
        browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    });

    afterAll(async () => {
        if (browser) await browser.close();
    });

    async function openPage({ planType = 'plus', planLabel, viewport = { width: 1280, height: 900 } } = {}) {
        const context = await browser.newContext({ viewport });
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
            if (url.hostname === 'ui.test' && url.pathname === '/style.css') {
                return route.fulfill({ status: 200, contentType: 'text/css', body: stylesheet });
            }
            if (url.hostname === 'ui.test' && url.pathname === '/api/verify-cdk') {
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
        return { context, page, requests, errors };
    }

    it.each([
        ['desktop', { width: 1280, height: 900 }],
        ['mobile', { width: 375, height: 812 }],
        ['small mobile', { width: 320, height: 700 }]
    ])('renders the five plans without the removed panels or horizontal overflow on %s', async (_, viewport) => {
        const { context, page, requests, errors } = await openPage({ viewport });
        try {
            const cards = page.locator('.plan-card');
            expect(await cards.count()).toBe(5);
            for (const [type, label] of Object.entries(PLAN_TYPE_LABELS)) {
                expect(await page.locator(`[data-plan-type="${type}"] h3`).textContent()).toBe(label);
            }
            expect(await page.locator('.notice-banner, #publicRuntimeCard, #paymentRegionHint').count()).toBe(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            expect(requests.some((url) => /\/api\/public\/(runtime|payment-region)/.test(url))).toBe(false);
            expect(errors).toEqual([]);
        } finally {
            await context.close();
        }
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
