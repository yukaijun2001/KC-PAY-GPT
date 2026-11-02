'use strict';

const { validateUiCheckoutPayload, waitForCheckoutPage } = require('../src/checkout/pricing-checkout');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

describe('UI Checkout plan/region guard', () => {
    it.each([
        ['pro_10x', 'chatgptprolite'],
        ['pro_20x', 'chatgptpro'],
        ['pro_50x', 'chatgptpromax']
    ])('only accepts the matching Pro plan_name for %s', (planType, expectedPlan) => {
        for (const planName of ['chatgptprolite', 'chatgptpro', 'chatgptpromax']) {
            const result = validateUiCheckoutPayload({
                plan_name: planName, billing_details: { country: 'PH', currency: 'PHP' }
            }, { planType, region: 'PH' });
            if (planName === expectedPlan) expect(result).toBe('');
            else expect(result).toContain(expectedPlan);
        }
    });

    it('accepts the selected plan, billing region and currency', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptplusplan', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: 'plus', region: 'PH' })).toBe('');
    });

    it('never silently turns Pro 10X into Pro 20X', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptpro', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: 'pro_10x', region: 'PH' })).toContain('chatgptprolite');
    });

    it('never silently turns Pro 50X into Pro 20X', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptpro', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: 'pro_50x', region: 'PH' })).toContain('chatgptpromax');
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

    it('rejects a Plus request or wrong region when Go was requested', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptplusplan', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: 'go', region: 'PH' })).toContain('chatgptgoplan');
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptgoplan', billing_details: { country: 'US', currency: 'USD' }
        }, { planType: 'go', region: 'PH' })).toContain('PH/PHP');
    });

    it('waits for asynchronous error details before reporting failure', async () => {
        await expect(waitForCheckoutPage({}, 1000, async () => 'upstream detail')).rejects.toThrow('upstream detail');
    });
});

describe('UI plan button selection', () => {
    it.each([
        ['go', 'Upgrade to Go'],
        ['pro_10x', 'Upgrade to Pro 10X'],
        ['pro_20x', 'Upgrade to Pro 20X'],
        ['pro_50x', 'Upgrade to Pro 50X']
    ])('selects the exact %s button before generic Pro', async (planType, expected) => {
        const filename = path.join(__dirname, '../src/checkout/pricing-checkout.js');
        const realRequire = createRequire(filename);
        const module = { exports: {} };
        const context = vm.createContext({
            module, console, setTimeout, clearTimeout,
            require: (name) => name === '../browser/session-auth'
                ? { assertChatGptLoggedIn: async () => {} }
                : realRequire(name)
        });
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
        context.switchToPersonalPlans = async () => {};
        const buttonNames = ['Upgrade to Pro 20X', 'Upgrade to Go', 'Upgrade to Pro 10X', 'Upgrade to Pro 50X'];
        const clicked = [];
        const page = {
            waitForTimeout: async () => {},
            getByRole: (_, { name }) => {
                const match = buttonNames.find((label) => name.test(label));
                const locator = {
                    first: () => locator, isVisible: async () => Boolean(match),
                    scrollIntoViewIfNeeded: async () => {}, click: async () => { clicked.push(match); }
                };
                return locator;
            }
        };
        await context.module.exports.clickPlanUpgrade(page, planType);
        expect(clicked).toEqual([expected]);
    });
});

describe('UI Checkout request guard integration', () => {
    function fixture({ sentPlan = 'chatgptplusplan', upstreamStatus = 200, upstreamBody = '', responseDuringWait = false, bodyDelayMs = 0 } = {}) {
        const sourcePath = path.join(__dirname, '../src/checkout/pricing-checkout.js');
        const source = fs.readFileSync(sourcePath, 'utf8');
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
            require: createRequire(sourcePath), module, console,
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
        await expect(run.open(run.page, { planType: 'pro_10x', region: 'PH' })).rejects.toThrow('chatgptprolite');
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
