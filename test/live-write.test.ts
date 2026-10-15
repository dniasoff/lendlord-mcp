import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LendlordClient } from "../src/client.js";
import { Lendlord } from "../src/lendlord.js";
import { createSessionServer } from "../src/server.js";

// Live write round-trip against a real Lendlord account. Creates a throwaway
// property ("ZZ TEST lendlord-mcp ...") and deletes it afterwards.
//   LENDLORD_LIVE_WRITE_TESTS=1   property create/update/delete
//   LENDLORD_LIVE_UPLOAD_TESTS=1  also upload/rename/delete a document (uses 1 upload of quota)
const live = process.env.LENDLORD_LIVE_WRITE_TESTS === "1";
const uploads = process.env.LENDLORD_LIVE_UPLOAD_TESTS === "1";

describe.skipIf(!live)("live Lendlord writes", () => {
  let client: Client;
  let propertyId: string | undefined;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    if (res.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };

  beforeAll(async () => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createSessionServer(new Lendlord(LendlordClient.fromEnv()), { readOnly: false, autoConfirm: false }).connect(s);
    client = new Client({ name: "live-write-test", version: "0" });
    await client.connect(c);
  });

  afterAll(async () => {
    if (propertyId) await call("delete_property", { propertyId }).catch(() => undefined);
  });

  it("requires confirmation once, then creates a property", async () => {
    const args = { address: `ZZ TEST lendlord-mcp ${Date.now()} - DELETE ME`, postcode: "ZZ1 1ZZ", city: "Testville", fields: { "Property Value": 1234 } };
    await expect(call("add_property", args)).rejects.toThrow(/Confirmation needed/);
    const res = await call("add_property", { ...args, confirm: true });
    propertyId = res.created[0].id;
    const p = await call("get_property", { propertyId });
    expect(p.fields).toMatchObject({ "Property Address": args.address, "Property Postcode": "ZZ1 1ZZ", "Property City": "Testville", "Property Value": 1234 });
  }, 60_000);

  it("updates only the given fields (no second confirmation) and clears with null", async () => {
    await call("update_property", { propertyId, fields: { "Property Value": 3000, Lender: "Test Bank", "EPC Due Date": "2030-01-01" } });
    let p = await call("get_property", { propertyId });
    expect(p.fields).toMatchObject({ "Property Value": 3000, Lender: "Test Bank", "Property City": "Testville", "Property Postcode": "ZZ1 1ZZ" });
    expect(String(p.fields["EPC Due Date"])).toMatch(/^2030-01-01/);

    await call("update_property", { propertyId, fields: { Lender: null } });
    p = await call("get_property", { propertyId });
    expect(p.fields.Lender).toBeUndefined();
    expect(p.fields["Property Value"]).toBe(3000);
  }, 60_000);

  it.skipIf(!uploads)("uploads, renames and deletes a document", async () => {
    const doc = await call("upload_document", {
      entityId: propertyId,
      key: `zzMcpTest${Date.now()}`,
      base64: Buffer.from("lendlord-mcp live test").toString("base64"),
      fileName: "zz-mcp-test.txt",
    });
    expect(doc.entities).toEqual([expect.objectContaining({ entityType: "property", entityId: propertyId })]);

    await call("rename_document", { documentId: doc._id, name: "zz-mcp-renamed.txt" });
    let docs = await call("list_documents", { entityId: propertyId });
    expect(docs.find((d: { id: string }) => d.id === doc._id)?.name).toBe("zz-mcp-renamed.txt");

    await call("delete_document", { documentId: doc._id, entityId: propertyId });
    docs = await call("list_documents", { entityId: propertyId });
    expect(docs.find((d: { id: string }) => d.id === doc._id)).toBeUndefined();
  }, 90_000);

  it("deletes the property", async () => {
    await call("delete_property", { propertyId });
    const props = await call("list_properties", {});
    expect(props.find((p: { id: string }) => p.id === propertyId)).toBeUndefined();
    propertyId = undefined;
  }, 60_000);
});
