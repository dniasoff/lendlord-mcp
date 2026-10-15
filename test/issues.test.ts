import { beforeAll, describe, expect, it } from "vitest";
import { LendlordClient, LendlordError, RETRY_DELAYS_MS } from "../src/client.js";
import { encrypt } from "../src/crypto.js";
import { coerceValue, FieldError } from "../src/fields.js";
import type { Lendlord } from "../src/lendlord.js";
import { listCommunications } from "../src/tools.js";
import { uploadDocument } from "../src/write-tools.js";

const KEY = "0123456789abcdef0123456789abcdef";

beforeAll(() => {
  process.env.LENDLORD_PAYLOAD_KEY = KEY;
  RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 1, 1); // keep retries fast in tests
});

describe("field coercion (#6)", () => {
  const ok: [Parameters<typeof coerceValue>[0], string, unknown, unknown][] = [
    ["area", "Internal Area", "73 square metres", 73],
    ["area", "Internal Area", "73sqm", 73],
    ["area", "Internal Area", "790 sq ft", 73.4],
    ["area", "Internal Area", 73, 73],
    ["number", "Property Value", "£150,000", 150000],
    ["number", "Property Value", "150k", 150000],
    ["number", "Property Value", "1.2m", 1200000],
    ["number", "Rental Monthly Income", "£650 pcm", 650],
    ["percent", "Current Rate", "4.5%", 0.045],
    ["percent", "Current Rate", 4.5, 0.045],
    ["percent", "Current Rate", 0.045, 0.045],
    ["percent", "Ownership Percentage 1", 1, 1],
    ["percent", "Ownership Percentage 1", "50%", 0.5],
    ["date", "EPC Due Date", "2030-01-01", "2030-01-01T00:00:00.000Z"],
    ["date", "Date of Purchase", "15/10/2026", "2026-10-15T00:00:00.000Z"],
  ];
  it.each(ok)("%s %s %j -> %j", (kind, field, input, expected) => {
    expect(coerceValue(kind, field, input)).toEqual(expected);
  });

  const bad: [Parameters<typeof coerceValue>[0], string, unknown][] = [
    ["area", "Internal Area", "73 m"], // not "73 million"
    ["area", "Internal Area", "73 sqm (785 sq ft)"],
    ["number", "Property Value", "about 150k"],
    ["date", "EPC Due Date", "next March"],
    ["number", "Number of Bedrooms", true],
  ];
  it.each(bad)("rejects %s %s %j with a field error", (kind, field, input) => {
    expect(() => coerceValue(kind, field, input)).toThrow(FieldError);
    expect(() => coerceValue(kind, field, input)).toThrow(field);
  });
});

/** Fake Lendlord that fails the first N requests to a path with the given status/body. */
function flakyServer(failures: Record<string, { times: number; status: number; body: string }>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    if (url.pathname === "/api/loginUser") {
      return new Response(encrypt(KEY, "{}"), { status: 200, headers: { "set-cookie": "sid=x" } });
    }
    if (url.pathname === "/api/getUserFromCookie") return new Response(encrypt(KEY, '{"passedTwoFA":true}'));
    const f = failures[key];
    if (f && f.times > 0) {
      f.times--;
      return new Response(f.body, { status: f.status });
    }
    if (url.pathname.startsWith("/api/documents/property/"))
      return new Response(encrypt(KEY, JSON.stringify(docsOnServer)));
    if (key === "POST /api/documents") {
      const doc = { _id: `d${calls.length}`, key: "k1", name: "a.txt", createdAt: new Date().toISOString() };
      docsOnServer.push(doc);
      return new Response(encrypt(KEY, JSON.stringify(doc)));
    }
    return new Response(encrypt(KEY, '{"ok":true}'));
  }) as typeof fetch;
  let docsOnServer: Record<string, unknown>[] = [];
  return {
    client: new LendlordClient({ email: "a@b.c", password: "pw", fetch: impl }),
    calls,
    setDocs: (d: Record<string, unknown>[]) => {
      docsOnServer = d;
    },
  };
}

describe("transient error retries (#7)", () => {
  it("marks gateway errors and Lendlord's socket hang up 500s as transient, not cast errors", () => {
    expect(new LendlordError("socket hang up", 500, "/x").transient).toBe(true);
    expect(new LendlordError("Bad Gateway", 502, "/x").transient).toBe(true);
    expect(new LendlordError("fetch failed (ECONNRESET)", 0, "/x").transient).toBe(true);
    expect(new LendlordError("Cast to Number failed", 500, "/x").transient).toBe(false);
  });

  it("retries idempotent requests", async () => {
    const s = flakyServer({ "GET /api/pnlData": { times: 2, status: 503, body: "busy" } });
    await expect(s.client.get("/api/pnlData")).resolves.toEqual({ ok: true });
    expect(s.calls.filter((c) => c === "GET /api/pnlData")).toHaveLength(3);
  });

  it("does not blindly retry POSTs", async () => {
    const s = flakyServer({ "POST /api/addProperties": { times: 1, status: 503, body: "busy" } });
    await expect(s.client.post("/api/addProperties", {})).rejects.toMatchObject({ status: 503 });
    expect(s.calls.filter((c) => c === "POST /api/addProperties")).toHaveLength(1);
  });

  const file = { name: "a.txt", type: "text/plain", data: new TextEncoder().encode("x") };
  const opts = { entityType: "property", entityId: "p1", key: "k1", name: "a.txt", file };

  it("upload: returns the stored document instead of re-uploading when the 500 hid a success", async () => {
    const s = flakyServer({ "POST /api/documents": { times: 1, status: 500, body: "socket hang up" } });
    s.setDocs([{ _id: "already", key: "k1", name: "a.txt", createdAt: new Date().toISOString() }]);
    const doc = await uploadDocument(s.client, opts);
    expect(doc._id).toBe("already");
    expect(s.calls.filter((c) => c === "POST /api/documents")).toHaveLength(1);
  });

  it("upload: re-uploads when the document did not land", async () => {
    const s = flakyServer({ "POST /api/documents": { times: 1, status: 500, body: "socket hang up" } });
    const doc = await uploadDocument(s.client, opts);
    expect(doc._id).toMatch(/^d/);
    expect(s.calls.filter((c) => c === "POST /api/documents")).toHaveLength(2);
  });

  it("upload: gives up after the retry budget with the original error", async () => {
    const s = flakyServer({ "POST /api/documents": { times: 9, status: 500, body: "socket hang up" } });
    await expect(uploadDocument(s.client, opts)).rejects.toMatchObject({ status: 500, message: "socket hang up" });
    expect(s.calls.filter((c) => c === "POST /api/documents")).toHaveLength(3);
  });
});

describe("listCommunications paging (#5)", () => {
  const all = Array.from({ length: 250 }, (_, i) => ({
    _id: `c${i}`,
    type: "maintenanceReport",
    propertyDetailsId: i % 2 ? "odd" : "even",
  }));
  const fake = () => {
    const requests: { limit?: number; skip?: number }[] = [];
    const lendlord = {
      client: {
        get: async (_path: string, q: { limit: number; skip: number }) => {
          requests.push(q);
          const items = all.slice(q.skip, q.skip + q.limit);
          return { communications: items, hasMore: q.skip + q.limit < all.length };
        },
      },
    } as unknown as Lendlord;
    return { lendlord, requests };
  };

  it("fetches 100-item pages up to the requested limit", async () => {
    const { lendlord, requests } = fake();
    const res = await listCommunications(lendlord, { limit: 250, skip: 0 });
    expect(res.communications).toHaveLength(250);
    expect(res.hasMore).toBe(false);
    expect(requests.map((r) => r.limit)).toEqual([100, 100, 100]);
  });

  it("stops mid-page and reports where to resume", async () => {
    const { lendlord } = fake();
    const res = await listCommunications(lendlord, { limit: 150, skip: 0 });
    expect(res.communications.at(-1)?._id).toBe("c149");
    expect(res).toMatchObject({ hasMore: true, nextSkip: 150 });
    const next = await listCommunications(lendlord, { limit: 150, skip: res.nextSkip });
    expect(next.communications[0]?._id).toBe("c150");
    expect(next.hasMore).toBe(false);
  });

  it("filters by property across pages", async () => {
    const { lendlord } = fake();
    const res = await listCommunications(lendlord, { limit: 1000, skip: 0, propertyId: "odd" });
    expect(res.communications).toHaveLength(125);
    expect(res.communications.every((c) => c.propertyDetailsId === "odd")).toBe(true);
  });
});
