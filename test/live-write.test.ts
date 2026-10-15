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
  // Unique per run so find_property can't match leftovers from earlier runs.
  const postcode = `ZZ${Math.floor(Math.random() * 90 + 10)} ${Math.floor(Math.random() * 9)}ZZ`;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    if (res.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };

  beforeAll(async () => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createSessionServer(new Lendlord(LendlordClient.fromEnv()), { readOnly: false, autoConfirm: false }).connect(
      s,
    );
    client = new Client({ name: "live-write-test", version: "0" });
    await client.connect(c);
  });

  afterAll(async () => {
    if (tenantId) await call("delete_tenant", { tenantId }).catch(() => undefined);
    if (propertyId) await call("delete_property", { propertyId }).catch(() => undefined);
  });

  it("requires confirmation once, then creates a property", async () => {
    const args = {
      address: `ZZ TEST lendlord-mcp ${Date.now()} - DELETE ME`,
      postcode,
      city: "Testville",
      fields: { "Property Value": 1234 },
    };
    await expect(call("add_property", args)).rejects.toThrow(/Confirmation needed/);
    const res = await call("add_property", { ...args, confirm: true });
    propertyId = res.created[0].id;
    const p = await call("get_property", { propertyId });
    expect(p.fields).toMatchObject({
      "Property Address": args.address,
      "Property Postcode": postcode,
      "Property City": "Testville",
      "Property Value": 1234,
    });
  }, 60_000);

  it("updates only the given fields (no second confirmation) and clears with null", async () => {
    await call("update_property", {
      propertyId,
      fields: { "Property Value": 3000, Lender: "Test Bank", "EPC Due Date": "2030-01-01" },
    });
    let p = await call("get_property", { propertyId });
    expect(p.fields).toMatchObject({
      "Property Value": 3000,
      Lender: "Test Bank",
      "Property City": "Testville",
      "Property Postcode": postcode,
    });
    expect(String(p.fields["EPC Due Date"])).toMatch(/^2030-01-01/);

    await call("update_property", { propertyId, fields: { Lender: null } });
    p = await call("get_property", { propertyId });
    expect(p.fields.Lender).toBeUndefined();
    expect(p.fields["Property Value"]).toBe(3000);
  }, 60_000);

  it.skipIf(!uploads)(
    "uploads, renames and deletes a document",
    async () => {
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
    },
    90_000,
  );

  let tenantId: string | undefined;

  it("adds, updates and lists a tenant", async () => {
    const t = await call("add_tenant", {
      propertyId,
      name: "ZZ Test Tenant",
      email: "zz-test@example.com",
      rentPayment: 5,
      paymentFrequency: "Monthly",
      fields: { tenancyStartDate: "2026-01-01" },
    });
    tenantId = t.id;
    expect(t).toMatchObject({ name: "ZZ Test Tenant", propertyId, rent: 5 });

    await call("update_tenant", { tenantId, fields: { rentPayment: 7, notes: "zz note" } });
    const full = await call("get_tenant", { tenantId });
    expect(full).toMatchObject({ rentPayment: 7, notes: "zz note", email: "zz-test@example.com" });
    expect(String(full.tenancyStartDate)).toMatch(/^2026-01-01/);
    expect((await call("list_tenants", { propertyId })).map((x: { id: string }) => x.id)).toEqual([tenantId]);
  }, 60_000);

  it("runs a maintenance report lifecycle", async () => {
    const r = await call("create_maintenance_report", {
      propertyId,
      summary: "ZZ TEST report",
      description: "test",
      maintenanceType: "Electricity",
    });
    await call("add_communication_message", { communicationId: r._id, message: "zz internal note", kind: "note" });
    await call("update_communication", { communicationId: r._id, status: "closed" });
    const got = await call("get_communication", { communicationId: r._id });
    expect(got).toMatchObject({ status: "closed", summary: "ZZ TEST report", maintenanceType: "Electricity" });
    expect(got.messages.at(-1)).toMatchObject({ content: "zz internal note", type: "note" });
    await call("delete_communication", { communicationId: r._id });
    const list = await call("list_communications", { type: "maintenanceReport" });
    expect(list.communications.find((c: { _id: string }) => c._id === r._id)).toBeUndefined();
  }, 60_000);

  it("creates, edits, completes and deletes a task", async () => {
    const t = await call("create_task", { subject: "ZZ TEST task", dueDate: "2030-12-31", propertyId });
    await call("update_task", { taskId: t.id, subject: "ZZ TEST task edited" });
    let found = (await call("list_tasks", {})).find((x: { id: string }) => x.id === t.id);
    expect(found).toMatchObject({ subject: "ZZ TEST task edited", status: "active", propertyId });
    expect(String(found.dueDate)).toMatch(/^2030-12-31/);
    await call("update_task", { taskId: t.id, status: "completed" });
    found = (await call("list_tasks", { status: "completed" })).find((x: { id: string }) => x.id === t.id);
    expect(found).toBeTruthy();
    await call("update_task", { taskId: t.id, status: "deleted" });
    expect((await call("list_tasks", { status: "all" })).find((x: { id: string }) => x.id === t.id)?.status).toBe(
      "deleted",
    );
  }, 60_000);

  it("finds the property from email-like text", async () => {
    const ranked = await call("find_property", {
      text: `Re: boiler at the flat, postcode ${postcode.toLowerCase().replace(" ", "")} - thanks`,
    });
    expect(ranked[0]).toMatchObject({ propertyId });
  }, 30_000);

  it.skipIf(!uploads)(
    "files an email with an attachment and links a document to the tenant",
    async () => {
      const filed = await call("file_email", {
        entityId: propertyId,
        subject: "ZZ test email",
        from: "agent@example.com",
        date: "2026-10-15T09:00:00Z",
        text: "Hello",
        attachments: [{ fileName: "zz-invoice.txt", base64: Buffer.from("invoice").toString("base64") }],
      });
      expect(filed.email.name).toBe("2026-10-15 - ZZ test email.eml");
      expect(filed.attachments[0].name).toBe("2026-10-15 - ZZ test email - zz-invoice.txt");

      if (process.env.LENDLORD_LIVE_SEND_TESTS === "1") {
        // Sends a real email to the account's own login address.
        const me = await call("get_account");
        const sent = await call("send_document", {
          documentId: filed.attachments[0].id,
          to: me.email,
          subject: "lendlord-mcp test: send_document (safe to delete)",
          message: "Automated test from lendlord-mcp. The attached file is a dummy.",
        });
        expect(sent).toMatchObject({ sent: filed.attachments[0].id, to: me.email });
      }

      await call("link_document", { documentId: filed.attachments[0].id, entityId: tenantId, entityType: "tenant" });
      const tenantDocs = await call("list_documents", { entityId: tenantId });
      expect(tenantDocs.map((d: { name: string }) => d.name)).toContain("2026-10-15 - ZZ test email - zz-invoice.txt");

      for (const d of await call("list_documents", { entityId: tenantId }))
        await call("delete_document", { documentId: d.id, entityId: tenantId, entityType: "tenant" });
      for (const d of await call("list_documents", { entityId: propertyId }))
        await call("delete_document", { documentId: d.id, entityId: propertyId });
      expect(await call("list_documents", { entityId: propertyId })).toEqual([]);
    },
    120_000,
  );

  it("deletes the tenant", async () => {
    await call("delete_tenant", { tenantId });
    expect(await call("list_tenants", { propertyId })).toEqual([]);
    tenantId = undefined;
  }, 60_000);

  it("deletes the property", async () => {
    await call("delete_property", { propertyId });
    const props = await call("list_properties", {});
    expect(props.find((p: { id: string }) => p.id === propertyId)).toBeUndefined();
    propertyId = undefined;
  }, 60_000);
});
