// Dev-only e2e config. Run: npx playwright install chromium && npm run test:e2e
// Locally you can reuse an installed Chrome instead: CHROME_PATH=/usr/bin/google-chrome npm run test:e2e
import { defineConfig, devices } from '@playwright/test';

const PORT = 8787;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    trace: 'retain-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Pixel 7'],
      ...(process.env.CHROME_PATH ? { launchOptions: { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } } : {}),
    },
  }],
  webServer: {
    command: `node tests/serve.mjs`,
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
