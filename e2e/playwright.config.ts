import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Two servers are started automatically:
 *  1. the real Cloudflare Worker under `wrangler dev` (workerd), and
 *  2. a production build of the frontend served by `vite preview` from the
 *     `/set/` subpath, so the GitHub Pages base-path handling is exercised
 *     rather than assumed.
 *
 * Tests run against a narrow phone viewport and a desktop viewport.
 */

const WORKER_PORT = 8787;
const APP_PORT = 4173;
const APP_BASE = `http://127.0.0.1:${APP_PORT}/set/`;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: APP_BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Chromium is preinstalled in this environment; see README for other browsers.
    launchOptions: { args: ['--disable-dev-shm-usage'] },
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 5'],
        // A deliberately narrow, short viewport: the tightest layout we support.
        viewport: { width: 360, height: 640 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      command: 'npm run dev --workspace worker',
      url: `http://127.0.0.1:${WORKER_PORT}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      cwd: '..',
      // Piped, not ignored: when a server fails to start, its output is the only
      // way to tell why, and Playwright only prints it on failure.
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run build:e2e --workspace frontend && npm run preview:e2e --workspace frontend',
      url: APP_BASE,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      cwd: '..',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
