'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture() {
    const cancelAutoRenew = vi.fn();
    const querySubscriptionBySession = vi.fn();
    const delay = vi.fn(async () => {});
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/checkout/post-activation-renewal.js'), 'utf8'), {
        module,
        require: (name) => name === 'node:timers/promises'
            ? { setTimeout: delay }
            : { cancelAutoRenew, querySubscriptionBySession }
    });
    return { ...module.exports, cancelAutoRenew, querySubscriptionBySession, delay };
}

const disabled = { ok: true, data: { hasActiveSubscription: true, autoRenewRaw: false } };
const accepted = { ok: true, data: { hasActiveSubscription: true, autoRenewRaw: true, cancelled: true } };

describe('post-activation auto-renewal', () => {
    it('only reports disabled with an active subscription and will_renew=false', async () => {
        const run = fixture();
        run.cancelAutoRenew.mockResolvedValue(disabled);
        const options = { email: 'test@example.invalid', proxy: 'http://proxy.invalid:8080' };
        expect(await run.cancelRenewalAfterActivation('synthetic', options)).toMatchObject({ state: 'disabled' });
        expect(run.cancelAutoRenew).toHaveBeenCalledExactlyOnceWith('synthetic', options);
        expect(run.querySubscriptionBySession).not.toHaveBeenCalled();
    });

    it('polls after an accepted cancel instead of submitting it repeatedly', async () => {
        const run = fixture();
        run.cancelAutoRenew.mockResolvedValue(accepted);
        run.querySubscriptionBySession.mockResolvedValueOnce({ ok: true, data: { hasActiveSubscription: true, autoRenewRaw: true } })
            .mockResolvedValueOnce(disabled);
        expect(await run.cancelRenewalAfterActivation('synthetic')).toMatchObject({ state: 'disabled' });
        expect(run.cancelAutoRenew).toHaveBeenCalledOnce();
        expect(run.querySubscriptionBySession).toHaveBeenCalledTimes(2);
    });

    it('reports pending rather than disabled if cancellation cannot be verified', async () => {
        const run = fixture();
        run.cancelAutoRenew.mockResolvedValue(accepted);
        run.querySubscriptionBySession.mockResolvedValue({ ok: false, statusCode: 502 });
        expect(await run.cancelRenewalAfterActivation('synthetic')).toMatchObject({ state: 'pending' });
        expect(run.cancelAutoRenew).toHaveBeenCalledOnce();
    });

    it('retries when a just-purchased subscription has not appeared yet', async () => {
        const run = fixture();
        run.cancelAutoRenew.mockResolvedValueOnce({ ok: false, statusCode: 400, error: 'not active yet' })
            .mockResolvedValueOnce(disabled);
        expect(await run.cancelRenewalAfterActivation('synthetic')).toMatchObject({ state: 'disabled' });
        expect(run.cancelAutoRenew).toHaveBeenCalledTimes(2);
        expect(run.delay).toHaveBeenCalledOnce();
    });

    it('does not call inactive accounts with will_renew=false a confirmed cancellation', async () => {
        const run = fixture();
        run.cancelAutoRenew.mockResolvedValue({ ok: true, data: { hasActiveSubscription: false, autoRenewRaw: false } });
        expect(await run.cancelRenewalAfterActivation('synthetic')).toMatchObject({ state: 'failed' });
        expect(run.cancelAutoRenew).toHaveBeenCalledTimes(3);
    });

    it.each([401, 403])('stops on HTTP %s and preserves a safe warning', async (statusCode) => {
        const run = fixture();
        run.cancelAutoRenew.mockResolvedValue({ ok: false, statusCode, error: 'private upstream data' });
        const result = await run.cancelRenewalAfterActivation('synthetic');
        expect(result.state).toBe('failed');
        expect(result.message).not.toContain('private');
        expect(run.cancelAutoRenew).toHaveBeenCalledOnce();
    });

    it('absorbs network exceptions without retrying a charge or leaking credentials', async () => {
        const run = fixture();
        run.cancelAutoRenew.mockRejectedValue(new Error('secret-token proxy-password'));
        const result = await run.cancelRenewalAfterActivation('synthetic');
        expect(result.state).toBe('failed');
        expect(result.message).not.toMatch(/secret-token|proxy-password/);
        expect(run.cancelAutoRenew).toHaveBeenCalledTimes(3);
    });
});
