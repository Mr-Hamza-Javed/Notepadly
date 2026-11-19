// End-to-end tests in a real Chromium, against the Vite dev server with the Tauri
// backend faked (e2e/boot.ts). Run with `npm run e2e`; vitest (`npm test`) does not
// pick these up (it only includes src/**/*.test.ts).
import { defineConfig, devices } from "@playwright/test";

const PORT = 1437;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: "off",
    // Edit > Cut/Copy/Paste go through navigator.clipboard (M16).
    permissions: ["clipboard-read", "clipboard-write"],
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/e2e/app.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
