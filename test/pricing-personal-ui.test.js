'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { chromium } = require('playwright');

const sourcePath = path.join(__dirname, '../src/checkout/pricing-checkout.js');
const browserAvailable = fs.existsSync(chromium.executablePath());

function loadPricing() {
    const realRequire = createRequire(sourcePath);
    const module = { exports: {} };
    const context = vm.createContext({
        module, console, setTimeout, clearTimeout,
        require: name => name === '../browser/session-auth'
            ? { assertChatGptLoggedIn: async () => {} }
            : realRequire(name)
    });
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
    return context;
}

function personalFixture({ title = 'Plus', outside = '', inside = '' } = {}) {
    return `
        ${outside}
        <main>
            <h1>Upgrade your plan</h1>
            <nav>
                <button id="personal" data-state="active">Personal</button>
                <button data-state="inactive">Business</button>
            </nav>
            <div><h3>Free</h3><button disabled>Your current plan</button></div>
            <div><h3>${title}</h3><button id="plus">✦ Upgrade to Plus</button><p>₱1,100 / month</p></div>
            ${inside}
        </main>
        <script>
            window.actions = [];
            document.querySelector('#personal').onclick = () => window.actions.push('personal');
            document.querySelector('#plus').onclick = () => window.actions.push('plus');
        </script>
    `;
}

describe.skipIf(!browserAvailable)('Personal / Business pricing view in Chromium', () => {
    let browser;
    let page;
    let pricing;
    let quickPage;

    beforeAll(async () => {
        browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    });
    afterAll(async () => { if (browser) await browser.close(); });
    beforeEach(async () => {
        page = await browser.newPage();
        // This suite uses local DOM only; never send an account or checkout request.
        await page.route('**/*', route => route.abort());
        pricing = loadPricing();
        quickPage = new Proxy(page, {
            get(target, property) {
                if (property === 'waitForTimeout') return delay => target.waitForTimeout(Math.min(delay, 20));
                const value = target[property];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    });
    afterEach(async () => { if (page) await page.close(); });

    it('opens Plus from the compact Personal view shown in the screenshot', async () => {
        await page.setContent(personalFixture());
        await pricing.module.exports.clickPlanUpgrade(quickPage, 'plus');
        expect(await page.evaluate(() => window.actions)).toEqual(['plus']);
    });

    it('does not mistake an unrelated ChatGPT Business link for the active plan', async () => {
        await page.setContent(personalFixture({ outside: '<aside><a href="#business">ChatGPT Business</a></aside>' }));
        await pricing.module.exports.clickPlanUpgrade(quickPage, 'plus');
        expect(await page.evaluate(() => window.actions)).toEqual(['plus']);
    });

    it('does not let Business marketing copy override a visible Plus upgrade button', async () => {
        await page.setContent(personalFixture({ inside: '<p>Learn about ChatGPT Business for your team</p>' }));
        await pricing.module.exports.clickPlanUpgrade(quickPage, 'plus');
        expect(await page.evaluate(() => window.actions)).toEqual(['plus']);
    });

    it('keeps the legacy ChatGPT Plus title working', async () => {
        await page.setContent(personalFixture({ title: 'ChatGPT Plus', inside: '<p>Compare ChatGPT Business</p>' }));
        await pricing.module.exports.clickPlanUpgrade(quickPage, 'plus');
        expect(await page.evaluate(() => window.actions)).toEqual(['plus']);
    });

    it.each(['Go', 'Pro'])('recognizes a Personal view containing only the %s plan', async title => {
        await page.setContent(`
            <aside>ChatGPT Business</aside>
            <main>
                <button id="personal" data-state="active">Personal</button><button>Business</button>
                <section><h3>${title}</h3><button>Upgrade to ${title}</button></section>
            </main>
            <script>
                window.actions = [];
                document.querySelector('#personal').onclick = () => window.actions.push('personal');
            </script>
        `);
        await pricing.module.exports.switchToPersonalPlans(quickPage);
        expect(await page.evaluate(() => window.actions)).toEqual([]);
    });

    it('uses the visible pricing dialog instead of hidden dialogs or the underlying Business page', async () => {
        await page.setContent(`
            <main><button role="tab" aria-selected="true">Business</button><h2>ChatGPT Business</h2></main>
            <div role="dialog" hidden><h2>ChatGPT Business</h2></div>
            <div role="dialog">
                <button aria-pressed="true">Personal</button><button aria-pressed="false">Business</button>
                <article><h3>Plus</h3><button id="plus">Upgrade to Plus</button></article>
            </div>
            <script>
                window.actions = [];
                document.querySelector('#plus').onclick = () => window.actions.push('plus');
            </script>
        `);
        await pricing.module.exports.clickPlanUpgrade(quickPage, 'plus');
        expect(await page.evaluate(() => window.actions)).toEqual(['plus']);
    });

    it('recognizes a visible short Plus title after a hidden duplicate with a generic upgrade button', async () => {
        await page.setContent(`
            <main>
                <button id="personal" aria-pressed="true">Personal</button><button>Business</button>
                <div hidden><h3>Plus</h3></div>
                <article><h3>Plus</h3><button>Upgrade</button></article>
                <p>Compare ChatGPT Business</p>
            </main>
            <script>
                window.actions = [];
                document.querySelector('#personal').onclick = () => window.actions.push('personal');
            </script>
        `);
        await pricing.module.exports.switchToPersonalPlans(quickPage);
        expect(await page.evaluate(() => window.actions)).toEqual([]);
    });

    it.each([
        ['tab', 'aria-selected', 'true', 'false', 'Personal', 'Business'],
        ['button', 'aria-pressed', 'true', 'false', 'Personal', 'Business'],
        ['button', 'data-state', 'active', 'inactive', 'Personal', 'Business'],
        ['radio', 'aria-checked', 'true', 'false', 'Personal', 'Business'],
        ['radio', 'data-state', 'on', 'off', '个人', '商业']
    ])('switches the selected %s %s control and waits for cards', async (role, attribute, active, inactive, personal, business) => {
        await page.setContent(`
            <main>
                <div>
                    <button role="${role}" id="personal" ${attribute}="${inactive}">${personal}</button>
                    <button role="${role}" id="business" ${attribute}="${active}">${business}</button>
                </div>
                <section id="cards"><h3>ChatGPT Business</h3><button>Upgrade to Business</button></section>
            </main>
            <script>
                window.actions = [];
                document.querySelector('#personal').onclick = () => {
                    window.actions.push('personal');
                    document.querySelector('#personal').setAttribute('${attribute}', '${active}');
                    document.querySelector('#business').setAttribute('${attribute}', '${inactive}');
                    setTimeout(() => {
                        document.querySelector('#cards').innerHTML = '<h3>Plus</h3><button id="plus">Upgrade to Plus</button>';
                    }, 350);
                };
            </script>
        `);
        await pricing.module.exports.switchToPersonalPlans(quickPage);
        expect(await page.locator('#plus').isVisible()).toBe(true);
        expect(await page.evaluate(() => window.actions)).toEqual(['personal']);
    });

    it('waits for cards when Personal is already selected without clicking it again', async () => {
        await page.setContent(`
            <main>
                <button id="personal" role="tab" aria-selected="true">Personal</button>
                <button role="tab" aria-selected="false">Business</button>
                <section id="cards"><h3>ChatGPT Business</h3></section>
            </main>
            <script>
                window.actions = [];
                document.querySelector('#personal').onclick = () => window.actions.push('personal');
                setTimeout(() => {
                    document.querySelector('#cards').innerHTML = '<h3>Plus</h3><button id="plus">Upgrade to Plus</button>';
                }, 350);
            </script>
        `);
        await pricing.module.exports.switchToPersonalPlans(quickPage);
        expect(await page.locator('#plus').isVisible()).toBe(true);
        expect(await page.evaluate(() => window.actions)).toEqual([]);
    });

    it('switches native radio inputs even when stale Plus content remains visible', async () => {
        await page.setContent(`
            <main>
                <label><input id="personal" type="radio" name="plans">Personal</label>
                <label><input type="radio" name="plans" checked>Business</label>
                <section id="cards"><h3>Plus</h3><button>Upgrade to Plus</button></section>
            </main>
            <script>
                window.actions = [];
                document.querySelector('#personal').onclick = () => window.actions.push('personal');
            </script>
        `);
        await pricing.module.exports.switchToPersonalPlans(quickPage);
        expect(await page.locator('#personal').isChecked()).toBe(true);
        expect(await page.evaluate(() => window.actions)).toEqual(['personal']);
    });

    it.each(['Business', 'ChatGPT Business'])('rejects a %s card without requiring tab ARIA attributes', async title => {
        await page.setContent(`<main><h3>${title}</h3><button>Upgrade to Business</button></main>`);
        await expect(pricing.module.exports.switchToPersonalPlans(quickPage, { timeout: 150 }))
            .rejects.toThrow('定价页停留在 Business 套餐');
    });

    it('still rejects a Business-only view when the Personal switch does not work', async () => {
        await page.setContent(`
            <main>
                <button role="tab" aria-selected="false">Personal</button>
                <button role="tab" aria-selected="true">Business</button>
                <h3>ChatGPT Business</h3><button>Upgrade to Business</button>
            </main>
        `);
        await expect(pricing.module.exports.switchToPersonalPlans(quickPage, { timeout: 300 }))
            .rejects.toThrow('定价页停留在 Business 套餐');
    });
});
