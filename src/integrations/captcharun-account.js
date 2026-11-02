'use strict';

// CaptchaRun account API only. Credentials are never passed to the legacy
// createTask/getTaskResult provider autodetection or payment challenge handlers.
const axios = require('axios');

const API_BASE = 'https://api.captcha-run.com';
const WALLET_PATH = '/v2/users/self/wallet';
const CONFIG_KEY = 'captcharun_account';
const DEFAULT_TIMEOUT_SEC = 20;

function invalidConfig(message) {
    const error = new Error(message);
    error.code = 'CAPTCHARUN_INVALID_CONFIG';
    return error;
}

function normalizeToken(value) {
    if (typeof value !== 'string') throw invalidConfig('CaptchaRun Token 必须是字符串');
    const token = value.trim().replace(/^Bearer\s+/i, '');
    if (token.length > 4096 || (token && !/^[\x21-\x7e]+$/.test(token))) {
        throw invalidConfig('CaptchaRun Token 格式无效，请检查空格或换行');
    }
    return token;
}

function normalizeTimeout(value) {
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw invalidConfig('CaptchaRun 超时须为 5–120 秒的整数');
    }
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120) {
        throw invalidConfig('CaptchaRun 超时须为 5–120 秒的整数');
    }
    return seconds;
}

async function loadConfig(store, env = process.env) {
    const raw = await store.getAppConfigValue(CONFIG_KEY, '');
    let saved = {};
    if (raw) {
        try {
            saved = JSON.parse(raw);
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error();
        } catch (_) {
            throw invalidConfig('CaptchaRun 已保存配置损坏，请检查 app_config 中的 captcharun_account');
        }
    }
    const hasStoredToken = Object.hasOwn(saved, 'api_token');
    const apiToken = normalizeToken(hasStoredToken ? saved.api_token : (env.CAPTCHARUN_API_TOKEN || ''));
    return {
        api_token: apiToken,
        timeout_sec: normalizeTimeout(saved.timeout_sec ?? (env.CAPTCHARUN_TIMEOUT_SEC || DEFAULT_TIMEOUT_SEC)),
        token_source: apiToken ? (hasStoredToken ? 'database' : 'environment') : 'none',
        stored_token_present: hasStoredToken
    };
}

function mergeConfig(saved, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw invalidConfig('CaptchaRun 配置必须是对象');
    }
    if (Object.hasOwn(input, 'clear_token') && typeof input.clear_token !== 'boolean') {
        throw invalidConfig('清除 Token 参数必须是布尔值');
    }
    const token = Object.hasOwn(input, 'api_token') ? normalizeToken(input.api_token) : '';
    if (input.clear_token && token) throw invalidConfig('更新和清除 Token 不能同时进行');
    return {
        api_token: input.clear_token ? '' : (token || saved.api_token),
        timeout_sec: Object.hasOwn(input, 'timeout_sec') ? normalizeTimeout(input.timeout_sec) : saved.timeout_sec
    };
}

function publicConfig(config) {
    return {
        api_url: API_BASE,
        timeout_sec: config.timeout_sec,
        api_token_saved: Boolean(config.api_token),
        token_source: config.token_source || (config.api_token ? 'database' : 'none')
    };
}

async function saveConfig(store, input, env = process.env) {
    const saved = await loadConfig(store, env);
    const config = mergeConfig(saved, input);
    const persistToken = Boolean(input.clear_token || input.api_token?.trim() || saved.stored_token_present);
    const record = { timeout_sec: config.timeout_sec };
    // Preserve environment fallback unless the token was explicitly set or
    // cleared. An explicitly stored empty string overrides the environment.
    if (persistToken) record.api_token = config.api_token;
    await store.setAppConfigValue(CONFIG_KEY, JSON.stringify(record));
    return publicConfig(await loadConfig(store, env));
}

function parseWallet(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.success === false || data.error) return null;
    const wallet = {};
    for (const field of ['balance', 'credit', 'cumulativeRecharge', 'share']) {
        const value = data[field];
        if (value == null && field !== 'balance') {
            wallet[field] = null;
            continue;
        }
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const decimal = String(value);
        if (decimal.length > 256 || !/^-?\d+(?:\.\d+)?$/.test(decimal)) return null;
        wallet[field] = decimal;
    }
    return wallet;
}

async function queryWallet(config) {
    const apiToken = normalizeToken(config.api_token || '');
    const timeout = normalizeTimeout(config.timeout_sec ?? DEFAULT_TIMEOUT_SEC);
    if (!apiToken) return { ok: false, message: '请先填写 CaptchaRun API Token' };
    const started = Date.now();
    const result = (value) => ({ ...value, latency_ms: Math.max(0, Date.now() - started) });
    try {
        const response = await axios.request({
            method: 'GET',
            url: `${API_BASE}${WALLET_PATH}`,
            headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
            timeout: timeout * 1000,
            // Do not forward a Bearer credential to a redirected host.
            maxRedirects: 0,
            maxContentLength: 64 * 1024,
            validateStatus: () => true
        });
        const status = response.status;
        if (status < 200 || status >= 300) {
            const reason = status === 401 || status === 403
                ? 'Token 无效或无账户访问权限'
                : status === 429 ? '请求过于频繁，请稍后重试'
                    : status >= 300 && status < 400 ? '上游返回重定向，已停止发送凭据'
                        : '上游服务请求失败';
            return result({ ok: false, status, message: `CaptchaRun ${reason}（HTTP ${status}）` });
        }
        let data = response.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (_) { data = null; }
        }
        const wallet = parseWallet(data);
        if (!wallet) return result({ ok: false, status, message: 'CaptchaRun 返回的余额数据格式无效' });
        return result({ ok: true, status, message: 'CaptchaRun 账户连接正常，余额已获取', wallet });
    } catch (error) {
        const timedOut = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
        // No upstream body, Axios config, or raw error text is returned: they can contain the token.
        return result({ ok: false, message: timedOut ? 'CaptchaRun 请求超时，请稍后重试' : 'CaptchaRun 网络请求失败，请检查服务连通性' });
    }
}

module.exports = {
    API_BASE, WALLET_PATH, CONFIG_KEY, DEFAULT_TIMEOUT_SEC,
    loadConfig, mergeConfig, publicConfig, saveConfig, queryWallet
};
