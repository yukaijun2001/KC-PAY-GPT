'use strict';

const { extractProfileFromToken } = require('../browser/session-auth');

const CHATGPT_ORIGIN = 'https://chatgpt.com';

function positiveTimeout(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : fallback;
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

    return page.evaluate(async ({ accessToken, payload, tokenAccountId, sentinelInitTimeoutMs, sentinelTimeoutMs, requestTimeoutMs }) => {
        if (location.origin !== 'https://chatgpt.com') {
            throw new Error('Checkout API 页面已离开 https://chatgpt.com');
        }

        // 不依赖 loader 私有队列或固定版本 URL。观察公开 SDK 引用的交接，
        // 旧 init/token pending 不能阻塞已经可用的新实现。
        const sentinel = await new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const initDeadline = startedAt + sentinelInitTimeoutMs;
            const initializations = [];
            const implementations = [];
            let tokenStartedAt = null;
            let tokenDeadline = null;
            let stage = 'load';
            let timer;
            let stopped = false;
            let seenSdk = false;
            let script;
            let scriptFailed = false;
            let scriptLoaded = false;

            const finish = (message, token) => {
                if (stopped) return;
                stopped = true;
                clearTimeout(timer);
                if (script) {
                    script.onload = null;
                    script.onerror = null;
                    if (message) script.remove?.(); // 仅移除本次创建的脚本。
                }
                const now = Date.now();
                if (message) {
                    reject(new Error(`${message} (stage=${stage}, elapsed_ms=${now - startedAt})`));
                } else {
                    resolve({ token, timings: {
                        initMs: tokenStartedAt - startedAt,
                        tokenMs: now - tokenStartedAt,
                        handoffs: Math.max(0, implementations.length - 1)
                    } });
                }
            };
            const schedule = (delay = 0) => {
                if (stopped) return;
                clearTimeout(timer);
                timer = setTimeout(tick, delay);
            };
            // 迟到的第三方 Promise 无法取消，但只更新已停止的本地记录；
            // 不再调用 token，也不会继续到 Checkout fetch。
            const invoke = (entry, method, state) => {
                entry[state] = 'pending';
                try {
                    Promise.resolve(method.call(entry.sdk, 'chatgpt_checkout')).then(value => {
                        if (stopped) return;
                        entry[state] = 'fulfilled';
                        if (state === 'tokenState') entry.value = value;
                        schedule();
                    }, () => {
                        if (stopped) return;
                        entry[state] = 'rejected';
                        schedule();
                    });
                } catch (_) {
                    entry[state] = 'rejected';
                }
            };
            function tick() {
                if (stopped) return;
                clearTimeout(timer);
                const deadline = tokenDeadline ?? initDeadline;
                if (Date.now() >= deadline) {
                    finish('Sentinel SDK 等待超时');
                    return;
                }
                if (scriptFailed) {
                    stage = 'load';
                    finish('Sentinel SDK 加载失败');
                    return;
                }
                const sdk = window.SentinelSDK;
                const init = sdk?.init;
                const token = sdk?.token;
                if (typeof token !== 'function') {
                    stage = scriptLoaded || seenSdk ? 'ready' : 'load';
                    const existingScript = document.querySelector?.('script[src="/backend-api/sentinel/sdk.js"], script[src="https://chatgpt.com/backend-api/sentinel/sdk.js"]');
                    if (!script && !seenSdk && !existingScript) {
                        script = document.createElement('script');
                        script.src = '/backend-api/sentinel/sdk.js';
                        script.async = true;
                        script.onload = () => { scriptLoaded = true; schedule(); };
                        script.onerror = () => { scriptFailed = true; schedule(); };
                        try { document.head.appendChild(script); } catch (_) { scriptFailed = true; }
                    }
                } else {
                    seenSdk = true;
                    let initialization = initializations.find(item => item.sdk === sdk && item.init === init);
                    if (!initialization) {
                        initialization = { sdk, init, initialToken: token, initState: 'new', handedOff: false };
                        initializations.push(initialization);
                    }
                    let entry = implementations.find(item => item.sdk === sdk && item.token === token);
                    if (!entry) {
                        entry = { sdk, token, tokenState: 'new' };
                        implementations.push(entry);
                    }
                    stage = 'init';
                    // init 可能原位安装 token，不能因 token 换了引用重复 init。
                    if (initialization.initState === 'new') {
                        if (typeof init === 'function') invoke(initialization, init, 'initState');
                        else initialization.initState = 'fulfilled';
                    }
                    // loader 的 init 本身也可能一直 pending；token 原位交接后
                    // 使用新函数，不再被旧 init 卡住或被其迟到 rejection 推翻。
                    if (initialization.initialToken !== token) initialization.handedOff = true;
                    if (initialization.initState === 'rejected' && !initialization.handedOff) {
                        finish('Sentinel SDK 初始化失败');
                        return;
                    }
                    if (initialization.initState === 'fulfilled' || initialization.handedOff) {
                        stage = 'token';
                        if (entry.tokenState === 'new') {
                            // 只分配一次 token 预算；SDK 多次交接不延长 deadline。
                            if (tokenDeadline === null) {
                                tokenStartedAt = Date.now();
                                tokenDeadline = tokenStartedAt + sentinelTimeoutMs;
                            }
                            invoke(entry, token, 'tokenState');
                        }
                        if (entry.tokenState === 'rejected') {
                            finish('Sentinel SDK 获取 token 失败');
                            return;
                        }
                        if (entry.tokenState === 'fulfilled') {
                            let value;
                            try {
                                value = typeof entry.value === 'string' ? entry.value.trim()
                                    : entry.value && JSON.stringify(entry.value);
                            } catch (_) { /* invalid SDK result */ }
                            if (!value || value === '{}' || value === 'null') finish('Sentinel SDK 返回空 token');
                            else finish(null, value);
                            return;
                        }
                    }
                }
                schedule(Math.min(25, Math.max(0, (tokenDeadline ?? initDeadline) - Date.now())));
            }
            tick();
        });
        const sentinelToken = sentinel.token;

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
            sentinelTimings: sentinel.timings,
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
        sentinelInitTimeoutMs: positiveTimeout(process.env.CHECKOUT_SENTINEL_INIT_TIMEOUT_MS, 30000),
        sentinelTimeoutMs: positiveTimeout(process.env.CHECKOUT_SENTINEL_TIMEOUT_MS, 30000),
        requestTimeoutMs: positiveTimeout(process.env.CHECKOUT_API_TIMEOUT_MS, 30000)
    });
}

module.exports = { requestBrowserCheckout };
