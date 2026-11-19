import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://smartload:smartload@localhost:5432/smartload";
const e2eDb = "smartload_e2e";
const withDb = (db: string) => {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
};
const appPassword = process.env.APP_DB_PASSWORD ?? "smartload_app";
const PORT = 3100;

// Read by tests/e2e/global-setup.ts (runs in this process).
process.env.TEST_ADMIN_URL = withDb(e2eDb);

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Pixel 7"], trace: "retain-on-failure" },
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      NEXT_DIST_DIR: ".next-e2e",
      DATABASE_URL: `postgres://smartload_app:${appPassword}@${new URL(adminUrl).host}/${e2eDb}`,
      STORAGE_DIR: path.resolve(".storage-e2e"),
      STORAGE_SIGNING_SECRET: "e2e-signing-secret",
      NODE_ENV: "production",
    },
  },
});
