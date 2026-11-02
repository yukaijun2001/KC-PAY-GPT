'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const regions = require('../src/config/region-config');
const { normalizePlanType } = require('../src/config/plans');

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function response() {
    const res = { status: vi.fn(), json: vi.fn(value => value) };
    res.status.mockReturnValue(res);
    return res;
}

function adminRoutes() {
    const handlers = {};
    const store = {
        PLAN_NAME_MAP: { go: 'chatgptgoplan' }, resolvePlanName: () => 'chatgptgoplan',
        createTaskLog: vi.fn(async () => ({ jobKey: 'routing-fixture' })),
        updateTaskLog: vi.fn(async () => {}), addProxyAssets: vi.fn(async () => ({ success: true })),
        setProxyAssetRegion: vi.fn(async () => ({ success: true, region_code: 'EG' })),
        setProxyAssetActive: vi.fn(async () => ({ success: true }))
    };
    const context = vm.createContext({
        ...regions, normalizePlanType, store,
        app: Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (route, handler) => { handlers[`${method} ${route}`] = handler; }])),
        ensureStoreReady: async () => {}, parseSessionJson: () => ({}), normalizeSessionToken: () => 'fixture',
        validateAccessToken: () => ({ valid: true }), buildStoredSessionPayload: () => '{}',
        extractEmailFromSession: () => '', extractSessionPreview: () => 'fixture',
        logTask: vi.fn(), spawnCheckoutDebugWorker: vi.fn()
    });
    for (const [from, until] of [
        ["app.post('/api/admin/checkout/generate'", "\napp.get('/api/admin/checkout/status"],
        ["app.post('/api/admin/proxies'", "\napp.post('/api/admin/proxies/:id/test'"]
    ]) {
        const start = serverSource.indexOf(from);
        vm.runInContext(serverSource.slice(start, serverSource.indexOf(until, start)), context);
    }
    return { handlers, store, context };
}

describe('admin regional routing input contract', () => {
    it.each([['go', 'EG'], ['plus', 'PH'], ['pro_50x', 'PH']])('defaults %s debug requests to %s', async (planType, country) => {
        const run = adminRoutes();
        const res = response();
        await run.handlers['post /api/admin/checkout/generate']({ body: { session: '{}', plan_type: planType } }, res);
        expect(run.context.spawnCheckoutDebugWorker.mock.calls[0][0].region).toBe(country);
        expect(res.json.mock.lastCall[0].success).toBe(true);
    });

    it('returns HTTP 400 for an unsupported debug country before creating a task', async () => {
        const run = adminRoutes();
        const res = response();
        await run.handlers['post /api/admin/checkout/generate']({ body: { session: '{}', plan_type: 'go', country: 'ZZ' } }, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(run.store.createTaskLog).not.toHaveBeenCalled();
    });

    it('passes manual regional labels through add and update APIs', async () => {
        const run = adminRoutes();
        await run.handlers['post /api/admin/proxies']({ body: { proxies: ['http://fixture.invalid:80'], region_code: 'eg' } }, response());
        expect(run.store.addProxyAssets).toHaveBeenCalledExactlyOnceWith(['http://fixture.invalid:80'], 'EG');
        await run.handlers['put /api/admin/proxies/:id']({ params: { id: '9' }, body: { region_code: 'EG' } }, response());
        expect(run.store.setProxyAssetRegion).toHaveBeenCalledExactlyOnceWith('9', 'EG');
    });

    it.each([{ region_code: 'ZZ' }, { region_code: 123 }, { region_code: 'EG', is_active: true }])('rejects malformed or mixed proxy updates before mutation', async body => {
        const run = adminRoutes();
        const res = response();
        await run.handlers['put /api/admin/proxies/:id']({ params: { id: '9' }, body }, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(run.store.setProxyAssetRegion).not.toHaveBeenCalled();
        expect(run.store.setProxyAssetActive).not.toHaveBeenCalled();
    });
});

describe('payment retry regional defaults without payment execution', () => {
    function retryFixture(env = {}) {
        const filename = path.join(__dirname, '../src/payments/payment-retry.js');
        const realRequire = createRequire(filename);
        const store = {
            getPaymentRegion: vi.fn(async () => 'US'),
            getAppConfigValue: vi.fn(async () => null), reserveCard: vi.fn(async () => null),
            createBillingRecord: vi.fn(async () => {})
        };
        const module = { exports: {} };
        const context = vm.createContext({
            module, process: { env }, console: { log() {} },
            require: name => {
                if (name === '../persistence/mysql-store') return store;
                if (name === './stripe-payment') return { readCheckoutDueAmount: async () => null };
                if (name === './tax-free-address') return { pickBillingAddressForCheckout: async () => ({ generated: true }) };
                return realRequire(name);
            }
        });
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
        return { store, run: context.module.exports.executePaymentWithRetry };
    }

    it.each([['go', 'EGP'], ['plus', 'PHP'], ['pro_20x', 'PHP']])('records the %s regional currency, not the global region', async (planType, currency) => {
        const fixture = retryFixture();
        await fixture.run({}, { planType });
        expect(fixture.store.getPaymentRegion).not.toHaveBeenCalled();
        expect(fixture.store.createBillingRecord.mock.calls[0][0].currency).toBe(currency);
    });

    it('preserves the current Checkout explicit region and rejects invalid input before reserving cards', async () => {
        const fixture = retryFixture();
        await fixture.run({}, { planType: 'go', region: 'SG' });
        expect(fixture.store.createBillingRecord.mock.calls[0][0].currency).toBe('SGD');
        fixture.store.reserveCard.mockClear();
        const result = await fixture.run({}, { planType: 'go', region: 'ZZ' });
        expect(result.success).toBe(false);
        expect(fixture.store.reserveCard).not.toHaveBeenCalled();
    });
});
