'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const adminAuth = require('../src/admin/admin-auth');
const plans = require('../src/config/plans');

const root = path.join(__dirname, '..');

describe('subscription plan routes', () => {
    let listener;
    let base;
    let store;
    let adminToken;

    beforeAll(async () => {
        const filename = path.join(root, 'server.js');
        const realRequire = createRequire(filename);
        store = {
            ...plans,
            ensureReady: vi.fn(async () => {}),
            getAdminPaths: vi.fn(async () => ({ loginPath: 'admin-login', panelPath: 'admin' })),
            getAdminAuthConfig: vi.fn(async () => ({ passwordVersion: 1 })),
            getPaymentRegion: vi.fn(async () => 'PH'),
            getMaintenanceModeState: vi.fn(async () => ({ enabled: false })),
            getMaxConcurrentActivations: vi.fn(async () => 2),
            verifyCdkDetails: vi.fn(async () => ({ plan_type: 'pro_5x', type: '自助' })),
            getRunningTaskByCdk: vi.fn(async () => null),
            markCdkUsed: vi.fn(async () => true),
            insertCdks: vi.fn(async (cdks) => ({ insertedCount: cdks.length, duplicateCount: 0, totalCount: cdks.length }))
        };
        const module = { exports: {} };
        const context = vm.createContext({
            module, exports: module.exports, __dirname: root, __filename: filename,
            require: (name) => name === './src/persistence/mysql-store' ? store : realRequire(name),
            process: { env: { ...process.env, IS_PRODUCT_FLOW: 'true' }, on: vi.fn(), pid: process.pid,
                platform: process.platform, cwd: () => root, exit: vi.fn() },
            console: { log() {}, warn() {}, error() {} },
            Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval
        });
        vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = app;', context, { filename });
        listener = await new Promise((resolve) => {
            const app = module.exports.listen(0, '127.0.0.1', () => resolve(app));
        });
        base = `http://127.0.0.1:${listener.address().port}`;
        adminToken = adminAuth.issueAdminToken(1).token;
    });

    afterAll(async () => {
        if (listener) await new Promise((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
    });

    function request(route, body, admin = true) {
        return fetch(`${base}${route}`, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${adminToken}` } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
    }

    it('returns the canonical plan names to the admin page', async () => {
        const response = await request('/api/admin/checkout/plans');
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.plans).toEqual(plans.PLAN_NAME_MAP);
        expect(data.resolved).toEqual(plans.PLAN_NAME_MAP);
    });

    it.each(Object.keys(plans.PLAN_NAME_MAP))('generates and imports %s CDKs unchanged', async (planType) => {
        const generated = await request('/api/admin/cdks/generate', { count: 1, plan_type: planType });
        expect(generated.status).toBe(200);
        expect((await generated.json()).plan_type).toBe(planType);
        expect(store.insertCdks.mock.lastCall[1].plan_type).toBe(planType);

        const imported = await request('/api/admin/cdks/import', { cdks: ['EXAMPLE-CODE'], plan_type: planType });
        expect(imported.status).toBe(200);
        expect(store.insertCdks.mock.lastCall[1].plan_type).toBe(planType);
    });

    it.each(['/api/admin/cdks/generate', '/api/admin/cdks/import'])('rejects removed plan on %s', async (route) => {
        store.insertCdks.mockClear();
        const response = await request(route, { count: 1, cdks: ['EXAMPLE-CODE'], plan_type: 'pro_5x' });
        expect(response.status).toBe(400);
        expect(store.insertCdks).not.toHaveBeenCalled();
    });

    it('rejects a historical Pro 5X CDK before reserving it', async () => {
        const verified = await request('/api/verify-cdk', { cdk: 'EXAMPLE-CODE' }, false);
        expect(verified.status).toBe(400);
        expect((await verified.json()).message).toContain('不支持的套餐类型');

        const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const token = [encode({ typ: 'JWT', alg: 'RS256' }), encode({
            iss: 'https://auth.openai.com', aud: ['https://api.openai.com/v1'], scp: ['model.request'],
            exp: Math.floor(Date.now() / 1000) + 600,
            'https://api.openai.com/auth': { chatgpt_account_id: 'test-account', chatgpt_user_id: 'test-user' }
        }), 'synthetic-signature'].join('.');
        store.markCdkUsed.mockClear();
        const activation = await request('/api/run-process', { cdk: 'EXAMPLE-CODE', token }, false);
        expect(activation.status).toBe(400);
        expect((await activation.json()).message).toContain('不支持的套餐类型');
        expect(store.markCdkUsed).not.toHaveBeenCalled();
    });
});
