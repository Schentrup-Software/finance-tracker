import { defineConfig } from "@playwright/test";

// Needs a fresh local PocketBase: `RESET=1 npm run pb` (sign-up is only open
// while there are no users), then `npm run test:e2e`.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1280, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    cwd: "..",
  },
});
