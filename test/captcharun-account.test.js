'use strict';

const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');
const account = require('../src/integrations/captcharun-account');
const { createCaptcharunRouter } = require('../src/admin/captcharun-routes');

function memoryStore() {
    const values = new Map();
    return {
        values,
        getAppConfigValue: vi.fn(async (key, fallback) => values.has(key) ? values.get(key) : fallback),
        setAppConfigValue: vi.fn(async (key, value) => { values.set(key, value); })
    };
}

const exampleWallet = {
    balance: '1127.2473499999999617784',
    credit: '10000',
    cumulativeRecharge: '13029.9977500000000381216',
    share: '312.23755'
};

describe('CaptchaRun account configuration', () => {
    afterEach(() => vi.restoreAllMocks());

    it('keeps an environment token separate, retains blank input, and clears it explicitly', async () => {
        const store = memoryStore();
        const env = { CAPTCHARUN_API_TOKEN: 'env-token', CAPTCHARUN_TIMEOUT_SEC: '35' };
        expect(await account.loadConfig(store, env)).toMatchObject({ api_token: 'env-token', timeout_sec: 35, token_source: 'environment' });
        expect(await account.saveConfig(store, { api_token: '', timeout_sec: 40 }, env)).toMatchObject({ api_token_saved: true, token_source: 'environment', timeout_sec: 40 });
        expect(JSON.parse(store.values.get(account.CONFIG_KEY))).toEqual({ timeout_sec: 40 });
        expect((await account.loadConfig(store, { ...env, CAPTCHARUN_API_TOKEN: 'new-env-token' })).api_token).toBe('new-env-token');
        expect(await account.saveConfig(store, { clear_token: true }, env)).toMatchObject({ api_token_saved: false, token_source: 'none' });
        expect(JSON.parse(store.values.get(account.CONFIG_KEY)).api_token).toBe('');
        expect((await account.loadConfig(store, env)).api_token).toBe('');
    });

    it('sets and retains a database token but never returns it in the public configuration', async () => {
        const store = memoryStore();
        const saved = await account.saveConfig(store, { api_token: 'Bearer local-test-secret', timeout_sec: 8 }, {});
        expect(saved).toEqual({ api_url: 'https://api.captcha-run.com', timeout_sec: 8, api_token_saved: true, token_source: 'database' });
        expect(JSON.stringify(saved)).not.toContain('local-test-secret');
        await account.saveConfig(store, { api_token: '', timeout_sec: 10 }, {});
        expect(await account.loadConfig(store, {})).toMatchObject({ api_token: 'local-test-secret', timeout_sec: 10, token_source: 'database' });
    });

    it('rejects invalid tokens, timeouts and conflicting clear/update without saving', async () => {
        const store = memoryStore();
        for (const input of [
            { api_token: 'bad\nvalue' }, { api_token: 42 }, { timeout_sec: 4 },
            { timeout_sec: 121 }, { timeout_sec: 8.5 }, { timeout_sec: '' },
            { clear_token: 'true' }, { clear_token: true, api_token: 'token' }
        ]) {
            await expect(account.saveConfig(store, input, {})).rejects.toMatchObject({ code: 'CAPTCHARUN_INVALID_CONFIG' });
        }
        expect(store.setAppConfigValue).not.toHaveBeenCalled();
    });

    it('calls only the fixed wallet endpoint with Bearer auth and preserves decimal strings', async () => {
        const request = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: exampleWallet });
        const result = await account.queryWallet({ api_token: 'local-test-secret', timeout_sec: 8 });
        expect(result).toMatchObject({ ok: true, status: 200, wallet: exampleWallet });
        expect(request).toHaveBeenCalledOnce();
        expect(request.mock.calls[0][0]).toMatchObject({
            method: 'GET', url: 'https://api.captcha-run.com/v2/users/self/wallet',
            headers: { Authorization: 'Bearer local-test-secret', Accept: 'application/json' },
            timeout: 8000, maxRedirects: 0
        });
        expect(JSON.stringify(result)).not.toContain('local-test-secret');
    });

    it.each([
        [401, '权限'], [403, '权限'], [429, '频繁'], [302, '重定向'], [500, '失败']
    ])('reports upstream HTTP %s without echoing the response', async (status, fragment) => {
        vi.spyOn(axios, 'request').mockResolvedValue({ status, data: { error: 'local-test-secret' } });
        const result = await account.queryWallet({ api_token: 'local-test-secret', timeout_sec: 8 });
        expect(result.ok).toBe(false);
        expect(result.message).toContain(fragment);
        expect(JSON.stringify(result)).not.toContain('local-test-secret');
    });

    it.each([null, {}, { balance: 'not-a-number' }, { balance: '<script>' }, { error: 'failure', balance: '0' }])('rejects an invalid wallet response', async (data) => {
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data });
        const result = await account.queryWallet({ api_token: 'local-test-secret', timeout_sec: 8 });
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('格式无效') });
    });

    it('does not request without a token and masks transport errors', async () => {
        const request = vi.spyOn(axios, 'request').mockRejectedValue({ code: 'ECONNABORTED', message: 'local-test-secret' });
        expect(await account.queryWallet({ api_token: '', timeout_sec: 8 })).toMatchObject({ ok: false, message: expect.stringContaining('填写') });
        expect(request).not.toHaveBeenCalled();
        const result = await account.queryWallet({ api_token: 'local-test-secret', timeout_sec: 8 });
        expect(result.message).toContain('超时');
        expect(JSON.stringify(result)).not.toContain('local-test-secret');
    });
});

describe('CaptchaRun admin router contract', () => {
    let listener;
    let baseUrl;
    let store;

    beforeEach(async () => {
        vi.stubEnv('CAPTCHARUN_API_TOKEN', '');
        vi.stubEnv('CAPTCHARUN_TIMEOUT_SEC', '');
        store = memoryStore();
        const app = express();
        app.use(express.json());
        app.use('/api/admin', (req, res, next) => {
            if (req.headers.authorization !== 'Bearer local-admin') return res.status(401).json({ success: false });
            next();
        });
        app.use('/api/admin/captcharun', createCaptcharunRouter({ store, ensureStoreReady: async () => {} }));
        await new Promise(resolve => { listener = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${listener.address().port}/api/admin/captcharun`;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    });

    const request = (url, method = 'GET', body, auth = 'Bearer local-admin') => fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    it('requires admin middleware and returns only the credential status after save', async () => {
        expect((await request(baseUrl, 'GET', undefined, '')).status).toBe(401);
        let response = await request(baseUrl, 'PUT', { api_token: 'local-test-secret', timeout_sec: 25 });
        expect(response.status).toBe(200);
        expect(JSON.stringify(await response.json())).not.toContain('local-test-secret');
        response = await request(baseUrl);
        const result = await response.json();
        expect(result).toMatchObject({ success: true, config: { api_token_saved: true, timeout_sec: 25 } });
        expect(JSON.stringify(result)).not.toContain('local-test-secret');
        const mainSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
        expect(mainSource.indexOf("app.use('/api/admin', authenticateAdmin)"))
            .toBeLessThan(mainSource.indexOf("app.use('/api/admin/captcharun', createCaptcharunRouter"));
    });

    it('tests an unsaved token without changing persisted configuration', async () => {
        await request(baseUrl, 'PUT', { api_token: 'existing-token', timeout_sec: 20 });
        const requestSpy = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: exampleWallet });
        const response = await request(`${baseUrl}/test`, 'POST', { api_token: 'temporary-token', timeout_sec: 25 });
        const result = await response.json();
        expect(response.status).toBe(200);
        expect(result).toMatchObject({ success: true, wallet: exampleWallet });
        expect(requestSpy.mock.calls[0][0].headers.Authorization).toBe('Bearer temporary-token');
        expect((await account.loadConfig(store, {})).api_token).toBe('existing-token');
        expect(JSON.stringify(result)).not.toContain('temporary-token');
    });

    it('returns validation and upstream failures without leaking secrets', async () => {
        const invalid = await request(baseUrl, 'PUT', { api_token: 'secret', timeout_sec: 999 });
        expect(invalid.status).toBe(400);
        expect(JSON.stringify(await invalid.json())).not.toContain('secret');
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 403, data: { detail: 'secret' } });
        const response = await request(`${baseUrl}/test`, 'POST', { api_token: 'secret', timeout_sec: 20 });
        expect(response.status).toBe(400);
        expect(JSON.stringify(await response.json())).not.toContain('secret');
    });
});
