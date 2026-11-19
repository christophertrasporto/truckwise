import { afterAll, describe, expect, it } from "vitest";
import { assertLoginAllowed, clearFailedLogins, recordFailedLogin } from "@/server/auth/login-limit";
import { closeDb } from "@/server/db";
import { admin } from "../helpers";

afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

const email = () => `guess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

describe("slowing down password guessing", () => {
  it("allows a few mistakes, then refuses further tries for that email", async () => {
    const e = email();
    for (let i = 0; i < 8; i++) {
      await assertLoginAllowed(e, `10.9.0.${i}`);
      await recordFailedLogin(e, `10.9.0.${i}`);
    }
    await expect(assertLoginAllowed(e, "10.9.1.1")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    // another person is not affected
    await expect(assertLoginAllowed(email(), "10.9.1.2")).resolves.toBeUndefined();
  });

  it("is not case sensitive about the email", async () => {
    const e = email();
    for (let i = 0; i < 8; i++) await recordFailedLogin(e.toUpperCase(), "10.9.2.1");
    await expect(assertLoginAllowed(e, "10.9.2.2")).rejects.toMatchObject({ status: 429 });
  });

  it("refuses an address that keeps failing against many emails", async () => {
    const ip = `10.9.3.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < 40; i++) await recordFailedLogin(email(), ip);
    await expect(assertLoginAllowed(email(), ip)).rejects.toMatchObject({ status: 429 });
  });

  it("forgets an email's failures after a good sign-in", async () => {
    const e = email();
    for (let i = 0; i < 8; i++) await recordFailedLogin(e, "10.9.4.1");
    await clearFailedLogins(e);
    await expect(assertLoginAllowed(e, "10.9.4.2")).resolves.toBeUndefined();
  });

  it("stores only hashes, never the email or the address", async () => {
    const e = email();
    await recordFailedLogin(e, "203.0.113.77");
    const rows = JSON.stringify(await admin.sql`select * from login_attempts order by id desc limit 5`);
    expect(rows).not.toContain(e);
    expect(rows).not.toContain("203.0.113.77");
  });
});
