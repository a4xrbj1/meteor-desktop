/**
 * Example functional test for the example module using Playwright.
 *
 * Install Playwright with Electron support:
 *   npm install --save-dev @playwright/test playwright
 *
 * See https://playwright.dev/docs/api/class-electronapplication for the full API.
 * Run with: npm run test-desktop
 */
import { test, expect, _electron as electron } from '@playwright/test';

let electronApp;

test.beforeAll(async () => {
    electronApp = await electron.launch({
        args: ['.meteor/desktop-build'],
        env: { ELECTRON_ENV: 'test' }
    });
});

test.afterAll(async () => {
    if (electronApp) {
        await electronApp.close();
    }
});

test('app window appears', async () => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    // Replace with assertions for your module.
    expect(await electronApp.windows()).toHaveLength(1);
});
