'use strict';

const { getRegionConfig } = require('../config/region-config');
const { normalizePlanType } = require('../config/plans');
const { assertChatGptLoggedIn } = require('../browser/session-auth');
const { clearHumanVerification } = require('../captcha/human-verification');
const { resolvePlanName } = require('../persistence/mysql-store');

const PRICING_URL = 'https://chatgpt.com/#pricing';

const REGION_UI_LABELS = {
    PH: ['菲律宾', 'Philippines', 'Pilipinas'],
    US: ['美国', 'United States'],
    SG: ['新加坡', 'Singapore'],
    MY: ['马来西亚', 'Malaysia'],
    EG: ['埃及', 'Egypt', 'مصر']
};

const REGION_CURRENCY_HINTS = {
    PH: ['₱'],
    US: ['$20', '$ 20'],
    SG: ['S$', 'SGD'],
    MY: ['RM', 'MYR'],
    EG: ['EGP', 'E£', 'ج.م']
};

const REGION_PRICE_PATTERNS = {
    PH: [/₱\s*[\d,.]+/, /[\d,.]+\s*₱/],
    US: [/\$\s*20(?:\.00)?/, /USD\s*20/i, /\$\s*[\d,.]+(?:\s*\/)?\s*(?:month|mo)/i],
    SG: [/S\$\s*[\d,.]+/, /[\d,.]+\s*SGD/i],
    MY: [/RM\s*[\d,.]+/, /[\d,.]+\s*MYR/i],
    EG: [/\bEGP[\s\u200e\u200f]*[\d٠-٩]/i, /[\d٠-٩][\d٠-٩,.٬٫\s]*\s*EGP\b/i,
        /E£\s*[\d٠-٩]/i, /[\d٠-٩][\d٠-٩,.٬٫\s]*\s*E£/i,
        /ج\.\s*م\.?[\s\u200e\u200f]*[\d٠-٩]/, /[\d٠-٩][\d٠-٩,.٬٫\s]*\s*ج\.\s*م\.?/]
};

const REGION_WRONG_CURRENCY = {
    PH: [/£\s*[\d,.]+/, /[\d,.]+\s*£/, /\bGBP\b/i, /United Kingdom/i, /Great Britain/i, /€\s*[\d,.]+/, /[\d,.]+\s*€/, /\bEUR\b/i],
    US: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /\bGBP\b/i, /\bPHP\b/i, /S\$\s*[\d,.]+/, /RM\s*[\d,.]+/],
    SG: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /\$\s*20(?:\.00)?\s*(?:USD|\/)/i, /RM\s*[\d,.]+/],
    MY: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /S\$\s*[\d,.]+/, /\$\s*20(?:\.00)?/],
    EG: [/(?:^|[^E])£\s*[\d,.]+/i, /\b(?:GBP|USD|EUR|PHP|SGD|MYR)\b/i,
        /₱\s*[\d,.]+/, /S\$\s*[\d,.]+/, /RM\s*[\d,.]+/, /€\s*[\d,.]+/,
        /\$\s*[1-9][\d,.]*/]
};

const REGION_CURRENT_COUNTRY_HINTS = {
    PH: [/菲律宾|Philippines|Pilipinas/i],
    US: [/United States|美国(?!地区)/i],
    SG: [/Singapore|新加坡/i],
    MY: [/Malaysia|马来西亚/i],
    EG: [/Egypt|埃及|مصر/i]
};

const SKIP_REGION_BUTTON_TEXT = /^(Upgrade|Personal|Business|Free|Plus|Pro|Subscribe|Close|Your current plan|升级|订阅|关闭)$/i;

function proUpgradePatterns(multiplier) {
    return [
        new RegExp(`升级(?:至|到)\\s*(?:ChatGPT\\s*)?Pro\\s*${multiplier}\\s*x\\b`, 'i'),
        new RegExp(`(?:Upgrade to|Get|Subscribe to)\\s*(?:ChatGPT\\s*)?Pro\\s*${multiplier}\\s*x\\b`, 'i')
    ];
}

const PLAN_UPGRADE_PATTERNS = {
    go: [/升级至\s*(?:ChatGPT\s*)?Go\b/i, /Upgrade to (?:ChatGPT\s*)?Go\b/i, /Get (?:ChatGPT\s*)?Go\b/i, /Subscribe to (?:ChatGPT\s*)?Go\b/i],
    plus: [/升级至\s*Plus/i, /Upgrade to Plus/i, /Get Plus/i, /Subscribe to Plus/i, /^Upgrade$/i],
    pro_10x: proUpgradePatterns(10),
    pro_20x: proUpgradePatterns(20),
    pro_50x: proUpgradePatterns(50)
};

const GO_UPGRADE_BUTTON = /升级至\s*(?:ChatGPT\s*)?Go\b|(?:Upgrade to|Get|Subscribe to)\s*(?:ChatGPT\s*)?Go\b/i;
const PRO_UPGRADE_BUTTON = /升级(?:至|到)\s*(?:ChatGPT\s*)?Pro\b|(?:Upgrade to|Get|Subscribe to)\s*(?:ChatGPT\s*)?Pro\b/i;
const PRO_GENERIC_UPGRADE_BUTTON = /^(?:升级(?:至|到)\s*(?:ChatGPT\s*)?Pro|(?:Upgrade to|Get|Subscribe to)\s*(?:ChatGPT\s*)?Pro)$/i;
const PRO_TIER_VALUES = Object.freeze({ pro_10x: '100', pro_20x: '200', pro_50x: '500' });
const PRO_TIER_LABEL = /^(?:100|200|500)$/;
const SEE_ALL_PLANS = /^(?:See all plans|View all plans|Show all plans|查看(?:全部|所有)套餐|显示(?:全部|所有)套餐|查看(?:全部|所有)方案)$/i;

function normalizeOptionText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function matchesCountryLabel(text, labels) {
    const normalized = normalizeOptionText(text).toLowerCase();
    return labels.some((label) => normalized === String(label).toLowerCase());
}

const PERSONAL_TAB_NAME = /^(?:Personal|个人|個人)$/i;
const BUSINESS_TAB_NAME = /^(?:Business|商业|商業|企业|企業)$/i;
const PERSONAL_PLAN_TITLE = /^(?:ChatGPT\s*)?(?:Plus|Go|Pro(?:\s*(?:10|20|50)\s*x)?)$/i;
const PERSONAL_UPGRADE_BUTTON = /(?:Upgrade to|Get|Subscribe to|升级(?:至|到))\s*(?:ChatGPT\s*)?(?:Plus|Go|Pro)\b/i;
const BUSINESS_UPGRADE_BUTTON = /(?:Upgrade to|Get|Subscribe to|升级(?:至|到))\s*(?:ChatGPT\s*)?Business\b/i;

async function hasVisibleMatch(locator) {
    for (let index = 0; index < await locator.count(); index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) return true;
    }
    return false;
}

async function isPlanTabSelected(tab) {
    return tab.evaluate(node => (
        ['aria-selected', 'aria-pressed', 'aria-checked'].some(attribute => node.getAttribute(attribute) === 'true')
        || ['active', 'on', 'checked'].includes(node.getAttribute('data-state'))
        || (node.tagName === 'INPUT' && node.checked === true)
    )).catch(() => false);
}

async function isBusinessTabActive(page) {
    const surface = await getPricingSurface(page);
    // A Business label/link is present on Personal pages too. Only selected
    // controls establish tab state; marketing copy must never veto Plus/Go/Pro.
    for (const role of ['tab', 'button', 'radio']) {
        const tabs = surface.getByRole(role, { name: BUSINESS_TAB_NAME });
        for (let index = 0; index < await tabs.count(); index += 1) {
            const tab = tabs.nth(index);
            if (await tab.isVisible().catch(() => false) && await isPlanTabSelected(tab)) return true;
        }
    }
    return false;
}

async function isPersonalPlanView(page) {
    if (await isBusinessTabActive(page)) return false;

    const surface = await getPricingSurface(page);
    if (await hasVisibleMatch(surface.getByRole('button', { name: PERSONAL_UPGRADE_BUTTON }))) return true;
    // Both compact "Plus" and legacy "ChatGPT Plus" cards are supported, as
    // are Go and Pro-only views. The selected Personal tab alone is not ready.
    return hasVisibleMatch(surface.getByText(PERSONAL_PLAN_TITLE));
}

async function isBusinessPlanView(page) {
    if (await isPersonalPlanView(page)) return false;
    if (await isBusinessTabActive(page)) return true;

    const surface = await getPricingSurface(page);
    return await hasVisibleMatch(surface.getByRole('heading', { name: /^(?:ChatGPT\s*)?Business$/i }))
        || await hasVisibleMatch(surface.getByRole('button', { name: BUSINESS_UPGRADE_BUTTON }));
}

/**
 * 定价页顶部 Personal / Business 切换（Plus/Pro 都在 Personal 下）
 */
async function switchToPersonalPlans(page, { timeout = 8000 } = {}) {
    if (await isPersonalPlanView(page)) {
        console.log('✅ [步骤] 已在个人套餐 (Personal) 视图');
        return;
    }

    if (await isBusinessTabActive(page)) {
        console.log('🔄 [步骤] 检测到 Business 标签，正在切换到 Personal...');
    } else {
        console.log('🔄 [步骤] 正在切换到「个人 / Personal」套餐...');
    }

    const surface = await getPricingSurface(page);
    const personalCandidates = [
        surface.getByRole('tab', { name: PERSONAL_TAB_NAME }),
        surface.getByRole('button', { name: PERSONAL_TAB_NAME }),
        surface.getByRole('radio', { name: PERSONAL_TAB_NAME }),
        surface.getByText(PERSONAL_TAB_NAME)
    ];

    let switchLocated = false;
    for (const candidates of personalCandidates) {
        for (let index = 0; index < await candidates.count(); index += 1) {
            try {
                const tab = candidates.nth(index);
                if (!await tab.isVisible()) continue;
                if (!await isPlanTabSelected(tab)) {
                    await tab.scrollIntoViewIfNeeded().catch(() => {});
                    await tab.click({ timeout: 8000 });
                }
                switchLocated = true;
                break;
            } catch (_) { /* try the next visible switch control */ }
        }
        if (switchLocated) break;
    }

    // Selection can update before React replaces the cards. Poll the actual
    // pricing content, and do not repeatedly click a switch during that render.
    const deadline = Date.now() + timeout;
    do {
        if (await isPersonalPlanView(page)) {
            console.log('✅ [步骤] 已切换到个人套餐 (Personal)');
            return;
        }
        await page.waitForTimeout(250);
    } while (Date.now() < deadline);

    if (await isBusinessPlanView(page)) {
        throw new Error('定价页停留在 Business 套餐，未能切换到 Personal，无法购买 Plus/Pro');
    }

    console.warn('[Warn] 未能确认 Personal 切换，将继续查找升级按钮');
}

async function getPricingSurface(page) {
    const dialog = page.locator('[role="dialog"]:visible').first();
    if (await dialog.isVisible().catch(() => false)) {
        return dialog;
    }
    return page.locator('main:visible').first();
}

async function readPricingSurfaceText(page) {
    const surface = await getPricingSurface(page);
    return String(await surface.innerText({ timeout: 5000 }).catch(() => '') || '');
}

async function scrollPricingSurface(page) {
    const surface = await getPricingSurface(page);
    await surface.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
    }).catch(() => {});
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await page.waitForTimeout(600);
}

async function pageShowsTargetRegionPricing(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const text = await readPricingSurfaceText(page);
    const positive = REGION_PRICE_PATTERNS[code] || [];
    const negative = REGION_WRONG_CURRENCY[code] || [];
    const countryHints = REGION_CURRENT_COUNTRY_HINTS[code] || [];

    const hasPositivePrice = positive.some((pattern) => pattern.test(text));
    const hasWrongCurrency = negative.some((pattern) => pattern.test(text));
    const hasCountryLabel = countryHints.some((pattern) => pattern.test(text));

    if (hasWrongCurrency) {
        return false;
    }
    if (hasPositivePrice) {
        return true;
    }
    if (hasCountryLabel && !hasWrongCurrency) {
        const looseHints = REGION_CURRENCY_HINTS[code] || [];
        if (looseHints.some((hint) => text.includes(hint))) {
            return true;
        }
    }
    return false;
}

const ALL_COUNTRY_NAME_PATTERN = /^(United Kingdom|Philippines|United States|Singapore|Malaysia|Egypt|Afghanistan|Algeria|Andorra|Albania|Australia|Canada|Japan|China|菲律宾|美国|新加坡|马来西亚|埃及|مصر)$/i;

async function isRegionMenuOpen(page) {
    const viewport = page.locator('[data-radix-scroll-area-viewport]').last();
    if (await viewport.isVisible({ timeout: 500 }).catch(() => false)) {
        return true;
    }
    const listbox = page.locator('[role="listbox"]').first();
    if (await listbox.isVisible({ timeout: 500 }).catch(() => false)) {
        return true;
    }
    return false;
}

async function closeRegionMenuIfOpen(page) {
    if (!(await isRegionMenuOpen(page))) {
        return;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
}

async function openRegionPicker(page) {
    if (await isRegionMenuOpen(page)) {
        console.log('[Info] 地区选择器已打开');
        return true;
    }

    const surface = await getPricingSurface(page);
    await scrollPricingSurface(page);

    const triggerCandidates = [
        surface.locator('button[aria-haspopup="listbox"]').last(),
        surface.locator('button[aria-haspopup="listbox"]').first(),
        surface.locator('button[aria-haspopup="menu"]').last(),
        surface.locator('button[aria-expanded]').filter({ hasText: ALL_COUNTRY_NAME_PATTERN }).last(),
        surface.locator('[role="dialog"] button').filter({ hasText: ALL_COUNTRY_NAME_PATTERN }).last()
    ];

    for (const trigger of triggerCandidates) {
        try {
            if (!(await trigger.isVisible({ timeout: 1200 }).catch(() => false))) {
                continue;
            }
            const inListbox = await trigger.evaluate((node) => Boolean(node.closest('[role="listbox"]'))).catch(() => false);
            if (inListbox) {
                continue;
            }
            const text = normalizeOptionText(await trigger.innerText().catch(() => ''));
            if (!text || SKIP_REGION_BUTTON_TEXT.test(text)) {
                continue;
            }
            await trigger.scrollIntoViewIfNeeded().catch(() => {});
            await trigger.click({ timeout: 8000 });
            await page.waitForTimeout(900);
            if (await isRegionMenuOpen(page)) {
                console.log(`[Info] 已打开地区选择器 (${text.slice(0, 40)})`);
                return true;
            }
        } catch (_) { /* try next */ }
    }

    return false;
}

async function getCountryScrollViewport(page) {
    const viewport = page.locator('[data-radix-scroll-area-viewport]').last();
    if (await viewport.isVisible({ timeout: 1000 }).catch(() => false)) {
        return viewport;
    }

    const listbox = page.locator('[role="listbox"]').first();
    if (await listbox.isVisible({ timeout: 1000 }).catch(() => false)) {
        return listbox;
    }

    return null;
}

async function clickExactCountryInViewport(viewport, labels) {
    return viewport.evaluate((root, labelList) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const wanted = labelList.map(normalize);
        const elements = Array.from(root.querySelectorAll('[role="option"], [data-index], button, li, div'));

        for (const el of elements) {
            if (!root.contains(el)) {
                continue;
            }
            const lines = String(el.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
            if (lines.length !== 1) {
                continue;
            }
            const text = normalize(lines[0]);
            if (!wanted.includes(text)) {
                continue;
            }
            const childHasSame = Array.from(el.children).some((child) => {
                const childLines = String(child.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
                return childLines.length === 1 && normalize(childLines[0]) === text;
            });
            if (childHasSame) {
                continue;
            }
            el.scrollIntoView({ block: 'center' });
            el.click();
            return lines[0];
        }
        return '';
    }, labels).catch(() => '');
}

async function scrollVirtualCountryList(page, labels) {
    const targets = (labels || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!targets.length) {
        return false;
    }

    const viewport = await getCountryScrollViewport(page);
    if (!viewport) {
        console.warn('[Warn] 未找到可滚动的国家列表容器');
        return false;
    }

    await viewport.evaluate((node) => {
        node.scrollTop = 0;
    }).catch(() => {});
    await page.waitForTimeout(250);

    // Egypt 位于英文国家列表前半段；从中点向下扫描会跳过虚拟化的选项。
    const jumpRatio = targets.some((label) => /egypt|埃及|مصر/i.test(label)) ? 0
        : (targets.some((label) => /philippines|pilipinas|菲律宾/i.test(label)) ? 0.58 : 0.5);
    await viewport.evaluate((node, ratio) => {
        node.scrollTop = Math.floor(node.scrollHeight * ratio);
    }, jumpRatio).catch(() => {});
    await page.waitForTimeout(300);

    for (let step = 0; step < 160; step += 1) {
        for (const label of targets) {
            const opt = viewport.getByText(new RegExp(`^${escapeRegExp(label)}$`, 'i')).first();
            if ((await opt.count()) > 0) {
                try {
                    await opt.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
                    if (await opt.isVisible({ timeout: 300 }).catch(() => false)) {
                        await opt.click({ timeout: 8000 });
                        console.log(`✅ [步骤] Playwright 文本匹配选中: ${label}`);
                        return true;
                    }
                } catch (_) { /* continue scrolling */ }
            }
        }

        const picked = await clickExactCountryInViewport(viewport, targets);
        if (picked) {
            console.log(`✅ [步骤] 虚拟列表第 ${step + 1} 步选中: ${picked}`);
            return true;
        }

        const visibleTexts = await viewport.evaluate((root) => {
            return Array.from(root.querySelectorAll('[role="option"], button, li'))
                .map((el) => String(el.innerText || '').split('\n')[0].trim())
                .filter(Boolean)
                .slice(0, 8);
        }).catch(() => []);
        if (step === 0 || step % 15 === 0) {
            console.log(`[Info] 滚动第 ${step + 1} 步，可见: ${visibleTexts.join(' | ') || '(empty)'}`);
        }

        const atBottom = await viewport.evaluate((node) => {
            const before = node.scrollTop;
            node.scrollTop += Math.max(72, Math.floor(node.clientHeight * 0.32));
            return node.scrollTop <= before;
        }).catch(() => true);

        await page.waitForTimeout(90);
        if (atBottom) {
            break;
        }
    }

    await viewport.hover().catch(() => {});
    for (let wheel = 0; wheel < 80; wheel += 1) {
        const picked = await clickExactCountryInViewport(viewport, targets);
        if (picked) {
            console.log(`✅ [步骤] 滚轮后选中: ${picked}`);
            return true;
        }
        await page.mouse.wheel(0, 280);
        await page.waitForTimeout(60);
    }

    return false;
}

async function scrollAndSelectCountryOption(page, labels) {
    const targets = (labels || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!targets.length) {
        return false;
    }

    if (!(await isRegionMenuOpen(page))) {
        return false;
    }

    console.log(`[Info] 开始在虚拟列表中查找: ${targets.join(' / ')}`);

    if (await scrollVirtualCountryList(page, targets)) {
        return true;
    }

    for (const label of targets) {
        if (await tryKeyboardCountryFilter(page, label)) {
            return true;
        }
    }

    return false;
}

async function clickRegionOption(page, label) {
    if (await scrollAndSelectCountryOption(page, [label])) {
        return true;
    }

    const optionLocators = [
        page.getByRole('option', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }),
        page.getByRole('menuitem', { name: new RegExp(escapeRegExp(label), 'i') }),
        page.getByRole('radio', { name: new RegExp(escapeRegExp(label), 'i') }),
        page.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }),
        page.locator(`[role="option"]:has-text("${label}")`),
        page.locator(`[role="menuitem"]:has-text("${label}")`),
        page.locator(`li:has-text("${label}")`)
    ];

    for (const locator of optionLocators) {
        try {
            const el = locator.first();
            if ((await el.count()) === 0) {
                continue;
            }
            await el.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
            if (await el.isVisible({ timeout: 1200 })) {
                await el.click({ timeout: 8000 });
                return true;
            }
        } catch (_) { /* try next */ }
    }
    return false;
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryKeyboardCountryFilter(page, label) {
    const typeText = String(label || '').trim();
    if (!typeText) {
        return false;
    }

    const viewport = await getCountryScrollViewport(page);
    if (!viewport) {
        return false;
    }

    try {
        await viewport.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(150);
        await page.keyboard.press('Home').catch(() => {});
        await page.waitForTimeout(100);
        await page.keyboard.type(typeText, { delay: 60 });
        await page.waitForTimeout(500);

        const picked = await clickExactCountryInViewport(viewport, [label]);
        if (picked) {
            console.log(`✅ [步骤] 键盘筛选后已选择: ${picked}`);
            return true;
        }

        const option = page.getByRole('option', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }).first();
        if (await option.isVisible({ timeout: 1200 }).catch(() => false)) {
            await option.click({ timeout: 8000 });
            console.log(`✅ [步骤] 键盘筛选后已选择: ${label}`);
            return true;
        }
    } catch (_) { /* ignore */ }

    return false;
}

async function readSelectedCountryLabel(page) {
    const surface = await getPricingSurface(page);
    const trigger = surface.locator('button').filter({
        hasText: /Philippines|United Kingdom|Algeria|United States|Singapore|Malaysia|Egypt|Afghanistan|菲律宾|埃及|مصر/i
    }).last();
    if (await trigger.isVisible({ timeout: 1000 }).catch(() => false)) {
        return normalizeOptionText(await trigger.innerText().catch(() => ''));
    }
    return '';
}

async function selectRegionOption(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const labels = REGION_UI_LABELS[code] || [];
    const preferredLabels = labels.filter((label) => label.trim().length > 0);

    const search = page.locator('input[type="search"], input[placeholder*="Search" i], input[placeholder*="搜索" i]').first();
    if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {
        for (const label of preferredLabels) {
            await search.fill('').catch(() => {});
            await search.fill(label).catch(() => {});
            await page.waitForTimeout(700);
            const viewport = await getCountryScrollViewport(page);
            const picked = viewport
                ? await clickExactCountryInViewport(viewport, [label])
                : '';
            if (picked) {
                console.log(`✅ [步骤] 已通过搜索框选择地区: ${picked}`);
                return verifySelectedCountry(page, preferredLabels);
            }
        }
    }

    if (await scrollAndSelectCountryOption(page, preferredLabels)) {
        return verifySelectedCountry(page, preferredLabels);
    }

    return false;
}

async function verifySelectedCountry(page, labels) {
    await page.waitForTimeout(800);
    const selected = await readSelectedCountryLabel(page);
    if (selected && matchesCountryLabel(selected, labels)) {
        console.log(`✅ [步骤] 地区选择已确认: ${selected}`);
        return true;
    }
    if (selected) {
        console.warn(`[Warn] 地区选择校验失败，当前显示: ${selected}，期望: ${labels.join(' / ')}`);
        return false;
    }
    return true;
}

/** @deprecated 使用 pageShowsTargetRegionPricing */
async function pageShowsCurrency(page, regionCode) {
    return pageShowsTargetRegionPricing(page, regionCode);
}

async function waitForPricingPage(page, timeout = 60000) {
    await page.goto(PRICING_URL, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    await clearHumanVerification(page, { phase: 'pricing-page', maxWaitMs: 120000 });

    await assertChatGptLoggedIn(page, '定价页');

    const url = page.url();
    if (!url.includes('chatgpt.com')) {
        throw new Error(`定价页打开失败，当前 URL: ${url}`);
    }
    console.log('✅ [步骤] 已打开 ChatGPT 定价页 (#pricing)');
}

/**
 * 在定价页选择账单地区（Personal 视图下，右下角/弹窗内地区切换）
 */
async function selectPricingRegion(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const regionConfig = getRegionConfig(code);
    console.log(`🌏 [步骤] 正在选择账单地区: ${regionConfig?.label || code}...`);

    if (await pageShowsTargetRegionPricing(page, code)) {
        console.log(`✅ [步骤] 定价页已显示目标地区价格 (${code})，跳过地区切换`);
        return;
    }

    const surfacePreview = (await readPricingSurfaceText(page)).replace(/\s+/g, ' ').slice(0, 120);
    console.log(`[Info] 当前定价页片段: ${surfacePreview}`);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (await pageShowsTargetRegionPricing(page, code)) {
            console.log(`✅ [步骤] 定价页已显示目标地区价格 (${code})`);
            return;
        }

        if (attempt > 1) {
            console.log(`[Warn] 地区切换重试 ${attempt}/3...`);
            await closeRegionMenuIfOpen(page);
            await scrollPricingSurface(page);
        }

        let menuOpen = await isRegionMenuOpen(page);
        if (!menuOpen) {
            menuOpen = await openRegionPicker(page);
        }

        if (menuOpen || await isRegionMenuOpen(page)) {
            const selected = await selectRegionOption(page, code);
            if (!selected) {
                console.warn(`[Warn] 地区菜单已打开，但未找到 ${code} 对应选项（将尝试滚动列表）`);
            } else {
                await page.waitForTimeout(2500);
            }
        } else {
            console.warn('[Warn] 未能打开地区选择器，尝试直接滚动/点击目标地区');
            await selectRegionOption(page, code);
            await page.waitForTimeout(1500);
        }

        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);

        if (await pageShowsTargetRegionPricing(page, code)) {
            console.log(`✅ [步骤] 已切换到目标地区: ${regionConfig?.label || code}`);
            return;
        }
    }

    const finalText = (await readPricingSurfaceText(page)).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`无法将定价页切换到目标地区 ${code}（${regionConfig?.label || code}），请检查后台支付地区设置。当前页面: ${finalText}`);
}

/** 展开精简定价视图，并等待目标套餐按钮异步出现。 */
async function preparePlanView(page, buttonPattern, label) {
    const upgradeButton = page.getByRole('button', { name: buttonPattern }).first();
    const deadline = Date.now() + 8000;

    // The initial Personal view may contain only Free and Plus. Other plans can be
    // inserted asynchronously after the "See all plans" control is clicked.
    // isVisible() itself does not wait, so poll for either condition explicitly.
    while (Date.now() < deadline) {
        if (await upgradeButton.isVisible().catch(() => false)) return 'visible';

        const expandCandidates = [
            () => page.getByRole('link', { name: SEE_ALL_PLANS }).first(),
            () => page.getByRole('button', { name: SEE_ALL_PLANS }).first(),
            () => page.getByText(SEE_ALL_PLANS).first()
        ];
        for (const getCandidate of expandCandidates) {
            try {
                const candidate = getCandidate();
                if (!await candidate.isVisible()) continue;
                await candidate.scrollIntoViewIfNeeded().catch(() => {});
                await candidate.click({ timeout: 5000 });
                console.log(`✅ [步骤] 已展开全部套餐，等待 ${label} 套餐加载`);
                await upgradeButton.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
                return 'expanded';
            } catch (_) { /* try another exact expansion control */ }
        }
        await page.waitForTimeout(250);
    }
    return 'unavailable';
}

/** 通用 Pro 按钮不代表档位，必须先在同一卡片内选中并确认数字 radio。 */
async function clickProPlanUpgrade(page, plan) {
    // Older views may expose a dedicated button whose name already specifies X.
    for (const pattern of PLAN_UPGRADE_PATTERNS[plan]) {
        const button = page.getByRole('button', { name: pattern }).first();
        if (!await button.isVisible().catch(() => false)) continue;
        await button.scrollIntoViewIfNeeded();
        await button.click({ timeout: 10000 });
        console.log(`✅ [步骤] 已点击 ${plan} 专属升级按钮`);
        return;
    }

    const tier = PRO_TIER_VALUES[plan];
    const upgradeButtons = page.getByRole('button', { name: PRO_GENERIC_UPGRADE_BUTTON });
    if (await upgradeButtons.count() !== 1) {
        throw new Error(`无法唯一定位 ${plan} 的 Pro 升级按钮，已停止创建`);
    }

    // Start at the button and take its nearest Pro-labelled card. Never broaden
    // the search to page-wide numeric radios or a Free/Plus/Go ancestor container.
    const card = upgradeButtons.locator('xpath=ancestor::*[self::div or self::section or self::article][.//*[normalize-space(.)="Pro" or normalize-space(.)="ChatGPT Pro"]][1]');
    if (await card.count() !== 1
        || await card.getByRole('button', { name: /(?:Upgrade to|Get|Subscribe to|升级至)\s*(?:ChatGPT\s*)?(?:Go|Plus)\b/i }).count() > 0) {
        throw new Error(`无法定位独立 Pro 套餐卡片，未选择 ${plan}（已停止创建）`);
    }

    const radio = card.getByRole('radio', { name: tier, exact: true });
    try {
        await radio.waitFor({ state: 'visible', timeout: 5000 });
        if (await radio.count() !== 1) throw new Error('目标档位不唯一');
        if (await radio.isDisabled()) throw new Error('目标档位已禁用');
        if (await radio.getAttribute('aria-checked') !== 'true') {
            await radio.scrollIntoViewIfNeeded();
            await radio.click({ timeout: 5000 });
        }
        // React may replace the entire card after the click; locator-based waits
        // re-resolve the selected radio rather than holding a stale element handle.
        await card.getByRole('radio', { name: tier, exact: true, checked: true })
            .waitFor({ state: 'visible', timeout: 5000 });
        if (await radio.getAttribute('aria-checked') !== 'true'
            || await card.getByRole('radio', { name: PRO_TIER_LABEL, checked: true }).count() !== 1) {
            throw new Error('无法确认唯一选中档位');
        }
    } catch (_) {
        throw new Error(`无法选中或确认 Pro ${tier} 档位（${plan}），已停止创建，不使用默认档位`);
    }

    console.log(`✅ [步骤] 已确认 Pro 档位: ${plan} → ${tier} (aria-checked=true)`);
    const button = card.getByRole('button', { name: PRO_GENERIC_UPGRADE_BUTTON });
    await button.click({ timeout: 10000 });
    console.log(`✅ [步骤] 已点击 Pro 升级按钮 (档位: ${tier})`);
}

/** 点击对应套餐的升级按钮。 */
async function clickPlanUpgrade(page, planType) {
    const plan = normalizePlanType(planType);
    if (!plan) throw new Error(`不支持的套餐类型: ${String(planType)}`);
    const patterns = PLAN_UPGRADE_PATTERNS[plan];
    console.log(`📦 [步骤] 正在点击升级按钮 (套餐: ${plan})...`);

    await assertChatGptLoggedIn(page, '升级前');
    await switchToPersonalPlans(page);
    await page.waitForTimeout(1000);
    if (PRO_TIER_VALUES[plan]) {
        await preparePlanView(page, PRO_UPGRADE_BUTTON, 'Pro');
        await clickProPlanUpgrade(page, plan);
        return;
    }
    const goView = plan === 'go' ? await preparePlanView(page, GO_UPGRADE_BUTTON, 'Go') : '';

    for (const pattern of patterns) {
        try {
            const btn = page.getByRole('button', { name: pattern }).first();
            if (await btn.isVisible({ timeout: 4000 })) {
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ timeout: 10000 });
                console.log(`✅ [步骤] 已点击升级按钮: ${pattern}`);
                return;
            }
        } catch (_) { /* try next */ }
    }

    const cardTitle = plan === 'go' ? /ChatGPT Go|^Go$/i : /ChatGPT Plus/i;
    try {
        const card = page.locator('div').filter({ hasText: cardTitle }).filter({ has: page.getByRole('button') }).first();
        const btn = card.getByRole('button').filter({
            hasText: plan === 'go' ? GO_UPGRADE_BUTTON : /升级|Upgrade|Subscribe|Get/i
        }).first();
        if (await btn.isVisible({ timeout: 3000 })) {
            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await btn.click({ timeout: 10000 });
            console.log('✅ [步骤] 已点击套餐卡片内的升级按钮');
            return;
        }
    } catch (_) { /* fall through */ }

    if (plan === 'plus') {
        try {
            const plusCard = page.locator('div').filter({ has: page.getByText(/ChatGPT Plus|^Plus$/i) }).filter({
                has: page.getByRole('button', { name: /^Upgrade$|^升级$/i })
            }).first();
            const upgradeBtn = plusCard.getByRole('button', { name: /^Upgrade$|^升级$/i }).first();
            if (await upgradeBtn.isVisible({ timeout: 3000 })) {
                await upgradeBtn.scrollIntoViewIfNeeded().catch(() => {});
                await upgradeBtn.click({ timeout: 10000 });
                console.log('✅ [步骤] 已点击 Plus 卡片 Upgrade 按钮');
                return;
            }
        } catch (_) { /* fall through */ }
    }

    const fallbackSelectors = plan === 'go'
        ? [
            'button:has-text("升级至 Go")',
            'button:has-text("Upgrade to Go")',
            'button:has-text("Get Go")'
        ]
        : [
            'button:has-text("升级至 Plus")',
            'button:has-text("Upgrade to Plus")',
            '[role="dialog"] >> text=ChatGPT Plus >> .. >> .. >> button:has-text("Upgrade")',
            'text=ChatGPT Plus >> xpath=ancestor::div[.//button[contains(., "Upgrade") or contains(., "升级")]][1] >> button'
        ];

    for (const sel of fallbackSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 3000 })) {
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ timeout: 10000 });
                console.log(`✅ [步骤] 已点击升级按钮 (${sel})`);
                return;
            }
        } catch (_) { /* try next */ }
    }

    const onLogin = await page.locator('text=Sign in with Google').isVisible({ timeout: 1000 }).catch(() => false);
    if (onLogin) {
        throw new Error('Session 未生效：定价页显示 Google 登录，无法点击升级按钮');
    }

    if (await isBusinessPlanView(page)) {
        throw new Error(`定价页仍在 Business 视图，未找到 ${plan} 套餐；请确认账号可升级 Plus/Pro`);
    }

    if (plan === 'go' && goView === 'expanded') {
        throw new Error('已展开全部套餐，但未找到或无法点击 Go 升级按钮，请检查账号、地区和页面加载状态');
    }
    throw new Error(`未找到 ${plan} 套餐的升级按钮，请确认账号可升级且 Session 已登录`);
}

async function waitForCheckoutPage(page, timeout = 90000, failureMessage = () => '') {
    console.log('💳 [步骤] 等待跳转到 Checkout 配置套餐页...');
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        const failure = await failureMessage();
        if (failure) throw new Error(failure);
        const url = page.url();
        if (url.includes('/checkout/') || url.includes('chatgpt.com/checkout')) {
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);
            await assertChatGptLoggedIn(page, 'Checkout');
            const lateFailure = await failureMessage();
            if (lateFailure) throw new Error(lateFailure);
            console.log(`✅ [步骤] Checkout 页面已打开: ${url.slice(0, 80)}...`);
            return url;
        }
        if (url.includes('accounts.google.com')) {
            throw new Error('Session 未生效：升级后跳转到 Google 登录页');
        }
        await page.waitForTimeout(1000);
    }

    throw new Error(`等待 Checkout 页面超时，当前 URL: ${page.url()}`);
}

function validateUiCheckoutPayload(payload, { region, planType, planNameOverride }) {
    if (!normalizePlanType(planType)) return `不支持的套餐类型: ${String(planType)}`;
    const expectedPlan = planNameOverride || resolvePlanName(planType);
    if (payload?.plan_name !== expectedPlan) {
        return `UI Checkout 套餐不匹配：需要 ${expectedPlan}，页面选择 ${payload?.plan_name || 'unknown'}（已停止创建）`;
    }
    const expectedCountry = String(region || 'PH').toUpperCase();
    const expectedCurrency = getRegionConfig(expectedCountry)?.currency;
    if (payload?.billing_details?.country !== expectedCountry
        || payload?.billing_details?.currency !== expectedCurrency) {
        return `UI Checkout 地区不匹配：需要 ${expectedCountry}/${expectedCurrency}（已停止创建）`;
    }
    return '';
}

async function openPricingCheckout(page, { region, planType, planNameOverride }) {
    await waitForPricingPage(page);
    await switchToPersonalPlans(page);
    await selectPricingRegion(page, region);

    // 多个 Pro 档位可能共用同类按钮；发送前核对套餐和账单地区，避免悄悄换档。
    let requestSeen = false;
    let failure = '';
    let failureBody = Promise.resolve();
    let failureGeneration = 0;
    const checkoutEndpoint = 'https://chatgpt.com/backend-api/payments/checkout';
    const checkoutRoute = /^https:\/\/chatgpt\.com\/backend-api\/payments\/checkout(?:\?.*)?$/;
    const guard = async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        requestSeen = true;
        let payload;
        try { payload = route.request().postDataJSON(); } catch (_) { /* handled below */ }
        const validationFailure = validateUiCheckoutPayload(payload, { region, planType, planNameOverride });
        if (validationFailure) {
            failureGeneration++;
            failure = validationFailure;
            failureBody = Promise.resolve();
            return route.abort('blockedbyclient');
        }
        return route.fallback();
    };
    const responseListener = (response) => {
        if (response.url().split('?')[0] === checkoutEndpoint && response.status() >= 400) {
            const generation = ++failureGeneration;
            failure = `UI 创建 Checkout 失败 (HTTP ${response.status()})`;
            let timer;
            failureBody = Promise.race([
                Promise.resolve().then(() => response.text()),
                new Promise((resolve) => { timer = setTimeout(() => resolve(''), 1500); })
            ]).then((body) => {
                // Only surface the known diagnostic, never arbitrary response bodies or tokens.
                let data;
                try { data = JSON.parse(body); } catch (_) { return; }
                const detail = typeof data?.detail === 'string' ? data.detail
                    : (typeof data?.detail?.message === 'string' ? data.detail.message
                        : (typeof data?.message === 'string' ? data.message
                            : (typeof data?.error === 'string' ? data.error
                                : (typeof data?.error?.message === 'string' ? data.error.message : ''))));
                if (generation === failureGeneration && /unusual activity/i.test(detail)) {
                    failure += ': Our systems have detected unusual activity. Please try again later.';
                }
            }).catch(() => {}).finally(() => clearTimeout(timer));
        }
    };
    await page.route(checkoutRoute, guard);
    page.on('response', responseListener);
    try {
        await clickPlanUpgrade(page, planType);
        const checkoutUrl = await waitForCheckoutPage(page, 90000, async () => {
            while (failure) {
                const pending = failureBody;
                await pending;
                if (pending === failureBody) break;
            }
            return failure;
        });
        if (!requestSeen) {
            throw new Error('未观察到 UI Checkout 创建请求，无法确认所选套餐/地区');
        }
        return checkoutUrl;
    } finally {
        page.off('response', responseListener);
        await page.unroute(checkoutRoute, guard);
    }
}

module.exports = {
    PRICING_URL,
    openPricingCheckout,
    waitForPricingPage,
    selectPricingRegion,
    switchToPersonalPlans,
    clickPlanUpgrade,
    waitForCheckoutPage,
    validateUiCheckoutPayload,
    pageShowsTargetRegionPricing
};
