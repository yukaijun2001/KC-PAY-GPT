'use strict';

/**
 * 自检：验证有头 Chromium 是否对外呈现为 Windows 桌面 Chrome。
 * 用法：node scripts/verify-windows-fingerprint.js
 */

const http = require('http');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const {
    buildWindowsProfile,
    buildWindowsContextOptions,
    applyWindowsFingerprint
} = require('../src/browser/windows-fingerprint');

chromium.use(StealthPlugin());

function startEchoServer() {
    const captured = [];
    const server = http.createServer((req, res) => {
        captured.push({ url: req.url, headers: { ...req.headers } });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>probe</title></head><body>probe</body></html>');
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, captured, port: server.address().port });
        });
    });
}

async function main() {
    const profile = buildWindowsProfile({ locale: 'en-US' });
    const { server, captured, port } = await startEchoServer();
    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', ...profile.launchArgs]
    });

    let failures = 0;
    try {
        const context = await browser.newContext(buildWindowsContextOptions(profile, {
            locale: 'en-US',
            timezoneId: 'America/New_York'
        }));
        await applyWindowsFingerprint(context, profile);

        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(600);

        const probe = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl');
            const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
            const uaData = navigator.userAgentData;
            return {
                userAgent: navigator.userAgent,
                appVersion: navigator.appVersion,
                platform: navigator.platform,
                languages: navigator.languages,
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: navigator.deviceMemory,
                maxTouchPoints: navigator.maxTouchPoints,
                webdriver: navigator.webdriver,
                uaPlatform: uaData ? uaData.platform : null,
                uaBrands: uaData ? uaData.brands.map((b) => `${b.brand}:${b.version}`) : null,
                webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
                webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
                segoeUi: document.fonts.check('12px "Segoe UI"'),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                screen: `${screen.width}x${screen.height}`
            };
        });
        const highEntropy = await page.evaluate(async () => {
            if (!navigator.userAgentData) return null;
            const v = await navigator.userAgentData.getHighEntropyValues([
                'platformVersion', 'architecture', 'bitness', 'uaFullVersion', 'fullVersionList'
            ]);
            return { platform: v.platform, platformVersion: v.platformVersion, architecture: v.architecture, bitness: v.bitness, uaFullVersion: v.uaFullVersion };
        });

        const sent = captured.find((c) => c.url === '/') || { headers: {} };
        const report = {
            'JS navigator.userAgent': probe.userAgent,
            'JS navigator.platform': probe.platform,
            'JS userAgentData.platform': probe.uaPlatform,
            'JS userAgentData.brands': probe.uaBrands,
            'JS high-entropy': highEntropy,
            'JS WebGL vendor': probe.webglVendor,
            'JS WebGL renderer': probe.webglRenderer,
            'JS Segoe UI available': probe.segoeUi,
            'JS hardwareConcurrency': probe.hardwareConcurrency,
            'JS deviceMemory': probe.deviceMemory,
            'JS timezone': probe.timezone,
            'JS screen': probe.screen,
            'JS webdriver': probe.webdriver,
            'HTTP User-Agent': sent.headers['user-agent'],
            'HTTP sec-ch-ua': sent.headers['sec-ch-ua'],
            'HTTP sec-ch-ua-platform': sent.headers['sec-ch-ua-platform'],
            'HTTP sec-ch-ua-platform-version': sent.headers['sec-ch-ua-platform-version']
        };
        for (const [key, value] of Object.entries(report)) {
            console.log(`${key.padEnd(34)} = ${JSON.stringify(value)}`);
        }

        const checks = [
            ['UA 含 Windows NT 10.0', /Windows NT 10\.0/.test(probe.userAgent)],
            ['UA 不含 Macintosh', !/Macintosh|Mac OS X/i.test(probe.userAgent)],
            ['navigator.platform = Win32', probe.platform === 'Win32'],
            ['userAgentData.platform = Windows', probe.uaPlatform === 'Windows'],
            ['HTTP sec-ch-ua-platform = "Windows"', String(sent.headers['sec-ch-ua-platform'] || '').includes('Windows')],
            ['WebGL 不含 Apple', !/Apple/i.test(String(probe.webglVendor) + String(probe.webglRenderer))],
            ['webdriver 不可见', probe.webdriver !== true]
        ];
        console.log('\n--- 断言 ---');
        for (const [name, ok] of checks) {
            console.log(`${ok ? '✅' : '❌'} ${name}`);
            if (!ok) failures += 1;
        }
        await context.close();
    } finally {
        await browser.close().catch(() => {});
        server.close();
    }

    console.log(failures === 0 ? '\n全部通过：对外就是 Windows 桌面 Chrome。' : `\n${failures} 项不通过。`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
