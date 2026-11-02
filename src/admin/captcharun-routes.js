'use strict';

const express = require('express');
const captcharun = require('../integrations/captcharun-account');

// Mount behind /api/admin authentication. This router never creates solve tasks.
function createCaptcharunRouter({ store, ensureStoreReady }) {
    const router = express.Router();
    const route = (handler) => async (req, res) => {
        try {
            await ensureStoreReady();
            await handler(req, res);
        } catch (error) {
            const invalid = error?.code === 'CAPTCHARUN_INVALID_CONFIG';
            res.status(invalid ? 400 : 500).json({
                success: false,
                message: invalid ? error.message : 'CaptchaRun 配置操作失败，请检查数据库连接后重试'
            });
        }
    };

    router.get('/', route(async (_, res) => {
        const config = captcharun.publicConfig(await captcharun.loadConfig(store));
        res.json({ success: true, config });
    }));

    router.put('/', route(async (req, res) => {
        const config = await captcharun.saveConfig(store, req.body);
        res.json({ success: true, message: 'CaptchaRun 账户配置已保存', config });
    }));

    router.post('/test', route(async (req, res) => {
        const saved = await captcharun.loadConfig(store);
        const config = captcharun.mergeConfig(saved, req.body);
        const result = await captcharun.queryWallet(config);
        res.status(result.ok ? 200 : 400).json({ success: result.ok, ...result });
    }));

    return router;
}

module.exports = { createCaptcharunRouter };
