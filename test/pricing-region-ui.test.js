'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const { pageShowsTargetRegionPricing, selectPricingRegion } = require('../src/checkout/pricing-checkout');

const browserAvailable = fs.existsSync(chromium.executablePath());

describe.skipIf(!browserAvailable)('Egypt pricing region in local Chromium', () => {
    let browser;
    let page;

    beforeAll(async () => {
        browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    });
    beforeEach(async () => {
        page = await browser.newPage();
        await page.route('**/*', route => route.abort('blockedbyclient'));
    });
    afterEach(async () => { if (page) await page.close(); });
    afterAll(async () => { if (browser) await browser.close(); });

    it.each(['EGP 400', '400 EGP', 'E£ 400', '400 E£', '400 ج.م.'])('recognizes Egypt prices: %s', async price => {
        await page.setContent(`<main><h2>Plus</h2><p>${price} / month</p></main>`);
        expect(await pageShowsTargetRegionPricing(page, 'EG')).toBe(true);
    });

    it.each(['Egypt $20 / month', 'Egypt £20 / month'])('does not mistake foreign currency for EGP: %s', async price => {
        await page.setContent(`<main><h2>Plus</h2><p>${price}</p></main>`);
        expect(await pageShowsTargetRegionPricing(page, 'EG')).toBe(false);
    });

    // Keep real DOM/scroll/click behavior, but shorten deliberate pacing sleeps.
    function quickPage() {
        return new Proxy(page, {
            get(target, property) {
                if (property === 'waitForTimeout') return delay => target.waitForTimeout(Math.min(delay, 15));
                const value = target[property];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    }

    it.each(['Egypt', '埃及'])('selects the %s country label and verifies EGP pricing', async label => {
        await page.setContent(`
            <main>
                <h2>Plus</h2><p id="price">USD 20 / month</p>
                <button id="region" aria-haspopup="listbox" aria-expanded="false">United States</button>
                <div id="countries" role="listbox" style="display:none;height:120px;overflow:auto">
                    <button role="option" id="egypt">${label}</button>
                </div>
            </main>
            <script>
                window.selected = [];
                const trigger = document.querySelector('#region');
                const countries = document.querySelector('#countries');
                trigger.onclick = () => { countries.style.display = 'block'; trigger.setAttribute('aria-expanded', 'true'); };
                document.querySelector('#egypt').onclick = () => {
                    window.selected.push(${JSON.stringify(label)});
                    trigger.textContent = ${JSON.stringify(label)};
                    trigger.setAttribute('aria-expanded', 'false');
                    countries.style.display = 'none';
                    document.querySelector('#price').textContent = 'EGP 400 / month';
                };
            </script>
        `);
        await selectPricingRegion(quickPage(), 'EG');
        expect(await page.evaluate(() => window.selected)).toEqual([label]);
        expect(await pageShowsTargetRegionPricing(page, 'EG')).toBe(true);
    });

    it('finds Egypt before the midpoint of a virtualized country list', async () => {
        await page.setContent(`
            <style>
                #countries { display:none; height:120px; overflow:auto; position:relative; }
                #spacer { height:3000px; position:relative; }
                .country { position:absolute; height:30px; width:180px; }
            </style>
            <main>
                <h2>Plus</h2><p id="price">USD 20 / month</p>
                <button id="region" aria-haspopup="listbox" aria-expanded="false">United States</button>
                <div id="countries" role="listbox"><div id="spacer"></div></div>
            </main>
            <script>
                window.selected = [];
                window.scrollPositions = [];
                const viewport = document.querySelector('#countries');
                const trigger = document.querySelector('#region');
                function render() {
                    window.scrollPositions.push(viewport.scrollTop);
                    const first = Math.floor(viewport.scrollTop / 30);
                    const labels = Array.from({ length: 100 }, (_, index) => index === 18 ? 'Egypt' : 'Country ' + index);
                    document.querySelector('#spacer').innerHTML = labels.slice(first, first + 5).map((name, offset) =>
                        '<button role="option" class="country" style="top:' + ((first + offset) * 30) + 'px">' + name + '</button>'
                    ).join('');
                    document.querySelectorAll('.country').forEach(option => {
                        option.onclick = () => {
                            if (option.textContent !== 'Egypt') return;
                            window.selected.push('Egypt');
                            trigger.textContent = 'Egypt';
                            trigger.setAttribute('aria-expanded', 'false');
                            viewport.style.display = 'none';
                            document.querySelector('#price').textContent = 'EGP 400 / month';
                        };
                    });
                }
                viewport.onscroll = render;
                trigger.onclick = () => {
                    viewport.style.display = 'block';
                    trigger.setAttribute('aria-expanded', 'true');
                    render();
                };
            </script>
        `);
        await selectPricingRegion(quickPage(), 'EG');
        expect(await page.evaluate(() => window.selected)).toEqual(['Egypt']);
        expect(await pageShowsTargetRegionPricing(page, 'EG')).toBe(true);
    });
});
