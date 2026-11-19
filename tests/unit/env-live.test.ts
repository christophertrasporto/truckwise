import { describe, expect, it } from "vitest";
import { assertLiveSettings } from "@/server/env";

const good: Record<string, string> = {
  APP_ENV: "live",
  COOKIE_SECURE: "true",
  STORAGE_SIGNING_SECRET: "a".repeat(40),
  STORAGE_DIR: "/data/storage",
  DATABASE_URL: "postgres://smartload_app.abc:Xk29-long-random-pass@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require",
};

describe("live settings check", () => {
  it("does nothing off the live site, so laptops and tests are unaffected", () => {
    expect(() => assertLiveSettings({ COOKIE_SECURE: "false" })).not.toThrow();
  });
  it("accepts a safe live configuration", () => {
    expect(() => assertLiveSettings(good)).not.toThrow();
  });
  it.each([
    ["insecure cookies", { COOKIE_SECURE: "false" }, /COOKIE_SECURE/],
    ["a weak signing secret", { STORAGE_SIGNING_SECRET: "change-me" }, /STORAGE_SIGNING_SECRET/],
    ["a short signing secret", { STORAGE_SIGNING_SECRET: "short" }, /STORAGE_SIGNING_SECRET/],
    ["files on a throwaway relative folder", { STORAGE_DIR: ".storage" }, /STORAGE_DIR/],
    ["a database on this machine", { DATABASE_URL: "postgres://u:p@localhost:5432/db" }, /DATABASE_URL/],
    ["the default development password", { DATABASE_URL: "postgres://smartload_app:smartload_app@db.example.com/postgres" }, /default development password/],
  ])("refuses %s", (_name, over, message) => {
    expect(() => assertLiveSettings({ ...good, ...over })).toThrow(message);
  });
});
