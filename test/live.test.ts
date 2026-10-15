import { describe, expect, it } from "vitest";
import { LendlordClient } from "../src/client.js";

// Read-only smoke test against the real Lendlord API.
// Opt in with LENDLORD_LIVE_TESTS=1 plus LENDLORD_EMAIL/LENDLORD_PASSWORD (or LENDLORD_SESSION_COOKIE).
const live = process.env.LENDLORD_LIVE_TESTS === "1";

describe.skipIf(!live)("live Lendlord API (read-only)", () => {
  const client = LendlordClient.fromEnv();

  it("logs in and reads the account", async () => {
    const me = await client.get<{ email: string; clientDetailsId: string }>("/api/getUserFromCookie");
    expect(me.clientDetailsId).toBeTruthy();
    const user = await client.get<{ portfolioDetails: unknown[] }>("/api/getUserById");
    expect(Array.isArray(user.portfolioDetails)).toBe(true);
  }, 60_000);

  it("lists documents", async () => {
    expect(Array.isArray(await client.get("/api/documents"))).toBe(true);
  }, 30_000);
});
