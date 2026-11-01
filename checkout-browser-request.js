'use strict';

const { extractProfileFromToken } = require('./session-auth');

const CHATGPT_ORIGIN = 'https://chatgpt.com';

function positiveTimeout(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 在已登录页面内调用站点 SDK 和 Checkout API。
 * SDK token 不缓存、不导出；请求沿用该页面的 Cookie、代理与浏览器网络栈。
 */
async function requestBrowserCheckout(page, { accessToken, payload }) {
    if (new URL(page.url()).origin !== CHATGPT_ORIGIN) {
        throw new Error('Checkout API 需要已登录的 https://chatgpt.com 页面');
    }

    const tokenAccountId = extractProfileFromToken(accessToken).accountId;

    return page.evaluate(async ({ accessToken, payload, tokenAccountId, sentinelTimeoutMs, requestTimeoutMs }) => {
        if (location.origin !== 'https://chatgpt.com') {
            throw new Error('Checkout API 页面已离开 https://chatgpt.com');
        }

        const withTimeout = async (operation, timeoutMs, message) => {
            let timer;
            try {
                return await Promise.race([
                    Promise.resolve().then(operation),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
                    })
                ]);
            } finally {
                clearTimeout(timer);
            }
        };

        const sentinelToken = await withTimeout(async () => {
            if (typeof window.SentinelSDK?.token !== 'function') {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = '/backend-api/sentinel/sdk.js';
                    script.async = true;
                    script.onload = resolve;
                    script.onerror = () => reject(new Error('Sentinel SDK 加载失败'));
                    document.head.appendChild(script);
                });
            }
            const sdk = window.SentinelSDK;
            if (typeof sdk?.token !== 'function') {
                throw new Error('Sentinel SDK 不可用');
            }
            if (typeof sdk.init === 'function') {
                await sdk.init('chatgpt_checkout');
            }
            // SDK loader 的 init 会在脚本加载后替换 window.SentinelSDK 对象。
            // 不能保留 loader 的旧 token stub，否则后续调用会永远排队。
            const result = await window.SentinelSDK.token('chatgpt_checkout');
            const token = typeof result === 'string' ? result.trim() : result && JSON.stringify(result);
            if (!token || token === '{}' || token === 'null') {
                throw new Error('Sentinel SDK 返回空 token');
            }
            return token;
        }, sentinelTimeoutMs, 'Sentinel SDK 获取 token 超时');

        const headers = {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'openai-sentinel-token': sentinelToken,
            'oai-language': navigator.language || 'en-US'
        };

        // 只使用当前会话的标识，不生成随机 device/account ID。
        let bootstrap = {};
        try {
            const parsed = JSON.parse(document.getElementById('client-bootstrap')?.textContent || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bootstrap = parsed;
        } catch (_) { /* optional bootstrap */ }
        const deviceCookie = document.cookie.split(';').map((item) => item.trim())
            .find((item) => item.startsWith('oai-did='));
        let deviceId = bootstrap.statsigContext?.deviceId;
        let cookieDeviceId = '';
        if (deviceCookie) {
            try {
                cookieDeviceId = decodeURIComponent(deviceCookie.slice('oai-did='.length));
                if (cookieDeviceId) deviceId = cookieDeviceId;
            } catch (_) { /* optional cookie */ }
        }
        const validAccountId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
        const candidate = [
            ['page', bootstrap.session?.account?.id],
            ['session', window.__CHATGPT_BOOTSTRAP_SESSION__?.account?.id],
            ['token', tokenAccountId]
        ].find(([, value]) => validAccountId(value));
        const accountId = candidate?.[1];
        if (deviceId) headers['oai-device-id'] = deviceId;
        if (cookieDeviceId) headers['oai-did'] = cookieDeviceId;
        if (accountId) headers['chatgpt-account-id'] = accountId;

        let sentinelData = null;
        try { sentinelData = JSON.parse(sentinelToken); } catch (_) { /* SDK may return an opaque value */ }
        const sentinelFlow = typeof sentinelData?.flow === 'string'
            ? (sentinelData.flow === 'chatgpt_checkout' ? 'match' : 'different')
            : 'unknown';
        const diagnostics = {
            accountSource: candidate?.[0] || 'none',
            accountMatchesToken: accountId && validAccountId(tokenAccountId) ? accountId === tokenAccountId : null,
            deviceHeaderPresent: Boolean(deviceId),
            cookieDidPresent: Boolean(cookieDeviceId),
            sentinelFlow,
            sentinelDeviceMatches: typeof sentinelData?.id === 'string' && cookieDeviceId
                ? sentinelData.id === cookieDeviceId : null
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            const response = await fetch('/backend-api/payments/checkout', {
                method: 'POST',
                credentials: 'include',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            return { status: response.status, bodyText: await response.text(), diagnostics };
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error('Checkout API 请求超时（API 未重发；auto 模式将尝试 UI）');
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }, {
        accessToken,
        payload,
        tokenAccountId,
        sentinelTimeoutMs: positiveTimeout(process.env.CHECKOUT_SENTINEL_TIMEOUT_MS, 15000),
        requestTimeoutMs: positiveTimeout(process.env.CHECKOUT_API_TIMEOUT_MS, 30000)
    });
}

module.exports = { requestBrowserCheckout };
