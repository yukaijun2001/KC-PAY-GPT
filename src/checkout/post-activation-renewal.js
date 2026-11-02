'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { cancelAutoRenew, querySubscriptionBySession } = require('./subscription-check');

// A successful charge is irreversible here. Never throw a renewal failure back
// into payment retry/CDK rollback, and never equate an accepted cancel with a
// verified will_renew=false. Retry briefly for delayed subscription activation.
async function cancelRenewalAfterActivation(accessToken, options = {}) {
    let submitted = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await delay(attempt * 2000);
        try {
            const result = submitted
                ? await querySubscriptionBySession(accessToken, options)
                : await cancelAutoRenew(accessToken, options);
            if (result?.ok && result.data?.hasActiveSubscription === true
                && result.data?.autoRenewRaw === false) {
                return { state: 'disabled', message: '已确认关闭自动续费，当前订阅周期仍可使用' };
            }
            if (result?.ok && result.data?.cancelled === true) submitted = true;
            if (result?.statusCode === 401 || result?.statusCode === 403) break;
        } catch (_) {
            // Do not leak tokens, proxy credentials, or arbitrary upstream errors
            // into the public task message. A later attempt may recover.
        }
    }

    return submitted
        ? { state: 'pending', message: '取消自动续费请求已提交，但尚未确认关闭，请联系管理员核实；请勿重复充值' }
        : { state: 'failed', message: '自动续费未能确认关闭，请联系管理员手动处理；请勿重复充值' };
}

module.exports = { cancelRenewalAfterActivation };
