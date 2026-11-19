import path from "node:path";
import { defineConfig } from "vitest/config";

const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://smartload:smartload@localhost:5432/smartload";
const testDb = process.env.TEST_DB_NAME ?? "smartload_test";
const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const appPassword = process.env.APP_DB_PASSWORD ?? "smartload_app";

// globalSetup runs in this process, not in workers, so test.env alone does not reach it.
process.env.TEST_ADMIN_URL = withDb(adminUrl, testDb);

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    env: {
      STORAGE_DIR: path.resolve(import.meta.dirname, ".storage-test"),
      STORAGE_SIGNING_SECRET: "test-signing-secret",
      TEST_ADMIN_URL: withDb(adminUrl, testDb),
      DATABASE_ADMIN_URL: withDb(adminUrl, testDb),
      DATABASE_URL: `postgres://smartload_app:${appPassword}@${new URL(adminUrl).host}/${testDb}`,
    },
  },
});
