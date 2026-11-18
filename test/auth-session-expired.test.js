'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const {
    isLoginPageContent,
    hasVisibleLoginChrome,
    buildSessionNotLoggedInError
} = require('../src/browser/auth-page-detect');
const { assertChatGptLoggedIn, applyVerifiedSessionApiData } = require('../src/browser/session-auth');

const browserAvailable = fs.existsSync(chromium.executablePath());

describe.skipIf(!browserAvailable)('ChatGPT session-expired screen detection in Chromium', () => {
    let browser;
    let page;

    beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() }); });
    afterAll(async () => { await browser?.close(); });
    beforeEach(async () => {
        page = await browser.newPage();
        await page.route('**/*', route => route.abort());
    });
    afterEach(async () => { await page?.close(); });

    it('recognizes the exact expired-session modal from the failed task', async () => {
        await page.setContent(`
            <main><section role="dialog" aria-modal="true">
                <h2>Your session has expired</h2>
                <p>Please log in again to continue using the app</p>
                <button type="button">Log in</button>
            </section><button>Sign out</button></main>`);
        expect(await isLoginPageContent(page)).toBe(true);
        expect(await hasVisibleLoginChrome(page)).toBe(true);
    });

    it('makes the expired session the reported failure cause', async () => {
        await page.setContent(`
            <main><section role="dialog">
                <h2>Your session has expired</h2>
                <p>Please log in again to continue using the app</p>
                <button>Log in</button>
            </section></main>`);
        await expect(assertChatGptLoggedIn(page, 'Personal 套餐切换'))
            .rejects.toThrow(/session.*expired|会话.*过期/i);
        expect(buildSessionNotLoggedInError('Personal 套餐切换')).toMatch(/Personal 套餐切换/);
    });

    it('does not mistake normal logged-in page chrome for an expired session', async () => {
        await page.setContent('<main><nav><button>New chat</button></nav><h1>Ask anything</h1></main>');
        expect(await isLoginPageContent(page)).toBe(false);
        await expect(assertChatGptLoggedIn(page, '定价页')).resolves.toBeUndefined();
    });
});

describe('verified ChatGPT session API data', () => {
    const oldToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
        'https://api.openai.com/profile': { email: 'user@example.com' }
    })).toString('base64url')}.signature`;
    const refreshedToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
        'https://api.openai.com/profile': { email: 'user@example.com' }
    })).toString('base64url')}.refreshed`;

    it('uses the current token returned by the verified cookie session', () => {
        const result = applyVerifiedSessionApiData(
            { user: { email: 'user@example.com' }, accessToken: oldToken },
            oldToken,
            { user: { email: 'user@example.com' }, accessToken: refreshedToken }
        );
        expect(result.accessToken).toBe(refreshedToken);
        expect(result.sessionData.accessToken).toBe(refreshedToken);
    });

    it('rejects a cookie and access token belonging to different accounts', () => {
        const otherToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
            'https://api.openai.com/profile': { email: 'other@example.com' }
        })).toString('base64url')}.signature`;
        expect(() => applyVerifiedSessionApiData(
            { user: { email: 'user@example.com' }, accessToken: oldToken },
            oldToken,
            { user: { email: 'other@example.com' }, accessToken: otherToken }
        )).toThrow(/different accounts|不同账号/);
    });
});
