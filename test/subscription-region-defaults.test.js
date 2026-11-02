'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getRegionConfig, getPlanPaymentRegion } = require('../src/config/region-config');

// Exercise the exported compatibility entry without creating a real Checkout.
function fixture(env = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../src/checkout/chatgpt.js'), 'utf8');
    const start = source.indexOf('async function activateSubscription(');
    const end = source.indexOf('\n/**', start);
    const createCheckoutSession = vi.fn(async () => ({
        checkoutUrl: 'https://chatgpt.com/checkout/local-fixture', sessionId: 'fixture-session'
    }));
    const executePaymentWithRetry = vi.fn(async () => ({ success: true }));
    const getPaymentRegion = vi.fn(async () => 'US');
    const context = vm.createContext({
        process: { env }, getRegionConfig, getPlanPaymentRegion, executePaymentWithRetry,
        store: { getPaymentRegion },
        ChatGPTService: class { createCheckoutSession(...args) { return createCheckoutSession(...args); } }
    });
    vm.runInContext(source.slice(start, end), context);
    const page = { context: () => ({ request: {} }), goto: vi.fn(), waitForLoadState: vi.fn(async () => {}) };
    return { page, createCheckoutSession, executePaymentWithRetry, getPaymentRegion, run: context.activateSubscription };
}

describe('subscription compatibility entry region defaults', () => {
    it.each([
        ['go', 'EG', 'EGP'], ['plus', 'PH', 'PHP'], ['pro_10x', 'PH', 'PHP'],
        ['pro_20x', 'PH', 'PHP'], ['pro_50x', 'PH', 'PHP']
    ])('uses the %s plan region instead of the global region', async (planType, country, currency) => {
        const run = fixture();
        await expect(run.run({ page: run.page, accessToken: 'local-fixture', planType })).resolves.toMatchObject({ success: true });
        expect(run.createCheckoutSession).toHaveBeenCalledExactlyOnceWith(planType, country, currency);
        expect(run.getPaymentRegion).not.toHaveBeenCalled();
    });

    it('honors a valid explicit CLI override', async () => {
        const run = fixture({ PAYMENT_REGION_OVERRIDE: 'SG' });
        await run.run({ page: run.page, accessToken: 'local-fixture', planType: 'go' });
        expect(run.createCheckoutSession).toHaveBeenCalledExactlyOnceWith('go', 'SG', 'SGD');
    });

    it('rejects invalid overrides before creating Checkout or invoking payment', async () => {
        const run = fixture({ PAYMENT_REGION_OVERRIDE: 'ZZ' });
        await expect(run.run({ page: run.page, accessToken: 'local-fixture', planType: 'go' })).rejects.toThrow('不支持的地区');
        expect(run.createCheckoutSession).not.toHaveBeenCalled();
        expect(run.executePaymentWithRetry).not.toHaveBeenCalled();
    });
});
