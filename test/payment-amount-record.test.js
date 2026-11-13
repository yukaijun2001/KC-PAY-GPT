'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

function fixture(due) {
    const filename = path.join(__dirname, '../src/payments/payment-retry.js');
    const requireActual = createRequire(filename);
    const module = { exports: {} };
    const readCheckoutDueAmount = vi.fn(async () => due);
    const context = vm.createContext({
        module, process: { env: {} }, console,
        require: name => name === './stripe-payment' ? { readCheckoutDueAmount } : requireActual(name)
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return { resolve: context.resolveBilledAmountForRecord, readCheckoutDueAmount };
}

describe('payment amount records use observed amounts', () => {
    it('uses the amount confirmed by this payment attempt', async () => {
        const run = fixture({ amount: 1, currency: 'USD' });
        expect(await run.resolve({}, { dueAmount: 1100, dueCurrency: 'PHP' }, 1200, 'PHP'))
            .toEqual({ amount: 1100, currency: 'PHP' });
        expect(run.readCheckoutDueAmount).not.toHaveBeenCalled();
    });

    it('uses a current page amount if the result omitted one', async () => {
        const run = fixture({ amount: 1120, currency: 'PHP' });
        expect(await run.resolve({}, {}, 1100, 'PHP')).toEqual({ amount: 1120, currency: 'PHP' });
    });

    it('retains the last observed full amount if the success page no longer displays Checkout', async () => {
        const run = fixture(null);
        expect(await run.resolve({}, {}, 1100, 'PHP')).toEqual({ amount: 1100, currency: 'PHP' });
    });

    it('does not fabricate an amount when no amount has been observed', async () => {
        const run = fixture(null);
        expect(await run.resolve({}, {}, 0, 'PHP')).toEqual({ amount: 0, currency: 'PHP' });
    });

    it('keeps PH/PHP Checkout routing independent of the configured US billing address', async () => {
        const filename = path.join(__dirname, '../src/payments/payment-retry.js');
        const requireActual = createRequire(filename);
        const address = { id: 11, country: 'US', line1: 'Fixture street', city: 'Fixture city', state: 'NH', postal_code: '03104' };
        const store = {
            getAppConfigValue: vi.fn(async () => null),
            reserveCard: vi.fn().mockResolvedValueOnce({
                id: 8, card_number: 'fixture-last4', card_expiry: 'fixture', card_cvc: 'fixture', card_holder: 'Fixture User'
            }).mockResolvedValue(null),
            releaseCard: vi.fn(async () => {}), bindCardPaymentProfile: vi.fn(async () => {}),
            recordCardUsage: vi.fn(async () => {}), createBillingRecord: vi.fn(async () => {})
        };
        const completeStripeCardPayment = vi.fn(async () => ({ success: true, holderName: 'Fixture User', dueAmount: 1100, dueCurrency: 'PHP' }));
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
            module, console: { log() {} }, process: { env: {} },
            require: name => {
                if (name === '../persistence/mysql-store') return store;
                if (name === './stripe-payment') return { completeStripeCardPayment, readCheckoutDueAmount: async () => ({ amount: 1100, currency: 'PHP' }) };
                if (name === './tax-free-address') return { pickBillingAddressForCheckout: async () => address, markAddressBound: async () => {} };
                return requireActual(name);
            }
        }, { filename });
        expect(await module.exports.executePaymentWithRetry({}, { planType: 'plus', region: 'PH' })).toMatchObject({ success: true });
        expect(completeStripeCardPayment.mock.calls[0][2]).toEqual(address);
        expect(completeStripeCardPayment.mock.calls[0][3]).toMatchObject({ expectedCurrency: 'PHP' });
        expect(store.createBillingRecord).toHaveBeenCalledWith(expect.objectContaining({ amount: 1100, currency: 'PHP', status: 'success' }));
    });
});
