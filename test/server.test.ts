import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { LendlordClient } from "../src/client.js";
import { decrypt, encrypt } from "../src/crypto.js";
import { Lendlord } from "../src/lendlord.js";
import { createSessionServer } from "../src/server.js";
import { complianceItems } from "../src/tools.js";

const KEY = "0123456789abcdef0123456789abcdef";
beforeAll(() => {
  process.env.LENDLORD_PAYLOAD_KEY = KEY;
});

const PROPERTIES = [
  {
    _id: "p1",
    status: "active",
    property: {
      "Property Address": "1 Test Street",
      "Property Postcode": "AB1 2CD",
      "EPC Due Date": "2026-11-01T00:00:00.000Z",
    },
  },
  {
    _id: "p2",
    status: "active",
    property: {
      "Property Address": "2 Demo Road",
      "Property Postcode": "ZZ9 9ZZ",
      "Landlord Insurance End Date": "2026-01-01T00:00:00.000Z",
    },
  },
];

function fakeLendlord() {
  const writes: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const ok = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(encrypt(KEY, JSON.stringify(body)), { status: 200, headers });
    if (init?.method && init.method !== "GET" && url.pathname !== "/api/loginUser") {
      writes.push(`${init.method} ${url.pathname} ${decrypt(KEY, String(init.body))}`);
      return ok({ ok: true });
    }
    switch (url.pathname) {
      case "/api/loginUser":
        return ok({}, { "set-cookie": "sid=x; Path=/" });
      case "/api/getUserFromCookie":
        return ok({ passedTwoFA: true });
      case "/api/getUserById":
        return ok(JSON.stringify({ _id: "u1", portfolioDetails: PROPERTIES }));
      case "/api/documents":
        return ok([{ _id: "d1", name: "Gas cert", entities: [{ entityType: "property", entityId: "p1" }] }]);
      default:
        return new Response("Not found", { status: 404 });
    }
  }) as typeof fetch;
  return { lendlord: new Lendlord(new LendlordClient({ email: "a@b.c", password: "pw", fetch: impl })), writes };
}

async function connect(lendlord: Lendlord, guard = { readOnly: false, autoConfirm: false }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createSessionServer(lendlord, guard).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const write = (n: number, confirm?: boolean) => ({
  name: "lendlord_request",
  arguments: { method: "POST", path: "/api/updateProperty", body: { n }, ...(confirm ? { confirm } : {}) },
});

describe("MCP server", () => {
  it("lists properties and their documents", async () => {
    const client = await connect(fakeLendlord().lendlord);
    const props = JSON.parse(text(await client.callTool({ name: "list_properties", arguments: { search: "zz9" } })));
    expect(props).toEqual([expect.objectContaining({ id: "p2", address: "2 Demo Road" })]);
    const p1 = JSON.parse(text(await client.callTool({ name: "get_property", arguments: { propertyId: "p1" } })));
    expect(p1.documents.map((d: { name: string }) => d.name)).toEqual(["Gas cert"]);
  });

  it("asks for write confirmation once per session", async () => {
    const { lendlord, writes } = fakeLendlord();
    const session1 = await connect(lendlord);

    const first = await session1.callTool(write(1));
    expect(first.isError).toBe(true);
    expect(text(first)).toMatch(/Confirmation needed/);
    expect(writes).toHaveLength(0);

    expect((await session1.callTool(write(2, true))).isError).toBeFalsy();
    expect((await session1.callTool(write(3))).isError).toBeFalsy(); // no confirm needed any more
    expect(writes).toHaveLength(2);

    // A new session starts locked again.
    const session2 = await connect(lendlord);
    expect((await session2.callTool(write(4))).isError).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("blocks writes in read-only mode even with confirm", async () => {
    const { lendlord, writes } = fakeLendlord();
    const client = await connect(lendlord, { readOnly: true, autoConfirm: true });
    const res = await client.callTool(write(1, true));
    expect(text(res)).toMatch(/READ_ONLY/);
    expect(writes).toHaveLength(0);
  });

  it("blocks admin endpoints", async () => {
    const client = await connect(fakeLendlord().lendlord);
    const res = await client.callTool({
      name: "lendlord_request",
      arguments: { method: "GET", path: "/api/admin/coupons" },
    });
    expect(text(res)).toMatch(/blocked/);
  });
});

describe("complianceItems", () => {
  it("flags overdue and soon-due dates, soonest first", () => {
    const items = complianceItems(PROPERTIES, 90, Date.parse("2026-10-15"));
    expect(items.map((i) => [i.propertyId, i.item, i.status])).toEqual([
      ["p2", "Landlord Insurance End Date", "overdue"],
      ["p1", "EPC Due Date", "due_soon"],
    ]);
  });
});
