import { beforeAll, describe, expect, it } from "vitest";
import { LendlordClient, LendlordError } from "../src/client.js";
import { decrypt, encrypt } from "../src/crypto.js";

const KEY = "0123456789abcdef0123456789abcdef";

beforeAll(() => {
  process.env.LENDLORD_PAYLOAD_KEY = KEY;
});

/** Minimal fake of the Lendlord server: cookie session + encrypted bodies. */
function fakeServer() {
  const calls: { method: string; path: string; body?: unknown; cookie?: string }[] = [];
  let validSession = "s1";
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(status === 200 ? encrypt(KEY, JSON.stringify(body)) : String(body), { status, headers });

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const cookie = (init?.headers as Record<string, string>)?.cookie;
    const raw = typeof init?.body === "string" ? JSON.parse(decrypt(KEY, init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body: raw, cookie });

    if (url.pathname === "/api/loginUser") {
      if (raw.password !== "pw") return reply(401, "Email or password do not match");
      return reply(200, { ok: true }, { "set-cookie": `sid=${validSession}; Path=/; HttpOnly` });
    }
    if (cookie !== `sid=${validSession}`) return reply(401, "Unauthorized");
    if (url.pathname === "/api/getUserFromCookie") return reply(200, { passedTwoFA: true });
    // Double-encoded, like the real getUserById.
    if (url.pathname === "/api/getUserById") return reply(200, JSON.stringify({ portfolioDetails: [{ _id: "p1" }] }));
    if (url.pathname === "/api/echo") return reply(200, { got: raw, q: url.searchParams.get("x") });
    if (url.pathname === "/api/rotate") {
      validSession = "s2";
      return reply(200, {});
    }
    return reply(404, "Not found");
  }) as typeof fetch;

  return { impl, calls };
}

describe("LendlordClient", () => {
  it("logs in lazily, sends the session cookie, and decodes double-encoded JSON", async () => {
    const { impl, calls } = fakeServer();
    const client = new LendlordClient({ email: "a@b.c", password: "pw", fetch: impl });
    const user = await client.get<{ portfolioDetails: { _id: string }[] }>("/api/getUserById");
    expect(user.portfolioDetails[0]!._id).toBe("p1");
    expect(calls[0]).toMatchObject({ path: "/api/loginUser", body: { email: "a@b.c", password: "pw", keepMeLoggedIn: true } });
    expect(calls.at(-1)!.cookie).toBe("sid=s1");
  });

  it("encrypts JSON bodies and passes query params", async () => {
    const { impl } = fakeServer();
    const client = new LendlordClient({ email: "a@b.c", password: "pw", fetch: impl });
    expect(await client.post("/api/echo?x=1", { a: 1 })).toEqual({ got: { a: 1 }, q: "1" });
    expect(await client.get("/api/echo", { x: 2 })).toEqual({ got: undefined, q: "2" });
  });

  it("re-logs in once when the session expires", async () => {
    const { impl, calls } = fakeServer();
    const client = new LendlordClient({ email: "a@b.c", password: "pw", fetch: impl });
    await client.post("/api/rotate", {}); // server now only accepts sid=s2
    await expect(client.get("/api/getUserById")).resolves.toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/loginUser")).toHaveLength(2);
  });

  it("surfaces API errors with status and path", async () => {
    const { impl } = fakeServer();
    const client = new LendlordClient({ email: "a@b.c", password: "wrong", fetch: impl });
    const err = await client.get("/api/getUserById").catch((e) => e);
    expect(err).toBeInstanceOf(LendlordError);
    expect(err).toMatchObject({ status: 401, path: "/api/loginUser" });
  });
});
