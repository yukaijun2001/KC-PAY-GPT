'use strict';

/**
 * Windows 平台伪装层。
 *
 * 目标：有头 Chromium 无论跑在 macOS 还是 Linux 上，对外都表现成
 * 「Windows 10/11 + 桌面版 Chrome」。三层必须一致，否则任一层的矛盾都会被抓：
 *   1. 网络层：User-Agent + sec-ch-ua-platform（由 Playwright userAgentMetadata 生成）
 *   2. JS 层：navigator.platform / userAgentData / 硬件并发 / WebGL 厂商渲染器 / 字体
 *   3. 进程层：启动参数 --lang / --user-agent，保证首屏与 DevTools 也是 Windows
 */

const DEFAULT_MAJOR = 147;
const DEFAULT_PLATFORM_VERSION = '10.0.0';
const DEFAULT_WEBGL_VENDOR = 'Google Inc. (Intel)';
const DEFAULT_WEBGL_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const DEFAULT_FONTS = [
    'Segoe UI',
    'Calibri',
    'Cambria',
    'Consolas',
    'Tahoma',
    'Microsoft Sans Serif',
    'Microsoft YaHei',
    'SimSun'
];

function isWindowsFingerprintEnabled(env = process.env) {
    return String(env.WINDOWS_FINGERPRINT ?? '1') !== '0';
}

function parseMajor(version) {
    const match = String(version || '').match(/(\d+)/);
    return match ? Number(match[1]) : 0;
}

function buildBrands(major) {
    return [
        { brand: 'Chromium', version: String(major) },
        { brand: 'Not=A?Brand', version: '24' },
        { brand: 'Google Chrome', version: String(major) }
    ];
}

function buildLanguages(locale) {
    const primary = String(locale || 'en-US').trim() || 'en-US';
    const base = primary.split('-')[0];
    return base && base !== primary ? [primary, base] : [primary];
}

/**
 * 生成一份 Windows 指纹配置。browserVersion 传 browser.version()，
 * 让 UA 里的主版本号和真实内核一致（避免 UA 与 sec-ch-ua 打架）。
 */
function buildWindowsProfile(options = {}) {
    const env = options.env || process.env;
    const browserVersion = String(options.browserVersion || '').trim();
    const envMajor = Number(env.WINDOWS_UA_CHROME_MAJOR || 0);
    const major = Math.max(1, Math.min(999, envMajor || parseMajor(browserVersion) || DEFAULT_MAJOR));
    const fullVersion = /^\d+\.\d+\.\d+\.\d+$/.test(browserVersion)
        ? browserVersion
        : `${major}.0.0.0`;
    const platformVersion = String(env.WINDOWS_PLATFORM_VERSION || DEFAULT_PLATFORM_VERSION).trim();
    const locale = String(options.locale || 'en-US').trim() || 'en-US';
    const hardwareConcurrency = Number(env.WINDOWS_HARDWARE_CONCURRENCY || 8) || 8;
    const deviceMemory = Number(env.WINDOWS_DEVICE_MEMORY || 8) || 8;

    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    const brands = buildBrands(major);

    // Linux 服务器（Docker + Xvfb）额外启动参数：
    // - 容器 /dev/shm 太小会让 Chromium 崩，必须关闭
    // - WebRTC 默认会泄露宿主机/容器内网 IP（172.17.x），伪装成 Windows 后这是致命的
    const linuxArgs = ['--disable-dev-shm-usage'];
    if (String(env.WINDOWS_FINGERPRINT_WEBRTC ?? '1') !== '0') {
        linuxArgs.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    }

    return {
        enabled: true,
        platform: 'Windows',
        platformVersion,
        major,
        fullVersion,
        userAgent,
        brands,
        locale,
        languages: buildLanguages(locale),
        hardwareConcurrency,
        deviceMemory,
        webglVendor: String(env.WINDOWS_WEBGL_VENDOR || DEFAULT_WEBGL_VENDOR),
        webglRenderer: String(env.WINDOWS_WEBGL_RENDERER || DEFAULT_WEBGL_RENDERER),
        fonts: String(env.WINDOWS_FONT_PROBE || '').trim()
            ? String(env.WINDOWS_FONT_PROBE).split(',').map((s) => s.trim()).filter(Boolean)
            : DEFAULT_FONTS,
        launchArgs: ['--lang=en-US', '--accept-lang=en-US,en', `--user-agent=${userAgent}`],
        linuxArgs,
        launchOptions: {
            userAgent,
            locale,
            viewport: { width: 1920, height: 1080 },
            screen: { width: 1920, height: 1080 }
        }
    };
}

/**
 * 注入到每个 frame 的初始化脚本：只覆盖平台相关字段，其余保持浏览器原生行为。
 */
function installWindowsFingerprint(profile) {
    const mask = (fn, name) => {
        try {
            Object.defineProperty(fn, 'toString', {
                value: () => `function ${name}() { [native code] }`,
                configurable: true
            });
        } catch (_) { /* ignore */ }
        return fn;
    };

    const patchGetter = (proto, prop, value) => {
        if (!proto) {
            return;
        }
        try {
            const desc = Object.getOwnPropertyDescriptor(proto, prop);
            Object.defineProperty(proto, prop, {
                get: mask(() => value, `get ${prop}`),
                set: desc && desc.set ? desc.set : undefined,
                enumerable: desc ? desc.enumerable : true,
                configurable: true
            });
        } catch (_) { /* ignore */ }
    };

    const nav = window.navigator;
    const appVersion = String(profile.userAgent).replace(/^Mozilla\//, '');

    patchGetter(Object.getPrototypeOf(nav), 'userAgent', profile.userAgent);
    patchGetter(Object.getPrototypeOf(nav), 'appVersion', appVersion);
    patchGetter(Object.getPrototypeOf(nav), 'platform', 'Win32');
    patchGetter(Object.getPrototypeOf(nav), 'hardwareConcurrency', profile.hardwareConcurrency);
    patchGetter(Object.getPrototypeOf(nav), 'deviceMemory', profile.deviceMemory);
    patchGetter(Object.getPrototypeOf(nav), 'maxTouchPoints', 0);

    // navigator.userAgentData：brands / platform 必须与 UA 对齐
    try {
        const native = nav.userAgentData;
        if (native) {
            const proto = Object.getPrototypeOf(native);
            const fake = Object.create(proto);
            const brandList = profile.brands.map((b) => ({ brand: b.brand, version: b.version }));
            Object.defineProperty(fake, 'brands', { value: brandList, enumerable: true, configurable: true });
            Object.defineProperty(fake, 'mobile', { value: false, enumerable: true, configurable: true });
            Object.defineProperty(fake, 'platform', { value: 'Windows', enumerable: true, configurable: true });
            fake.getHighEntropyValues = mask((hints) => Promise.resolve({
                brands: brandList,
                fullVersionList: profile.brands.map((b) => ({
                    brand: b.brand,
                    version: b.brand === 'Google Chrome' || b.brand === 'Chromium'
                        ? profile.fullVersion
                        : b.version
                })),
                mobile: false,
                model: '',
                platform: 'Windows',
                platformVersion: profile.platformVersion,
                architecture: 'x86',
                bitness: '64',
                wow64: false,
                uaFullVersion: profile.fullVersion,
                ...(Array.isArray(hints) ? {} : {})
            }), 'getHighEntropyValues');
            fake.toJSON = mask(() => ({
                brands: brandList,
                mobile: false,
                platform: 'Windows'
            }), 'toJSON');
            Object.defineProperty(Object.getPrototypeOf(nav), 'userAgentData', {
                get: mask(() => fake, 'get userAgentData'),
                enumerable: true,
                configurable: true
            });
        }
    } catch (_) { /* ignore */ }

    // WebGL：macOS 会暴露 Apple GPU，必须换成 Windows 上最常见的 Intel 核显
    const patchGL = (proto) => {
        if (!proto || !proto.getParameter) {
            return;
        }
        const original = proto.getParameter;
        proto.getParameter = mask(function getParameter(parameter) {
            if (parameter === 37445) { // UNMASKED_VENDOR_WEBGL
                return profile.webglVendor;
            }
            if (parameter === 37446) { // UNMASKED_RENDERER_WEBGL
                return profile.webglRenderer;
            }
            return original.call(this, parameter);
        }, 'getParameter');
    };
    patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);

    // 字体探测：让 Windows 自带字体在 document.fonts.check 中显示为可用
    try {
        const fonts = document.fonts;
        if (fonts && typeof fonts.check === 'function') {
            const originalCheck = fonts.check.bind(fonts);
            const windowsFonts = profile.fonts.map((name) => String(name).toLowerCase());
            fonts.check = mask((font, text) => {
                const name = String(font || '').toLowerCase();
                if (windowsFonts.some((f) => name.includes(f))) {
                    return true;
                }
                return originalCheck(font, text);
            }, 'check');
        }
    } catch (_) { /* ignore */ }

    // 容器里通常没有任何音视频设备，Windows 桌面却有默认扬声器/麦克风。
    // 只在原生返回空列表时补默认设备，避免覆盖真实环境。
    try {
        const mediaDevices = nav.mediaDevices;
        if (mediaDevices && typeof mediaDevices.enumerateDevices === 'function') {
            const originalEnumerate = mediaDevices.enumerateDevices.bind(mediaDevices);
            mediaDevices.enumerateDevices = mask(async () => {
                const devices = await originalEnumerate();
                if (Array.isArray(devices) && devices.length > 0) {
                    return devices;
                }
                return [
                    { deviceId: 'default', kind: 'audioinput', label: 'Microphone (Realtek(R) Audio)', groupId: 'default', toJSON() { return this; } },
                    { deviceId: 'default', kind: 'audiooutput', label: 'Speakers (Realtek(R) Audio)', groupId: 'default', toJSON() { return this; } },
                    { deviceId: 'default', kind: 'videoinput', label: 'Integrated Camera', groupId: 'default', toJSON() { return this; } }
                ];
            }, 'enumerateDevices');
        }
    } catch (_) { /* ignore */ }
}

/**
 * 把 Windows 指纹挂到 Playwright BrowserContext 上（必须在任何导航之前调用）。
 *
 * 注意：puppeteer-extra-plugin-stealth 在自己的 init script 里也会改
 * navigator.hardwareConcurrency / WebGL vendor，而且它是页面创建时才注入、
 * 排在 context 脚本之后。所以这里额外包一层 context.newPage，
 * 在页面级再注入一次，靠“后注册后执行”把值抢回来。
 * @param {import('playwright').BrowserContext} context
 * @param {ReturnType<typeof buildWindowsProfile>} profile
 */
async function applyWindowsFingerprint(context, profile) {
    if (!context || !profile || profile.enabled === false) {
        return;
    }
    await context.addInitScript(installWindowsFingerprint, profile);

    if (!context.__windowsFingerprintPatched) {
        const originalNewPage = context.newPage.bind(context);
        context.newPage = async function newPageWithWindowsFingerprint(...args) {
            const page = await originalNewPage(...args);
            await page.addInitScript(installWindowsFingerprint, profile).catch(() => {});
            return page;
        };
        context.on('page', (page) => {
            page.addInitScript(installWindowsFingerprint, profile).catch(() => {});
        });
        Object.defineProperty(context, '__windowsFingerprintPatched', {
            value: true,
            enumerable: false,
            configurable: true
        });
    }
}

/**
 * 每次建 context 时的标准选项，保证 UA 与 viewport 一致。
 */
function buildWindowsContextOptions(profile, extra = {}) {
    return {
        userAgent: profile.userAgent,
        viewport: { width: 1920, height: 1080 },
        screen: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        ...extra
    };
}

module.exports = {
    WINDOWS_USER_AGENT: buildWindowsProfile().userAgent,
    isWindowsFingerprintEnabled,
    buildWindowsProfile,
    buildWindowsContextOptions,
    applyWindowsFingerprint,
    installWindowsFingerprint
};
