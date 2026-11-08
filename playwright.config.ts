import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

/**
 * Рушій браузера: у GitHub Actions — WebKit (рушій Safari, як на iPad/iPhone),
 * локально — Chromium з емуляцією пристроїв. Можна перевизначити: PW_BROWSER=webkit|chromium.
 */
const browserName = (process.env.PW_BROWSER ?? (CI ? 'webkit' : 'chromium')) as 'webkit' | 'chromium';

const PORT = 4173;
export const BASE_PATH = '/duct-route-3d/';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/artifacts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI
    ? [['list'], ['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    browserName,
    trace: 'off',
  },
  projects: [
    {
      // iPad Air 11" / iPad Pro 11" у горизонтальній орієнтації (≈1180 × 820), мишка й дотик.
      name: 'iPad landscape',
      use: {
        ...devices['iPad Pro 11 landscape'],
        browserName,
        viewport: { width: 1180, height: 820 },
      },
    },
    {
      name: 'iPhone 15 Pro Max',
      use: { ...devices['iPhone 15 Pro Max'], browserName },
    },
    {
      name: 'iPhone 15 Pro Max landscape',
      use: { ...devices['iPhone 15 Pro Max landscape'], browserName },
    },
  ],
  webServer: {
    // Перевіряємо саме зібрану версію — таку, як на GitHub Pages.
    // У CI збірка вже зроблена попереднім кроком — і саме вона піде на Pages.
    command: CI ? 'npm run preview' : 'npm run build && npm run preview',
    url: `http://localhost:${PORT}${BASE_PATH}`,
    reuseExistingServer: !CI,
    timeout: 120_000,
  },
});
