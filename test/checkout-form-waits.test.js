'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const {
    waitForBillingFields,
    selectFirstVisibleSelect,
    selectBillingComboboxItem,
    getBillingInputsBelowHeading,
    readBillingInputValues
} = require('../src/payments/stripe-payment');

// These fixtures exercise only form controls in a local, offline document.
// No accounts, payment services or external pages are contacted.
describe.skipIf(!fs.existsSync(chromium.executablePath()))('Checkout form wait budgets — isolated Chromium', () => {
    let browser;
    let context;
    let page;

    beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() }); });
    beforeEach(async () => {
        context = await browser.newContext();
        page = await context.newPage();
        await page.route('**/*', route => route.abort());
        page.setDefaultTimeout(1000);
    });
    afterEach(async () => { await context?.close(); });
    afterAll(async () => { await browser?.close(); });

    async function select(html, options, budget = 600) {
        await page.setContent(html);
        const started = performance.now();
        const result = await selectBillingComboboxItem(page, { el: page.locator('#choice') }, options, '测试字段', budget);
        return { result, elapsed: performance.now() - started };
    }

    it('matches the existing native option value without timing out on missing aliases', async () => {
        const measured = await select(`
            <select id="choice" onchange="window.changes=(window.changes||0)+1">
                <option value="">Choose</option>
                <option value="US">United States of America</option>
            </select>`, ['United States', '美国', 'US']);
        expect(measured.result).toBe(true);
        expect(measured.elapsed).toBeLessThan(1500);
        expect(await page.locator('#choice').inputValue()).toBe('US');
        expect(await page.evaluate(() => window.changes)).toBe(1);
    });

    it('does not dispatch another change for an already selected option', async () => {
        const measured = await select(`
            <select id="choice" onchange="window.changes=(window.changes||0)+1">
                <option value="US" selected>United States</option>
            </select>`, ['US']);
        expect(measured.result).toBe(true);
        expect(await page.evaluate(() => window.changes || 0)).toBe(0);
    });

    it('supports the enabled hidden native select behind a custom control', async () => {
        const measured = await select(`
            <select id="choice" style="display:none">
                <option value="">Choose</option><option value="NH">New Hampshire</option>
            </select>`, ['New Hampshire', 'NH']);
        expect(measured.result).toBe(true);
        expect(measured.elapsed).toBeLessThan(1500);
        expect(await page.locator('#choice').inputValue()).toBe('NH');
    });

    it.each([
        '<select id="choice" disabled><option value="">Choose</option><option value="US">United States</option></select>',
        '<fieldset disabled><select id="choice"><option value="">Choose</option><option value="US">United States</option></select></fieldset>',
        '<select id="choice"><option value="">Choose</option><option value="US" disabled>United States</option></select>',
        '<select id="choice"><option value="">Choose</option><optgroup disabled label="Unavailable"><option value="US">United States</option></optgroup></select>'
    ])('never selects a disabled field or option: %s', async html => {
        const measured = await select(html, ['United States', 'US']);
        expect(measured.result).toBe(false);
        expect(measured.elapsed).toBeLessThan(1500);
        expect(await page.locator('#choice').inputValue()).toBe('');
    });

    it('reports an absent native option immediately without changing the selection', async () => {
        const measured = await select('<select id="choice"><option value="CA">Canada</option></select>', ['United States', '美国', 'US']);
        expect(measured.result).toBe(false);
        expect(measured.elapsed).toBeLessThan(1500);
        expect(await page.locator('#choice').inputValue()).toBe('CA');
    });

    it('waits within one budget for asynchronously loaded native options', async () => {
        await page.setContent(`
            <select id="choice"><option value="">Loading</option></select>
            <script>setTimeout(() => choice.add(new Option('New Hampshire', 'NH')), 180)</script>`);
        const started = performance.now();
        expect(await selectFirstVisibleSelect(page, ['#missing', '#choice'], ['New Hampshire', 'NH'], '测试字段', 1200)).toBe(true);
        expect(performance.now() - started).toBeLessThan(2000);
        expect(await page.locator('#choice').inputValue()).toBe('NH');
    });

    it('shares a total deadline across selectors and missing aliases', async () => {
        await page.setContent(`
            <select id="first"><option value="CA">Canada</option></select>
            <select id="second"><option value="MX">Mexico</option></select>`);
        const started = performance.now();
        expect(await selectFirstVisibleSelect(page, ['#first', '#second'], ['United States', '美国', 'US'], '测试字段', 300)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1500);
        expect(await page.locator('#first').inputValue()).toBe('CA');
        expect(await page.locator('#second').inputValue()).toBe('MX');
    });

    it('does not spend an action timeout on each missing custom dropdown alias', async () => {
        const measured = await select(`
            <button id="choice" role="combobox" onclick="document.getElementById('options').hidden=false">Choose</button>
            <div id="options" role="listbox" hidden>
                <div role="option" onclick="window.picked='NH'">New Hampshire</div>
            </div>`, ['Unavailable alias', 'New Hampshire']);
        expect(measured.result).toBe(true);
        expect(measured.elapsed).toBeLessThan(1500);
        expect(await page.evaluate(() => window.picked)).toBe('NH');
    });

    it('waits for a custom menu to render but stops at the shared deadline', async () => {
        const measured = await select(`
            <button id="choice" role="combobox" onclick="setTimeout(() => document.getElementById('options').hidden=false, 120)">Choose</button>
            <div id="options" role="listbox" hidden>
                <div role="option" onclick="window.picked='NH'">New Hampshire</div>
            </div>`, ['Unavailable alias', 'New Hampshire'], 1000);
        expect(measured.result).toBe(true);
        expect(measured.elapsed).toBeLessThan(1800);
    });

    it('preserves custom dropdown labels with a flag or other decoration', async () => {
        const measured = await select(`
            <button id="choice" role="combobox" onclick="document.getElementById('options').hidden=false">Choose</button>
            <div id="options" role="listbox" hidden>
                <div role="option" onclick="window.picked='US'">🇺🇸 United States</div>
            </div>`, ['United States']);
        expect(measured.result).toBe(true);
        expect(await page.evaluate(() => window.picked)).toBe('US');
    });

    it('keeps the outer deadline when a custom menu never offers a candidate', async () => {
        await page.setContent('<button id="choice" role="combobox">Choose</button>');
        const started = performance.now();
        expect(await selectFirstVisibleSelect(page, ['#choice', '#missing'], ['Unavailable', 'Missing'], '测试字段', 300)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1500);
    });

    it('recognizes a ready form by its label without waiting for legacy ids', async () => {
        await page.setContent('<label>Address line 1<input></label>');
        const started = performance.now();
        expect(await waitForBillingFields(page, 800)).toBe(true);
        expect(performance.now() - started).toBeLessThan(1500);
    });

    it('still waits for a form that has not rendered yet', async () => {
        await page.setContent(`<script>setTimeout(() => {
            document.body.innerHTML = '<label>Address line 1<input></label>';
        }, 180)</script>`);
        expect(await waitForBillingFields(page, 1200)).toBe(true);
    });

    it('does not mistake an optional name outside the billing form for readiness', async () => {
        await page.setContent('<label>Full name (optional)<input></label>');
        expect(await waitForBillingFields(page, 250)).toBe(false);
    });

    it('skips an absent optional heading without a ten-second wait', async () => {
        await page.setContent('<label>Address line 1<input></label>');
        const started = performance.now();
        expect(await getBillingInputsBelowHeading(page)).toEqual([]);
        expect(performance.now() - started).toBeLessThan(1500);
    });

    it('reads labeled fields even without the legacy heading or ids', async () => {
        await page.setContent(`
            <label>Full name<input value="Fixture User"></label>
            <label>Address line 1<input value="Synthetic Street"></label>
            <label>City<input value="Fixture City"></label>
            <label>Postal code<input value="00000"></label>
            <label for="state-choice">State</label><select id="state-choice"><option value="NH">New Hampshire</option></select>
            <label for="country-choice">Country or region</label><select id="country-choice"><option value="US">United States</option></select>`);
        const started = performance.now();
        expect(await readBillingInputValues(page)).toEqual({
            name: 'Fixture User', line1: 'Synthetic Street', city: 'Fixture City',
            postal: '00000', state: 'NH', country: 'US'
        });
        expect(performance.now() - started).toBeLessThan(2000);
    });

    it('does not repeatedly wait for absent selectors or invent missing values', async () => {
        await page.setContent('<p>The form has not rendered</p>');
        const started = performance.now();
        expect(await readBillingInputValues(page)).toEqual({ name: '', line1: '', city: '', postal: '', state: '', country: '' });
        expect(performance.now() - started).toBeLessThan(2000);
    });
});
