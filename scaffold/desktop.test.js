/**
 * Example functional test for your desktop app using Playwright.
 *
 * Install Playwright with Electron support:
 *   npm install --save-dev @playwright/test playwright
 *
 * See https://playwright.dev/docs/api/class-electronapplication for the full API.
 * Run with: npm run test-desktop
 */
import { test, expect, _electron as electron } from '@playwright/test';

test.describe('desktop app', () => {
    let electronApp;

    test.beforeEach(async () => {
        electronApp = await electron.launch({
            args: ['.meteor/desktop-build'],
            env: { NODE_ENV: 'test', ELECTRON_ENV: 'test', METEOR_DESKTOP_NO_SPLASH_SCREEN: '1' }
        });
    });

    test.afterEach(async () => {
        if (electronApp) {
            await electronApp.close();
        }
    });

    test('app window appears', async () => {
        const window = await electronApp.firstWindow();
        await window.waitForLoadState('domcontentloaded');
        // Replace with assertions specific to your app.
        expect(await electronApp.windows()).toHaveLength(1);
    });
});
