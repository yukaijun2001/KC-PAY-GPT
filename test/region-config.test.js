'use strict';

const fs = require('fs');
const path = require('path');
const {
    REGION_CONFIG, SUPPORTED_REGIONS, DEFAULT_REGION, isSupportedRegion,
    getRegionConfig, getRegionBilling, getRegionBrowserProfile
} = require('../src/config/region-config');
const { validateUiCheckoutPayload } = require('../src/checkout/pricing-checkout');

describe('Egypt payment region', () => {
    it('supports EG and resolves the Egyptian currency and browser profile', () => {
        expect(SUPPORTED_REGIONS).toContain('EG');
        expect(isSupportedRegion('eg')).toBe(true);
        expect(getRegionConfig('EG')).toEqual({
            currency: 'EGP', label: '埃及', locale: 'en-EG', timezone: 'Africa/Cairo'
        });
        expect(getRegionBilling('eg')).toEqual({ country: 'EG', currency: 'EGP', label: '埃及' });
        expect(getRegionBrowserProfile('EG')).toEqual({ locale: 'en-EG', timezoneId: 'Africa/Cairo' });
        expect(DEFAULT_REGION).toBe('PH');
    });

    it.each(['region_selector', 'checkout_region_selector'])('keeps %s options in sync with supported regions', id => {
        const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
        const select = html.match(new RegExp(`<select\\s+id="${id}"[\\s\\S]*?<\\/select>`))?.[0] || '';
        const values = [...select.matchAll(/<option\s+value="([^"]+)"/g)].map(match => match[1]);
        expect(values).toEqual(SUPPORTED_REGIONS);
        expect(select).toContain('埃及 (EG) — EGP');
        for (const [code, config] of Object.entries(REGION_CONFIG)) {
            expect(select).toContain(`${config.label} (${code}) — ${config.currency}`);
        }
    });

    it('accepts EG/EGP but still rejects an incorrect country or currency', () => {
        for (const [country, currency] of [['EG', 'EGP'], ['EG', 'USD'], ['PH', 'PHP']]) {
            const result = validateUiCheckoutPayload({
                plan_name: 'chatgptgoplan', billing_details: { country, currency }
            }, { planType: 'go', region: 'EG' });
            if (country === 'EG' && currency === 'EGP') expect(result).toBe('');
            else expect(result).toContain('EG/EGP');
        }
    });
});
