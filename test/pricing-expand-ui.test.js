'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { chromium } = require('playwright');

const sourcePath = path.join(__dirname, '../src/checkout/pricing-checkout.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const browserAvailable = fs.existsSync(chromium.executablePath());

function loadSelector() {
    const realRequire = createRequire(sourcePath);
    const module = { exports: {} };
    const context = vm.createContext({
        module, console, setTimeout, clearTimeout,
        require: (name) => name === '../browser/session-auth'
            ? { assertChatGptLoggedIn: async () => {} }
            : realRequire(name)
    });
    vm.runInContext(source, context);
    context.switchToPersonalPlans = async () => {};
    context.isBusinessPlanView = async () => false;
    return context.module.exports.clickPlanUpgrade;
}

// The Pro card exposes one generic upgrade button and three numeric radios.
// Keep unrelated numeric radios outside the card to catch unscoped selectors.
function proCardFixture({ selected = '100', tiers = ['100', '200', '500'], selectionDelay = 0, rerender = false, ignoreSelection = false, disabled = '' } = {}) {
    return `
        <div id="pro-card">
            <header><h3>Pro</h3><div role="radiogroup" aria-label="Pro tier">
                ${tiers.map(tier => `<div><button type="button" role="radio" aria-checked="${tier === selected}" data-state="${tier === selected ? 'on' : 'off'}" ${disabled === tier ? 'disabled' : ''}>${tier}</button></div>`).join('')}
            </div></header>
            <button id="pro-upgrade" type="button">Upgrade to Pro</button>
        </div>
        <script>
            window.actions = window.actions || [];
            function bindPro() {
                const card = document.querySelector('#pro-card');
                card.querySelectorAll('[role=radio]').forEach(radio => {
                    radio.onclick = () => {
                        window.actions.push('select:' + radio.textContent);
                        if (${ignoreSelection}) return;
                        setTimeout(() => {
                            card.querySelectorAll('[role=radio]').forEach(item => {
                                const checked = item.textContent === radio.textContent;
                                item.setAttribute('aria-checked', String(checked));
                                item.setAttribute('data-state', checked ? 'on' : 'off');
                            });
                            if (${rerender}) {
                                card.outerHTML = card.outerHTML;
                                bindPro();
                            }
                        }, ${selectionDelay});
                    };
                });
                card.querySelector('#pro-upgrade').onclick = () => {
                    window.actions.push('pro:' + card.querySelector('[aria-checked=true]').textContent);
                };
            }
            bindPro();
        </script>
    `;
}

describe.skipIf(!browserAvailable)('pricing plan expansion in Chromium', () => {
    let browser;
    beforeAll(async () => {
        browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    });
    afterAll(async () => { if (browser) await browser.close(); });

    it.each([
        ['link', 0],
        ['button', 1500]
    ])('expands a compact pricing view using a %s and waits for the Go button', async (control, controlDelay) => {
        const page = await browser.newPage();
        try {
            const expandControl = control === 'link'
                ? '<a href="#" id="all">See all plans</a>'
                : '<button id="all">See all plans</button>';
            await page.setContent(`
                <main>
                    <div><button disabled>Your current plan</button><button id="plus">Upgrade to Plus</button></div>
                    <div id="all-wrapper"></div>
                    <div id="expanded"></div>
                </main>
                <script>
                    window.actions = [];
                    document.querySelector('#plus').onclick = () => window.actions.push('plus');
                    setTimeout(() => {
                        document.querySelector('#all-wrapper').innerHTML = '${expandControl}';
                        document.querySelector('#all').onclick = (event) => {
                            event.preventDefault();
                            window.actions.push('expand');
                            setTimeout(() => {
                                document.querySelector('#expanded').innerHTML = '<div><h3>Go</h3><button id="go" type="button" class="no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full border-default bg-primary-solid not-disabled:not-aria-disabled:hover:bg-text/80 data-[state=open]:bg-text/80 text-primary-solid min-h-11 justify-center px-4 text-sm font-medium w-full justify-center">Upgrade to Go</button></div>';
                                document.querySelector('#go').onclick = () => window.actions.push('go');
                            }, 350);
                        };
                    }, ${controlDelay});
                </script>
            `);
            await loadSelector()(page, 'go');
            expect(await page.evaluate(() => window.actions)).toEqual(['expand', 'go']);
        } finally {
            await page.close();
        }
    });

    it('clicks a visible Go button without opening the plan list again', async () => {
        const page = await browser.newPage();
        try {
            await page.setContent(`
                <main><button id="go">Upgrade to Go</button><a href="#" id="all">See all plans</a></main>
                <script>
                    window.actions = [];
                    document.querySelector('#all').onclick = (event) => { event.preventDefault(); window.actions.push('expand'); };
                    document.querySelector('#go').onclick = () => window.actions.push('go');
                </script>
            `);
            await loadSelector()(page, 'go');
            expect(await page.evaluate(() => window.actions)).toEqual(['go']);
        } finally {
            await page.close();
        }
    });

    it('reports an unavailable Go plan instead of clicking Plus after expansion', async () => {
        const page = await browser.newPage();
        try {
            await page.setContent(`
                <main>
                    <div><div>ChatGPT Go is not available</div><button id="plus">Upgrade to Plus</button></div>
                    <button id="all">See all plans</button>
                </main>
                <script>
                    window.actions = [];
                    document.querySelector('#plus').onclick = () => window.actions.push('plus');
                    document.querySelector('#all').onclick = () => window.actions.push('expand');
                </script>
            `);
            await expect(loadSelector()(page, 'go')).rejects.toThrow('已展开全部套餐，但未找到或无法点击 Go');
            expect(await page.evaluate(() => window.actions)).toEqual(['expand']);
        } finally {
            await page.close();
        }
    });

    it.each([
        ['pro_10x', '100', '500'],
        ['pro_20x', '200', '100'],
        ['pro_50x', '500', '100']
    ])('selects the numeric tier for %s before the generic Pro upgrade', async (plan, tier, selected) => {
        const page = await browser.newPage();
        try {
            await page.setContent(`<main>
                <aside><button role="radio" aria-checked="false">${tier}</button></aside>
                <div hidden><h3>Pro</h3><button>Upgrade to Pro</button></div>
                ${proCardFixture({ selected, selectionDelay: 150, rerender: true })}
            </main>`);
            await loadSelector()(page, plan);
            expect(await page.evaluate(() => window.actions)).toEqual([`select:${tier}`, `pro:${tier}`]);
        } finally {
            await page.close();
        }
    });

    it('expands compact pricing and waits for Pro radios before upgrading', async () => {
        const page = await browser.newPage();
        try {
            await page.setContent(`<main>
                <button id="plus">Upgrade to Plus</button>
                <a href="#" id="all">See all plans</a>
                <div id="expanded"></div>
                <script>
                    window.actions = [];
                    document.querySelector('#plus').onclick = () => window.actions.push('plus');
                    document.querySelector('#all').onclick = (event) => {
                        event.preventDefault();
                        window.actions.push('expand');
                        setTimeout(() => {
                            document.querySelector('#expanded').innerHTML = '<section><h3>Pro</h3><div id="tiers"></div><button id="pro">Upgrade to Pro</button></section>';
                            document.querySelector('#pro').onclick = () => window.actions.push('pro:' + document.querySelector('[aria-checked=true]').textContent);
                            setTimeout(() => {
                                document.querySelector('#tiers').innerHTML = ['100', '200', '500'].map(tier => '<button role="radio" aria-checked="' + (tier === '100') + '">' + tier + '</button>').join('');
                                document.querySelectorAll('[role=radio]').forEach(radio => {
                                    radio.onclick = () => {
                                        window.actions.push('select:' + radio.textContent);
                                        document.querySelectorAll('[role=radio]').forEach(item => item.setAttribute('aria-checked', String(item === radio)));
                                    };
                                });
                            }, 350);
                        }, 200);
                    };
                </script>
            </main>`);
            await loadSelector()(page, 'pro_20x');
            expect(await page.evaluate(() => window.actions)).toEqual(['expand', 'select:200', 'pro:200']);
        } finally {
            await page.close();
        }
    });

    it('keeps an already selected target tier without toggling it again', async () => {
        const page = await browser.newPage();
        try {
            await page.setContent(`<main>${proCardFixture({ selected: '500' })}</main>`);
            await loadSelector()(page, 'pro_50x');
            expect(await page.evaluate(() => window.actions)).toEqual(['pro:500']);
        } finally {
            await page.close();
        }
    });

    it.each([
        ['missing', { tiers: ['100', '500'] }],
        ['disabled', { disabled: '200' }],
        ['unchanged', { ignoreSelection: true }],
        ['duplicate', { tiers: ['100', '200', '200', '500'] }]
    ])('does not click Upgrade to Pro when the requested tier is %s', async (_, options) => {
        const page = await browser.newPage();
        try {
            await page.setContent(`<main>
                <button id="plus">Upgrade to Plus</button>
                <button>Upgrade</button>
                ${proCardFixture(options)}
                <script>document.querySelector('#plus').onclick = () => window.actions.push('plus');</script>
            </main>`);
            await expect(loadSelector()(page, 'pro_20x')).rejects.toThrow('已停止创建，不使用默认档位');
            expect(await page.evaluate(() => window.actions)).toEqual(options.ignoreSelection ? ['select:200'] : []);
        } finally {
            await page.close();
        }
    });

    it('does not use numeric radios outside the Pro card', async () => {
        const page = await browser.newPage();
        try {
            await page.setContent(`<main>
                <aside><button role="radio" aria-checked="true">200</button></aside>
                ${proCardFixture({ tiers: [] })}
            </main>`);
            await expect(loadSelector()(page, 'pro_20x')).rejects.toThrow('不使用默认档位');
            expect(await page.evaluate(() => window.actions)).toEqual([]);
        } finally {
            await page.close();
        }
    });

    it('rejects ambiguous Pro cards instead of using the first card', async () => {
        const page = await browser.newPage();
        try {
            await page.setContent(`<main>${proCardFixture()}<article><h3>Pro</h3><button>Upgrade to Pro</button></article></main>`);
            await expect(loadSelector()(page, 'pro_50x')).rejects.toThrow('无法唯一定位');
            expect(await page.evaluate(() => window.actions)).toEqual([]);
        } finally {
            await page.close();
        }
    });
});
