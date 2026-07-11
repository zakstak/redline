import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright',
  use: {
    baseURL: 'http://127.0.0.1:4324',
    headless: true
  },
  webServer: {
    command: 'PORT=4324 npm run start',
    url: 'http://127.0.0.1:4324/api/health',
    reuseExistingServer: false,
    timeout: 120000
  }
});
