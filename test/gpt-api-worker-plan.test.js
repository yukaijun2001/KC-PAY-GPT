'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { resolveProviderPlanKey } = require('../src/integrations/gpt-api-client');
const { getPlanPaymentRegion, REGION_CONFIG } = require('../src/config/region-config');

function workerFixture(providerPlans) {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('function parseCardExpiry(');
    const end = source.indexOf('\nfunction maskProxyForLog(', start);
    const store = {
        getGptApiConfig: vi.fn(async () => ({ enabled: true, api_key: 'synthetic', country: 'PH', currency: 'PHP' })),
        updateTaskLog: vi.fn(async () => {}),
        getActiveProxy: vi.fn(async region => `http://${region.toLowerCase()}-proxy.invalid:8080`),
        reserveCard: vi.fn(async () => ({ id: 7, card_number: '4242424242424242', card_expiry: '12/2030', card_cvc: '123' })),
        releaseCard: vi.fn(async () => {}),
        resetCdkFailure: vi.fn(async () => {}),
        recordCardUsage: vi.fn(async () => {}),
        markCdkUnused: vi.fn(async () => {}),
        getMaintenanceModeState: vi.fn(async () => ({ enabled: false }))
    };
    const gptApi = {
        fetchPlans: vi.fn(async () => ({ success: true, gptPlans: providerPlans })),
        resolveProviderPlanKey,
        inspectPay: vi.fn(async () => ({ success: true })),
        submitPay: vi.fn(async () => ({ success: true, orderId: 'order', taskId: 'task', data: {} })),
        queryTask: vi.fn(async () => ({ success: true, rawStatus: 'success', data: { result: { ok: true } } })),
        extractTopupCode: vi.fn(() => null)
    };
    const context = vm.createContext({
        store, gptApi, process: { env: {} }, console: { log() {}, error() {} },
        getPlanPaymentRegion, REGION_CONFIG,
        logTask: vi.fn(), broadcastToTask: vi.fn(), notifyTaskOutcome: vi.fn(),
        releaseForegroundSlot: vi.fn(), getTotalActiveJobs: () => 0,
        sleep: async () => {}, maskProxyForLog: () => '',
        isTerminalGptApiStatus: (s) => s === 'success', isSuccessGptApiStatus: (s) => s === 'success'
    });
    vm.runInContext(source.slice(start, end), context);
    return { store, gptApi, run: context.runGptApiWorker };
}

describe('third-party worker plan selection', () => {
    const types = [
        ['go', 'provider-go', 'chatgptgoplan'],
        ['plus', 'provider-plus', 'chatgptplusplan'],
        ['pro_10x', 'provider-pro-lite', 'chatgptprolite'],
        ['pro_20x', 'provider-pro', 'chatgptpro'],
        ['pro_50x', 'provider-pro-max', 'chatgptpromax']
    ];
    const plans = types.map(([, key, plan_name]) => ({ key, plan_name, enabled: 1 }));

    it.each(types)('passes the exact provider key through the %s worker', async (planType, key) => {
        const { run, store, gptApi } = workerFixture(plans);
        await run({ task: { jobKey: 'test-job' }, token: 'synthetic', session: { access_token: 'synthetic' }, cdk: 'TEST', planType });
        expect(gptApi.inspectPay.mock.calls[0][1].planKey).toBe(key);
        expect(gptApi.submitPay.mock.calls[0][1].planKey).toBe(key);
        const region = planType === 'go' ? 'EG' : 'PH';
        expect(store.getActiveProxy).toHaveBeenCalledExactlyOnceWith(region);
        expect(gptApi.submitPay.mock.calls[0][1]).toMatchObject({
            country: region, currency: REGION_CONFIG[region].currency,
            proxy: `http://${region.toLowerCase()}-proxy.invalid:8080`, newCard: { country: region }
        });
        expect(store.markCdkUnused).not.toHaveBeenCalled();
    });

    it.each(['go', 'pro_5x'])('stops and rolls back before reserving a card for unavailable %s', async (planType) => {
        const { run, store, gptApi } = workerFixture([]);
        await run({ task: { jobKey: 'test-job' }, token: 'synthetic', cdk: 'TEST', planType });
        expect(gptApi.inspectPay).not.toHaveBeenCalled();
        expect(gptApi.submitPay).not.toHaveBeenCalled();
        expect(store.reserveCard).not.toHaveBeenCalled();
        expect(store.markCdkUnused).toHaveBeenCalledWith('TEST');
    });

    it.each(['empty', 'missing'])('does not reserve a card or submit when regional proxy is %s', async mode => {
        const { run, store, gptApi } = workerFixture(plans);
        if (mode === 'empty') store.getActiveProxy.mockResolvedValue('');
        else store.getActiveProxy.mockRejectedValue(new Error('没有启用的埃及标签代理'));
        await run({ task: { jobKey: 'test-job' }, token: 'fixture', cdk: 'TEST', planType: 'go' });
        expect(store.reserveCard).not.toHaveBeenCalled();
        expect(gptApi.submitPay).not.toHaveBeenCalled();
        expect(store.markCdkUnused).toHaveBeenCalledWith('TEST');
    });
});
