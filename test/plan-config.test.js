'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../src/persistence/mysql-store');
const { getPlanTypeLabel } = require('../src/config/region-config');
const { validateUiCheckoutPayload } = require('../src/checkout/pricing-checkout');
const { parseAccountCheckResponse } = require('../src/checkout/subscription-check');

const expected = {
    go: 'chatgptgoplan',
    plus: 'chatgptplusplan',
    pro_10x: 'chatgptprolite',
    pro_20x: 'chatgptpro',
    pro_50x: 'chatgptpromax'
};

describe('subscription plan mapping', () => {
    it('exposes the five requested canonical plan types', () => {
        expect(store.PLAN_NAME_MAP).toEqual(expected);
        for (const [type, name] of Object.entries(expected)) {
            expect(store.resolvePlanName(type)).toBe(name);
        }
    });

    it('does not accept the removed Pro 5X type', () => {
        expect(store.resolvePlanName('pro_5x')).toBeNull();
        expect(getPlanTypeLabel('pro_5x')).toContain('未知套餐');
        expect(getPlanTypeLabel('pro_10x')).toBe('ChatGPT Pro 10X');
    });

    it('does not silently convert an unknown plan to Plus', () => {
        expect(store.resolvePlanName('unknown')).toBeNull();
        expect(getPlanTypeLabel('unknown')).not.toBe('ChatGPT Plus');
    });

    it.each(Object.entries(expected))('validates the exact UI request for %s', (type, name) => {
        expect(validateUiCheckoutPayload({
            plan_name: name, billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: type, region: 'PH' })).toBe('');
        expect(validateUiCheckoutPayload({
            plan_name: 'not-the-requested-plan', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: type, region: 'PH' })).toContain(name);
    });

    it('does not pass an unknown UI plan through the Plus fallback', () => {
        expect(validateUiCheckoutPayload({
            plan_name: 'chatgptplusplan', billing_details: { country: 'PH', currency: 'PHP' }
        }, { planType: 'not-a-plan', region: 'PH' })).toContain('不支持');
    });

    it('shows all five canonical plans in the admin selectors', () => {
        const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
        for (const id of ['checkout_plan_type', 'cdk_plan_type', 'billing_plan_type']) {
            const select = html.match(new RegExp(`<select\\s+id="${id}"[\\s\\S]*?<\\/select>`))?.[0] || '';
            const values = [...select.matchAll(/<option\s+value="([^"]+)"/g)].map((match) => match[1]).filter(Boolean);
            expect(values, id).toEqual(Object.keys(expected));
        }
    });

    it('shows the five subscription names on the public page', () => {
        const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
        for (const label of ['ChatGPT Go', 'ChatGPT Plus', 'Pro 10X', 'Pro 20X', 'Pro 50X']) {
            expect(html).toContain(label);
        }
        expect(html).not.toMatch(/Pro\s*5X/i);
    });

    it.each(['go', 'chatgptgoplan'])('recognizes Go in account query response: %s', (plan) => {
        const result = parseAccountCheckResponse({ accounts: { default: {
            entitlement: { subscription_plan: plan, has_active_subscription: true }
        } } });
        expect(result.planKey).toBe('go');
        expect(result.plan).toBe('ChatGPT Go');
    });
});
