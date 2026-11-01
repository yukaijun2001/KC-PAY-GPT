'use strict';

const { validateUiCheckoutPayload, waitForCheckoutPage } = require('../pricing-checkout');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('UI Checkout plan/region guard', () => {
    it('accepts the selected plan, billing region and currency', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptplusplan', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: 'plus', region: 'PH' })).toBe('');
    });

    it('never silently turns Pro 5x into Pro 20x', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptpro', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: 'pro_5x', region: 'PH' })).toContain('chatgptprolite');
    });

    it('preserves an explicitly overridden plan', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptplusplan', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: 'plus', region: 'PH', planNameOverride: 'requested-plan' })).toContain('requested-plan');
    });

    it('rejects the wrong country or currency even if the UI price detector passed', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptplusplan', billing_details: { country: 'US', currency: 'USD' }
        }, { planType: 'plus', region: 'PH' })).toContain('PH/PHP');
    });

    it('waits for asynchronous error details before reporting failure', async () => {
        await expect(waitForCheckoutPage({}, 1000, async () => 'upstream detail')).rejects.toThrow('upstream detail');
    });
});

describe('UI Checkout request guard integration', () => {
    function fixture({ sentPlan = 'chatgptplusplan', upstreamStatus = 200, upstreamBody = '', responseDuringWait = false, bodyDelayMs = 0 } = {}) {
        const source = fs.readFileSync(path.join(__dirname, '../pricing-checkout.js'), 'utf8');
        const listener = new Map();
        const route = {
            request: () => ({ method: () => 'POST', postDataJSON: () => ({
                plan_name: sentPlan, billing_details: { country: 'PH', currency: 'PHP' }
            }) }),
            abort: vi.fn(), fallback: vi.fn()
        };
        let guard;
        const page = {
            route: vi.fn(async (_, fn) => { guard = fn; }),
            unroute: vi.fn(),
            on: vi.fn((name, fn) => listener.set(name, fn)),
            off: vi.fn((name) => listener.delete(name))
        };
        const module = { exports: {} };
        const context = vm.createContext({
            require: (name) => require(path.join(__dirname, '..', name)), module, console,
            setTimeout, clearTimeout
        });
        vm.runInContext(source, context);
        // Keep the real openPricingCheckout orchestration and its guard; skip DOM selectors.
        context.waitForPricingPage = async () => {};
        context.switchToPersonalPlans = async () => {};
        context.selectPricingRegion = async () => {};
        const emitResponse = () => {
            listener.get('response')?.({
                url: () => 'https://chatgpt.com/backend-api/payments/checkout',
                status: () => upstreamStatus,
                text: async () => {
                    if (bodyDelayMs < 0) return new Promise(() => {});
                    if (bodyDelayMs) await new Promise(resolve => setTimeout(resolve, bodyDelayMs));
                    return upstreamBody;
                }
            });
        };
        context.clickPlanUpgrade = async () => {
            await guard(route);
            if (!responseDuringWait) emitResponse();
        };
        context.waitForCheckoutPage = async (_, __, failure) => {
            if (responseDuringWait) emitResponse();
            const message = await failure();
            if (message) throw new Error(message);
            return 'https://chatgpt.com/checkout/openai_llc/cs_test_ui';
        };
        return { page, route, open: context.module.exports.openPricingCheckout };
    }

    it('passes a matching request through without removing the session route', async () => {
        const run = fixture();
        await expect(run.open(run.page, { planType: 'plus', region: 'PH' })).resolves.toContain('/checkout/');
        expect(run.route.fallback).toHaveBeenCalledOnce();
        expect(run.route.abort).not.toHaveBeenCalled();
        expect(run.page.unroute).toHaveBeenCalledOnce();
    });

    it('aborts a mismatched Pro request before it reaches the server', async () => {
        const run = fixture({ sentPlan: 'chatgptpro' });
        await expect(run.open(run.page, { planType: 'pro_5x', region: 'PH' })).rejects.toThrow('chatgptprolite');
        expect(run.route.abort).toHaveBeenCalledOnce();
        expect(run.route.fallback).not.toHaveBeenCalled();
        expect(run.page.unroute).toHaveBeenCalledOnce();
    });

    it('surfaces a UI API failure and removes the temporary guard', async () => {
        const run = fixture({ upstreamStatus: 403 });
        await expect(run.open(run.page, { planType: 'plus', region: 'PH' })).rejects.toThrow('HTTP 403');
        expect(run.page.unroute).toHaveBeenCalledOnce();
        expect(run.page.off).toHaveBeenCalledOnce();
    });

    it('keeps the upstream unusual-activity body on the UI failure', async () => {
        const message = 'Our systems have detected unusual activity. Please try again later.';
        const run = fixture({ upstreamStatus: 400, upstreamBody: JSON.stringify({ detail: message }) });
        await expect(run.open(run.page, { planType: 'plus', region: 'PH' })).rejects.toThrow(message);
    });

    it('retains error details when the response arrives after the click returns', async () => {
        const message = 'Our systems have detected unusual activity. Please try again later.';
        const run = fixture({ upstreamStatus: 400, upstreamBody: JSON.stringify({ detail: message, token: 'do-not-log' }), responseDuringWait: true, bodyDelayMs: 10 });
        const error = await run.open(run.page, { planType: 'plus', region: 'PH' }).catch(err => err);
        expect(error.message).toContain(message);
        expect(error.message).not.toContain('do-not-log');
        expect(run.page.unroute).toHaveBeenCalledOnce();
        expect(run.page.off).toHaveBeenCalledOnce();
    });

    it('reports the HTTP status if the error response body never completes', async () => {
        const run = fixture({ upstreamStatus: 400, responseDuringWait: true, bodyDelayMs: -1 });
        await expect(run.open(run.page, { planType: 'plus', region: 'PH' })).rejects.toThrow('HTTP 400');
        expect(run.page.unroute).toHaveBeenCalledOnce();
    });
});
