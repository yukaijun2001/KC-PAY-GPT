'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { chromium } = require('playwright');

function loadBilling() {
    const filename = path.join(__dirname, '../src/payments/stripe-payment.js');
    const module = { exports: {} };
    const context = vm.createContext({
        module, exports: module.exports, require: createRequire(filename),
        console: { log() {}, warn() {}, error() {} }, process, Buffer,
        __dirname: path.dirname(filename), setTimeout, clearTimeout
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return context;
}

const billingAddress = { country: 'PH', line1: 'Fixture street', city: 'Fixture city', postal_code: '1000', state: 'Metro Manila' };
const usBillingAddress = { ...billingAddress, country: 'US', city: 'Fixture city', postal_code: '03104', state: 'NH' };

function billingFixture({ country = 'PH', countryLabel = 'Philippines', state = 'Metro Manila', postal = '1000', error = '', hiddenCountry = '', customCountry = false } = {}) {
    const countryControl = customCountry
        ? `<label id="country-label">Country or region</label><button type="button" role="combobox" aria-labelledby="country-label">${countryLabel}</button>`
        : `<label>Country or region<select name="country" autocomplete="billing country"><option value="${country}">${countryLabel}</option></select></label>`;
    return `
        <main><form><h2>Billing address</h2>
            <label>Full name<input autocomplete="billing name" value="Fixture User" required></label>
            ${countryControl}
            ${hiddenCountry ? `<select id="billingAddress-countryInput" hidden><option value="${hiddenCountry}" selected>${hiddenCountry}</option></select>` : ''}
            <label>Address line 1<input name="addressLine1" value="Fixture street" required></label>
            <label>City<input name="locality" value="Fixture city" required></label>
            <label>Postal code<input name="postalCode" value="${postal}" required></label>
            <label>Province<select name="administrativeArea" required><option value="">Province</option>${state ? `<option selected value="${state}">${state}</option>` : ''}</select></label>
            ${error}
            <p>Due today</p><b>₱1,100.00</b>
            <button type="submit" onclick="event.preventDefault(); window.submits=(window.submits||0)+1">Subscribe</button>
        </form></main>`;
}

describe.skipIf(!fs.existsSync(chromium.executablePath()))('Checkout billing validation — local Chromium only', () => {
    let browser;
    let page;
    let billing;

    beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() }); });
    afterAll(async () => { await browser?.close(); });
    beforeEach(async () => {
        page = await browser.newPage();
        await page.route('**/*', route => route.abort());
        page.setDefaultTimeout(500);
        billing = loadBilling();
    });
    afterEach(async () => { await page?.close(); });

    it('detects the exact invalid-postal message shown in the failed task', async () => {
        await page.setContent(billingFixture({ error: '<p>Your postal code is invalid.</p>' }));
        expect(await billing.hasBillingValidationError(page)).toBe(true);
    });

    it('detects visible aria-invalid fields even without an English error message', async () => {
        await page.setContent(billingFixture());
        await page.locator('[name="postalCode"]').evaluate(node => node.setAttribute('aria-invalid', 'true'));
        expect(await billing.hasBillingValidationError(page)).toBe(true);
    });

    it('detects native validity without submitting the form or firing an invalid event', async () => {
        await page.setContent(billingFixture());
        await page.locator('[name="postalCode"]').evaluate(node => {
            window.invalidEvents = 0;
            node.addEventListener('invalid', () => window.invalidEvents++);
            node.setCustomValidity('Fixture postal error');
        });
        expect(await billing.hasBillingValidationError(page)).toBe(true);
        expect(await page.evaluate(() => window.invalidEvents)).toBe(0);
    });

    it('ignores hidden errors while still detecting a later visible error', async () => {
        await page.setContent(billingFixture({ error: '<p hidden>Your postal code is invalid.</p><p>Your postal code is invalid.</p>' }));
        expect(await billing.hasBillingValidationError(page)).toBe(true);
        await page.locator('p').filter({ hasText: 'Your postal code is invalid.' }).last().evaluate(node => node.hidden = true);
        expect(await billing.hasBillingValidationError(page)).toBe(false);
    });

    it('never lets historical success flags replace currently empty field values', () => {
        const actual = { name: '', line1: '', city: '', postal: '', state: '', country: '' };
        const prior = Object.fromEntries(Object.keys(actual).map(key => [key, true]));
        const status = billing.getBillingFieldStatus(actual, prior, billingAddress);
        expect(billing.listBillingMissing(status)).toEqual(['name', 'line1', 'city', 'postal', 'state', 'country']);
    });

    it('rejects an actual country mismatch despite an earlier successful country action', () => {
        const actual = { name: 'Fixture User', line1: 'Fixture street', city: 'Fixture city', postal: '1000', state: 'Metro Manila', country: 'Philippines' };
        expect(billing.getBillingFieldStatus(actual, { country: true }, { country: 'US' }).country).toBe(false);
        expect(billing.getBillingFieldStatus(actual, {}, billingAddress).country).toBe(true);
    });

    it('reads the visible custom country instead of trusting a conflicting hidden select', async () => {
        await page.setContent(billingFixture({ customCountry: true, hiddenCountry: 'US' }));
        const actual = await billing.readBillingInputValues(page);
        expect(actual.country).toBe('Philippines');
    });

    it('does not report a native country selection that React immediately reverts as successful', async () => {
        await page.setContent(`<select id="choice" onchange="this.value='PH'"><option value="PH">Philippines</option><option value="US">United States</option></select>`);
        const selected = await billing.selectBillingComboboxItem(page, { el: page.locator('#choice') }, ['US'], '国家', 700);
        expect(await page.locator('#choice').inputValue()).toBe('PH');
        expect(selected).toBe(false);
    });

    it('selects the visible country widget rather than a stale hidden native select', async () => {
        await page.setContent(`
            <label id="country-label">Country or region</label>
            <button id="country-widget" role="combobox" aria-labelledby="country-label"
                onclick="document.getElementById('countries').hidden=false">Philippines</button>
            <select id="billingAddress-countryInput" hidden><option value="US">United States</option></select>
            <div id="countries" role="listbox" hidden>
                <button type="button" role="option" onclick="document.getElementById('country-widget').textContent='United States'; document.getElementById('countries').hidden=true">United States</button>
            </div>`);
        expect(await billing.selectBillingCountry(page, ['US', 'United States'])).toBe(true);
        expect(await page.locator('#country-widget').innerText()).toBe('United States');
    });

    it('does not mistake a custom Province placeholder for a selected province', async () => {
        await page.setContent(billingFixture());
        await page.locator('[name="administrativeArea"]').evaluate(node => {
            node.parentElement.innerHTML = '<span id="province-label">Province</span><button role="combobox" aria-labelledby="province-label">Select province</button>';
        });
        const actual = await billing.readBillingInputValues(page);
        expect(actual.state).toBe('');
        expect(billing.getBillingFieldStatus(actual, { state: true }, billingAddress).state).toBe(false);
    });

    it('records unchanged observed amounts rather than requiring a synthetic VAT discount', async () => {
        await page.setContent(billingFixture());
        const result = await billing.waitForCheckoutAmount(page, { maxWaitMs: 2000, stableForMs: 200, pollMs: 50 });
        expect(result).toMatchObject({ ok: true, due: { amount: 1100, currency: 'PHP' } });
    }, 20000);

    it('refreshes an older amount from the current Checkout page', async () => {
        await page.setContent(billingFixture());
        expect(await billing.captureCheckoutDueAmount(page, { amount: 982.14, currency: 'PHP' }))
            .toEqual({ amount: 1100, currency: 'PHP' });
    });

    it.each([
        ['PHP 1,100.00', 1100, 'PHP'],
        ['1,100.00 PHP', 1100, 'PHP'],
        ['EGP 250.00', 250, 'EGP'],
        ['S$29.00', 29, 'SGD'],
        ['RM99', 99, 'MYR'],
        ['$20.00', 20, 'USD']
    ])('reads the displayed final amount %s', async (text, amount, currency) => {
        await page.setContent(`<p>Due today</p><b>${text}</b>`);
        expect(await billing.readCheckoutDueAmount(page)).toEqual({ amount, currency });
    });

    it('does not read a subscription price or VAT line as the final due amount', async () => {
        await page.setContent('<p>Plus ₱1,100.00 / month</p><p>VAT ₱117.86</p><p>Due today</p><b>Loading</b>');
        expect(await billing.readCheckoutDueAmount(page)).toBeNull();
    });

    it('ignores an obsolete hidden final amount', async () => {
        await page.setContent('<section hidden>Due today ₱982.14</section><section>Due today ₱1,100.00</section>');
        expect(await billing.readCheckoutDueAmount(page)).toEqual({ amount: 1100, currency: 'PHP' });
    });

    it('waits through a changing amount without requiring a decrease', async () => {
        await page.setContent('<p>Due today</p><b id="due">PHP 1100.00</b><script>setTimeout(() => due.textContent="PHP 1120.00", 150)</script>');
        expect(await billing.waitForCheckoutAmount(page, { maxWaitMs: 2000, stableForMs: 350, pollMs: 60 }))
            .toMatchObject({ ok: true, due: { amount: 1120, currency: 'PHP' } });
    });

    it('fails a missing amount instead of inventing a discounted amount', async () => {
        await page.setContent('<p>Due today</p><b>Loading</b>');
        const result = await billing.waitForCheckoutAmount(page, { maxWaitMs: 200, stableForMs: 100, pollMs: 40 });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('无法确认');
    });

    it('accepts an already valid PH billing form at the unchanged taxed amount without submitting', async () => {
        await page.setContent(billingFixture());
        const result = await billing.fillOpenAiCheckoutBilling(page, billingAddress, 'Fixture User');
        expect(result).toMatchObject({ ok: true, skipped: true, dueAmount: 1100, dueCurrency: 'PHP' });
        expect(await page.evaluate(() => window.submits || 0)).toBe(0);
    });

    it('keeps a US billing address independent of the PHP Checkout amount', async () => {
        await page.setContent(billingFixture({
            country: 'US', countryLabel: 'United States', state: 'New Hampshire', postal: '03104'
        }));
        const result = await billing.fillOpenAiCheckoutBilling(page, usBillingAddress, 'Fixture User');
        expect(result).toMatchObject({ ok: true, skipped: true, dueAmount: 1100, dueCurrency: 'PHP' });
        expect((await billing.readBillingInputValues(page)).country).toBe('US');
        expect(await page.evaluate(() => window.submits || 0)).toBe(0);
    });

    it('does not treat a PHP price as proof that a configured US billing country was saved', async () => {
        await page.setContent(billingFixture({ postal: '03104', state: '' }));
        const result = await billing.confirmBillingResult(page, usBillingAddress, { country: true, state: true });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('country');
        expect(result.error).toContain('state');
        expect(await page.evaluate(() => window.submits || 0)).toBe(0);
    });

    it('fills the configured US country, state and leading-zero ZIP through the visible widget while retaining PHP', async () => {
        await page.setContent(billingFixture({ state: '', postal: '', customCountry: true, hiddenCountry: 'US' }));
        await page.getByRole('combobox', { name: 'Country or region' }).evaluate(node => {
            node.id = 'billing-country';
            node.setAttribute('onclick', "document.getElementById('country-options').hidden=false");
            const options = document.createElement('div');
            options.id = 'country-options';
            options.hidden = true;
            const option = document.createElement('button');
            option.type = 'button';
            option.setAttribute('role', 'option');
            option.textContent = 'United States';
            option.onclick = () => {
                document.getElementById('billing-country').textContent = 'United States';
                const state = document.querySelector('[name="administrativeArea"]');
                state.replaceChildren(new Option('State', ''), new Option('New Hampshire', 'NH'));
                options.hidden = true;
            };
            options.append(option);
            node.after(options);
        });
        for (const name of ['suppressGoogleAddressAutocomplete', 'dismissAddressAutocomplete', 'focusOpenAiBillingSection']) {
            billing[name] = async () => {};
        }
        const result = await billing.fillOpenAiCheckoutBilling(page, usBillingAddress, 'Fixture User');
        expect(result, result.error).toMatchObject({ ok: true, dueAmount: 1100, dueCurrency: 'PHP' });
        expect((await billing.readBillingInputValues(page))).toMatchObject({ country: 'United States', state: 'New Hampshire', postal: '03104' });
        expect(await page.evaluate(() => window.submits || 0)).toBe(0);
    });

    it('rechecks a country that reverts while the amount settles', async () => {
        await page.setContent(billingFixture());
        await page.evaluate(() => setTimeout(() => {
            document.querySelector('[name="country"]').innerHTML = '<option value="US">United States</option>';
        }, 250));
        const result = await billing.confirmBillingResult(page, billingAddress, { country: true });
        expect(result.ok).toBe(false);
        expect(await page.evaluate(() => window.submits || 0)).toBe(0);
    });

    it('blocks a retry before its payment submission when the billing province is empty', async () => {
        await page.setContent(billingFixture({ state: '' }));
        const pageFacade = new Proxy(page, {
            get(target, property) {
                if (property === 'url') return () => 'https://checkout.invalid/checkout/openai_llc/fixture';
                if (property === 'waitForTimeout') return async () => {};
                const value = target[property];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        billing.dismissCheckoutPaymentError = async () => {};
        billing.prepareCheckoutCardSection = async () => {};
        billing.fillCardFieldsOpenAiCheckout = async () => ({ ok: true });
        billing.saveDebugScreenshot = async () => null;
        billing.finalizeCheckoutPayment = vi.fn(async () => ({ success: true }));
        const result = await billing.completeStripeCardPayment(pageFacade, {}, billingAddress, { cardAttempt: 2 });
        expect(result.success).toBe(false);
        expect(result.error).toContain('state');
        expect(billing.finalizeCheckoutPayment).not.toHaveBeenCalled();
    });

    it.each([['PHP', true], ['USD', false]])('verifies PHP Checkout currency before submitting a valid US billing retry (expected %s)', async (expectedCurrency, success) => {
        await page.setContent(billingFixture({ country: 'US', countryLabel: 'United States', state: 'New Hampshire', postal: '03104' }));
        const pageFacade = new Proxy(page, {
            get(target, property) {
                if (property === 'url') return () => 'https://checkout.invalid/checkout/openai_llc/fixture';
                if (property === 'waitForTimeout') return async () => {};
                const value = target[property];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        billing.dismissCheckoutPaymentError = async () => {};
        billing.prepareCheckoutCardSection = async () => {};
        billing.fillCardFieldsOpenAiCheckout = async () => ({ ok: true });
        billing.saveDebugScreenshot = async () => null;
        billing.finalizeCheckoutPayment = vi.fn(async () => ({ success: true }));
        const result = await billing.completeStripeCardPayment(pageFacade, {}, usBillingAddress, { cardAttempt: 2, expectedCurrency });
        expect(result.success).toBe(success);
        expect(billing.finalizeCheckoutPayment).toHaveBeenCalledTimes(success ? 1 : 0);
        if (success) expect(result).toMatchObject({ dueAmount: 1100, dueCurrency: 'PHP' });
        else expect(result.error).toContain('币种');
    });

    it('fails incomplete billing before reporting success or clicking Subscribe', async () => {
        await page.setContent(billingFixture({ state: '' }));
        // Model exhausted field-fill attempts while retaining real page readback,
        // validation and completion orchestration. No remote checkout is used.
        for (const name of ['suppressGoogleAddressAutocomplete', 'dismissAddressAutocomplete', 'focusOpenAiBillingSection']) {
            billing[name] = async () => {};
        }
        billing.locateOpenAiBillingHeading = async () => null;
        billing.fillOpenAiBillingDirect = async () => ({ name: true, line1: true, city: true, postal: true, country: true, state: false });
        billing.selectBillingState = async () => false;
        const result = await billing.fillOpenAiCheckoutBilling(page, billingAddress, 'Fixture User');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/state|州|省/);
        expect(result.error).not.toContain('税区');
        expect(await page.evaluate(() => window.submits || 0)).toBe(0);
    });
});
