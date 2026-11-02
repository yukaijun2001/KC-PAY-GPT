'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getPlanPaymentRegion, REGION_CONFIG } = require('../src/config/region-config');
const { normalizePlanType } = require('../src/config/plans');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function fixture({ paymentStatus = 'success', renewalState = 'disabled', env = {} } = {}) {
    const store = {
        getGptApiConfig: vi.fn(async () => ({ enabled: true, api_key: 'synthetic', country: 'PH', currency: 'PHP' })),
        getActiveProxy: vi.fn(async () => 'http://task-proxy.invalid:8080'),
        getHcaptchaConfig: vi.fn(async () => ({})),
        updateTaskLog: vi.fn(async () => {}),
        reserveCard: vi.fn(async () => ({ id: 7, card_number: 'synthetic-card', card_expiry: '12/2030', card_cvc: '123' })),
        releaseCard: vi.fn(async () => {}), recordCardUsage: vi.fn(async () => {}),
        resetCdkFailure: vi.fn(async () => {}), resetActivationAttemptFailure: vi.fn(async () => {}),
        markCdkUnused: vi.fn(async () => {}),
        getMaintenanceModeState: vi.fn(async () => ({ enabled: false }))
    };
    const gptApi = {
        fetchPlans: vi.fn(async () => ({ success: true, gptPlans: [] })),
        resolveProviderPlanKey: () => 'provider-plus',
        inspectPay: vi.fn(async () => ({ success: true })),
        submitPay: vi.fn(async () => ({ success: true, orderId: 'order', taskId: 'task', data: {} })),
        queryTask: vi.fn(async () => ({ success: true, rawStatus: paymentStatus, data: { result: { ok: paymentStatus === 'success' } } })),
        extractTopupCode: () => null
    };
    const cancelRenewalAfterActivation = vi.fn(async () => ({
        state: renewalState,
        message: renewalState === 'disabled' ? '已确认关闭自动续费' : '自动续费未能确认关闭，请联系管理员；请勿重复充值'
    }));
    const runCheckoutScript = vi.fn(async () => ({ output: 'synthetic output', analysis: {
        status: paymentStatus, message: paymentStatus === 'success' ? '激活成功' : '支付失败', shouldRetry: false
    } }));
    const broadcastToTask = vi.fn();
    const notifyTaskOutcome = vi.fn();
    const context = vm.createContext({
        __dirname: path.join(__dirname, '..'), path, store, gptApi, process: { env },
        getPlanPaymentRegion, REGION_CONFIG, normalizePlanType,
        console: { log() {}, error() {}, warn() {} }, MAX_PROCESS_ATTEMPTS: 3,
        cancelRenewalAfterActivation, runCheckoutScript, broadcastToTask, notifyTaskOutcome,
        logTask: vi.fn(), releaseForegroundSlot: vi.fn(), getTotalActiveJobs: () => 0,
        sleep: async () => {}, buildHcaptchaEnvFromConfig: () => ({ env: {} }),
        extractEmailFromSession: () => 'test@example.invalid',
        extractCardLast4FromOutput: () => 'test', extractTaskMediaFromOutput: () => ({ screenshots: [], videos: [] }),
        normalizeTaskProgress: (n, status) => Math.min(n, status === 'success' ? 100 : 99),
        getCheckoutProgress: () => 99,
        spawnWorkerWithBrowser: async ({ runtimeEnv, runScript }) => runScript(runtimeEnv),
        isCardPoolExhaustedIssue: () => false, isNoActivationEligibilityMessage: () => false
    });
    vm.runInContext(source.slice(source.indexOf('function parseCardExpiry('), source.indexOf('\nasync function handleActivationRequest(')), context);
    return { store, gptApi, runCheckoutScript, cancelRenewalAfterActivation, broadcastToTask, notifyTaskOutcome,
        run: (mode, cancelAutoRenewOnSuccess, planType = 'plus') => context[mode === 'local' ? 'spawnActivationWorker' : 'runGptApiWorker']({
            task: { jobKey: 'test-job' }, token: 'synthetic', sessionRaw: '{}', session: {},
            cdk: 'TEST-CDK', cdkDetails: { plan_type: planType }, planType, cancelAutoRenewOnSuccess
        })
    };
}

describe.each(['local', 'provider'])('%s activation auto-renewal', (mode) => {
    it('cancels only after payment success and publishes one final success with confirmation', async () => {
        const run = fixture();
        const eventsDuringCancel = [];
        run.cancelRenewalAfterActivation.mockImplementation(async () => {
            eventsDuringCancel.push(...run.broadcastToTask.mock.calls.map(([, data]) => data));
            return { state: 'disabled', message: '已确认关闭自动续费' };
        });
        await run.run(mode, true);
        expect(run.cancelRenewalAfterActivation).toHaveBeenCalledExactlyOnceWith('synthetic', {
            email: mode === 'local' ? 'test@example.invalid' : '', proxy: 'http://task-proxy.invalid:8080'
        });
        expect(eventsDuringCancel.length).toBeGreaterThan(0);
        expect(eventsDuringCancel.every((event) => event.status === 'running' && event.progress < 100)).toBe(true);
        expect(run.broadcastToTask.mock.lastCall[1]).toMatchObject({ status: 'success', progress: 100 });
        expect(run.broadcastToTask.mock.lastCall[1].message).toContain('已确认关闭自动续费');
        expect(run.store.updateTaskLog.mock.lastCall[1].message).toContain('已确认关闭自动续费');
        if (mode === 'local') expect(run.store.updateTaskLog.mock.lastCall[1].cardLast4).toBe('test');
        expect(run.notifyTaskOutcome.mock.lastCall[0].message).toContain('已确认关闭自动续费');
        expect(run.store.markCdkUnused).not.toHaveBeenCalled();
        const payment = mode === 'local' ? run.runCheckoutScript : run.gptApi.queryTask;
        expect(payment.mock.invocationCallOrder[0]).toBeLessThan(run.cancelRenewalAfterActivation.mock.invocationCallOrder[0]);
    });

    it('does not alter admin-initiated activations', async () => {
        const run = fixture();
        await run.run(mode, false);
        expect(run.cancelRenewalAfterActivation).not.toHaveBeenCalled();
        expect(run.broadcastToTask.mock.lastCall[1].status).toBe('success');
    });

    it('does not cancel on a failed recharge and releases the unused CDK', async () => {
        const run = fixture({ paymentStatus: 'failed' });
        await run.run(mode, true);
        expect(run.cancelRenewalAfterActivation).not.toHaveBeenCalled();
        expect(run.broadcastToTask.mock.lastCall[1].status).toBe('failed');
        expect(run.store.markCdkUnused).toHaveBeenCalledWith('TEST-CDK');
    });

    it('keeps payment successful and CDK consumed if cancellation fails', async () => {
        const run = fixture({ renewalState: 'failed' });
        await run.run(mode, true);
        expect(run.broadcastToTask.mock.lastCall[1]).toMatchObject({ status: 'success', progress: 100 });
        expect(run.broadcastToTask.mock.lastCall[1].message).toContain('请勿重复充值');
        expect(run.store.markCdkUnused).not.toHaveBeenCalled();
        expect(mode === 'local' ? run.runCheckoutScript : run.gptApi.submitPay).toHaveBeenCalledOnce();
    });

    it('does not roll back or retry payment even if post-payment code throws', async () => {
        const run = fixture();
        run.cancelRenewalAfterActivation.mockRejectedValue(new Error('private upstream error'));
        await run.run(mode, true);
        expect(run.broadcastToTask.mock.lastCall[1]).toMatchObject({ status: 'success', progress: 100 });
        expect(run.broadcastToTask.mock.lastCall[1].message).toContain('请勿重复充值');
        expect(run.broadcastToTask.mock.lastCall[1].message).not.toContain('private upstream');
        expect(run.store.markCdkUnused).not.toHaveBeenCalled();
        expect(mode === 'local' ? run.runCheckoutScript : run.gptApi.submitPay).toHaveBeenCalledOnce();
    });

    it('keeps the CDK consumed when recording the final success fails once', async () => {
        const run = fixture();
        let failedOnce = false;
        run.store.updateTaskLog.mockImplementation(async (_, data) => {
            if (data.status === 'success' && !failedOnce) { failedOnce = true; throw new Error('DB temporarily unavailable'); }
        });
        await run.run(mode, true);
        expect(failedOnce).toBe(true);
        expect(run.store.markCdkUnused).not.toHaveBeenCalled();
        expect(run.broadcastToTask.mock.lastCall[1].status).toBe('success');
    });

    it('still cancels if saving the intermediate renewal progress fails', async () => {
        const run = fixture();
        run.store.updateTaskLog.mockImplementation(async (_, data) => {
            if (data.message.startsWith('充值成功，正在关闭')) throw new Error('DB temporarily unavailable');
        });
        await run.run(mode, true);
        expect(run.cancelRenewalAfterActivation).toHaveBeenCalledOnce();
        expect(run.broadcastToTask.mock.lastCall[1].message).toContain('已确认关闭自动续费');
        expect(run.store.markCdkUnused).not.toHaveBeenCalled();
    });

    it('still sends successful payment status if the database stays unavailable after cancellation', async () => {
        const run = fixture();
        run.cancelRenewalAfterActivation.mockImplementation(async () => {
            run.store.updateTaskLog.mockRejectedValue(new Error('DB unavailable'));
            return { state: 'disabled', message: '已确认关闭自动续费' };
        });
        await run.run(mode, true);
        expect(run.cancelRenewalAfterActivation).toHaveBeenCalledOnce();
        expect(run.broadcastToTask.mock.lastCall[1]).toMatchObject({ status: 'success', progress: 100 });
        expect(run.broadcastToTask.mock.lastCall[1].message).toContain('请勿重复充值');
        expect(run.store.markCdkUnused).not.toHaveBeenCalled();
        expect(mode === 'local' ? run.runCheckoutScript : run.gptApi.submitPay).toHaveBeenCalledOnce();
    });

    it('retains successful recharge and a pending cancellation warning', async () => {
        const run = fixture({ renewalState: 'pending' });
        await run.run(mode, true);
        expect(run.broadcastToTask.mock.lastCall[1]).toMatchObject({ status: 'success', progress: 100 });
        expect(run.store.updateTaskLog.mock.lastCall[1].message).toContain('请勿重复充值');
        expect(run.store.markCdkUnused).not.toHaveBeenCalled();
    });
});

describe('local activation regional proxy routing', () => {
    it.each([['go', 'EG'], ['plus', 'PH'], ['pro_10x', 'PH'], ['pro_20x', 'PH'], ['pro_50x', 'PH']])('binds %s to %s and overwrites stale inherited region/proxy', async (planType, region) => {
        const run = fixture({ env: { PAYMENT_REGION_OVERRIDE: 'US', PROXY: 'http://stale-proxy.invalid:8080' } });
        await run.run('local', false, planType);
        expect(run.store.getActiveProxy).toHaveBeenCalledExactlyOnceWith(region);
        expect(run.runCheckoutScript.mock.calls[0][2]).toMatchObject({
            CDK_PLAN_TYPE: planType, PAYMENT_REGION_OVERRIDE: region, PROXY: 'http://task-proxy.invalid:8080'
        });
    });

    it.each(['empty', 'missing'])('fails before spawning a child when matching proxy is %s', async mode => {
        const run = fixture();
        if (mode === 'empty') run.store.getActiveProxy.mockResolvedValue('');
        else run.store.getActiveProxy.mockRejectedValue(new Error('没有启用的埃及标签代理'));
        await run.run('local', false, 'go');
        expect(run.runCheckoutScript).not.toHaveBeenCalled();
        expect(run.store.reserveCard).not.toHaveBeenCalled();
        expect(run.store.markCdkUnused).toHaveBeenCalledWith('TEST-CDK');
        expect(run.broadcastToTask.mock.lastCall[1].status).toBe('failed');
    });

    it('reuses one proxy for local retries and post-payment renewal', async () => {
        const run = fixture();
        run.runCheckoutScript.mockResolvedValueOnce({ output: 'retry', analysis: {
            status: 'retry', message: 'retry', shouldRetry: true
        } });
        await run.run('local', true, 'go');
        expect(run.runCheckoutScript).toHaveBeenCalledTimes(2);
        expect(run.store.getActiveProxy).toHaveBeenCalledExactlyOnceWith('EG');
        expect(run.runCheckoutScript.mock.calls.map(call => call[2].PROXY)).toEqual([
            'http://task-proxy.invalid:8080', 'http://task-proxy.invalid:8080'
        ]);
        expect(run.cancelRenewalAfterActivation.mock.calls[0][1].proxy).toBe('http://task-proxy.invalid:8080');
    });
});

it('never retries a successful local charge even if the child suggests a retry', async () => {
    const run = fixture();
    run.runCheckoutScript.mockResolvedValue({ output: 'PAYMENT_SUCCESS', analysis: {
        status: 'success', message: '激活成功', shouldRetry: true
    } });
    await run.run('local', true);
    expect(run.runCheckoutScript).toHaveBeenCalledOnce();
    expect(run.cancelRenewalAfterActivation).toHaveBeenCalledOnce();
    expect(run.store.markCdkUnused).not.toHaveBeenCalled();
});

describe('activation source policy', () => {
    function handlerFixture(useProvider) {
        const runGptApiWorker = vi.fn(async () => {});
        const spawnActivationWorker = vi.fn(async () => {});
        const store = {
            getMaintenanceModeState: async () => ({ enabled: false }),
            getMaxConcurrentActivations: async () => 2,
            verifyCdkDetails: async () => ({ type: '自助', plan_type: 'plus' }),
            getRunningTaskByCdk: async () => null,
            getGptApiConfig: async () => ({ enabled: useProvider, api_key: 'synthetic' }),
            hasAvailableCard: async () => true,
            markCdkUsed: async () => true,
            createTaskLog: async () => ({ jobKey: 'test-job' })
        };
        const context = vm.createContext({
            store, runGptApiWorker, spawnActivationWorker, console: { log() {} },
            ensureStoreReady: async () => {}, parseSessionJson: () => ({}), normalizeSessionToken: () => 'synthetic',
            getClientIp: () => '', validateAccessToken: () => ({ valid: true }),
            activeForegroundJobs: new Set(), normalizePlanType: () => 'plus', getRemainingCooldownMinutes: () => 0,
            buildStoredSessionPayload: () => '{}', extractSessionPreview: () => 'test@example.invalid',
            logTask: vi.fn(), reserveForegroundSlot: vi.fn()
        });
        const start = source.indexOf('async function handleActivationRequest(');
        vm.runInContext(source.slice(start, source.indexOf("\napp.post('/api/run-process'", start)), context);
        return { handler: context.handleActivationRequest, worker: useProvider ? runGptApiWorker : spawnActivationWorker };
    }

    it.each([false, true])('enforces public auto-cancel on the server, provider=%s', async (provider) => {
        const run = handlerFixture(provider);
        const res = { json: vi.fn((value) => value), status: vi.fn() };
        res.status.mockReturnValue(res);
        await run.handler({ path: '/api/run-process', body: { session: '{}', cdk: 'TEST-CDK', cancelAutoRenewOnSuccess: false } }, res);
        expect(res.json.mock.lastCall[0]).toMatchObject({ success: true });
        expect(run.worker.mock.lastCall[0].cancelAutoRenewOnSuccess).toBe(true);
    });

    it.each([false, true])('leaves admin manual activation unchanged, provider=%s', async (provider) => {
        const run = handlerFixture(provider);
        const res = { json: vi.fn((value) => value), status: vi.fn() };
        res.status.mockReturnValue(res);
        await run.handler({ path: '/api/admin/trigger-activation', body: { session: '{}', cdk: 'TEST-CDK', cancelAutoRenewOnSuccess: true } }, res);
        expect(res.json.mock.lastCall[0]).toMatchObject({ success: true });
        expect(run.worker.mock.lastCall[0].cancelAutoRenewOnSuccess).toBe(false);
    });

    it.each(['/API/RUN-PROCESS', '/api/run-process/'])('applies the same source policy to Express path alias %s', async (route) => {
        const run = handlerFixture(false);
        const res = { json: vi.fn((value) => value), status: vi.fn() };
        res.status.mockReturnValue(res);
        await run.handler({ path: route, body: { session: '{}', cdk: 'TEST-CDK' } }, res);
        expect(run.worker.mock.lastCall[0].cancelAutoRenewOnSuccess).toBe(true);
    });
});
