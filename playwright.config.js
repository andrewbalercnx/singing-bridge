// File: playwright.config.js
// Purpose: Playwright E2E test configuration — fake media, local dev server.
// Last updated: Sprint 9 (2026-04-20) -- initial E2E test suite

'use strict';

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,   // WebRTC tests are stateful — run sequentially
  workers: 1,             // all tests in the same worker → shared RUN_ID module state
  retries: 0,
  reporter: 'list',

  use: {
    baseURL: 'http://localhost:8080',
    // Fake camera/mic so tests run headlessly without real devices.
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--allow-file-access-from-files',
      ],
    },
    // Explicitly grant permissions so getUserMedia resolves immediately.
    permissions: ['camera', 'microphone'],
    headless: true,
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start (and stop) the dev server automatically.
  webServer: {
    command: 'cargo run -p singing-bridge-server',
    url: 'http://localhost:8080/healthz',
    timeout: 60_000,
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
