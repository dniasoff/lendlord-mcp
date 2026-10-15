import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Communication, LendlordDocument, PropertyDetails, Tenant } from "./lendlord.js";
import { type ToolContext, fail, json, safe } from "./tools.js";
import { mimeFor, uploadDocument } from "./write-tools.js";

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const confirm = z.boolean().optional().describe("Set true once the user has approved writes for this session");
const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const MAINTENANCE_TYPES = [
  "Air-conditioning", "Heating and boiler", "Electricity", "Internet", "Lighting",
  "Plumbing", "Water or leaks", "Basin", "Bathroom and Toilet", "Laundry",
  "Alarms and smoke detectors", "Security camera system maintenance", "Intercom", "Doors and locks", "Pests/Vermin",
  "Floors walls and ceilings", "Structural Issues", "Windows", "Furniture", "Kitchen", "Appliances", "Mold", "Cleaning", "Carpentry",
  "Exterior Maintenance", "Roof", "Garden", "Garage", "Shared facilities", "Bike storage", "Bin storage", "Chimney", "Stairs", "Other",
] as const;

const TENANT_DATE_FIELDS = /^(dob|tenancyStartDate|tenancyEndDate|firstPaymentDate|rentReviewDate)$/;

/** Tenant dates are stored as ISO timestamps; accept YYYY-MM-DD. */
export function normaliseTenantFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = TENANT_DATE_FIELDS.test(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v;
  }
  return out;
}

export function summariseTenant(t: Tenant) {
  return {
    id: t._id,
    name: t.name,
    email: t.email,
    status: t.status,
    propertyId: t.propertyDetailsId,
    rent: t.rentPayment,
    paymentFrequency: t.paymentFrequency,
    tenancyStartDate: t.tenancyStartDate,
    tenancyEndDate: t.tenancyEndDate,
  };
}

export function registerMoreTools(server: McpServer, { lendlord, guard }: ToolContext): void {
  const gate = (action: string, ok: boolean | undefined): CallToolResult | undefined => {
    const verdict = guard.check(action, ok);
    return verdict.ok ? undefined : fail(verdict.message);
  };

  // ---------- Tenants ----------

  server.registerTool(
    "list_tenants",
    {
      title: "List tenants",
      description: "Tenants (actual and prospect), optionally for one property.",
      inputSchema: { propertyId: z.string().optional() },
      annotations: READ,
    },
    safe(async ({ propertyId }) =>
      json((await lendlord.tenants()).filter((t) => !propertyId || t.propertyDetailsId === propertyId).map(summariseTenant)),
    ),
  );

  server.registerTool(
    "get_tenant",
    {
      title: "Get tenant",
      description: "Every stored field for one tenant, plus documents linked to them.",
      inputSchema: { tenantId: z.string() },
      annotations: READ,
    },
    safe(async ({ tenantId }) => {
      const [t, docs] = await Promise.all([lendlord.tenant(tenantId), lendlord.documents()]);
      return json({ ...t, documents: docs.filter((d) => d.entities?.some((e) => e.entityId === tenantId)) });
    }),
  );

  server.registerTool(
    "add_tenant",
    {
      title: "Add tenant",
      description:
        "Add a tenant to a property. Optional `fields` may include: phone, mobile, dob, notes, unitName, tenancyStartDate, tenancyEndDate, firstPaymentDate, rentReviewDate (dates YYYY-MM-DD), rentReviewFrequency (Quarterly|Semi-Annually|Annually|Every 2 Years|Every 3 Years|Every 5 Years), generatePaymentScheduleFor (3 months|6 months|12 months|24 months), depositScheme (TDS|DPS|Mydeposits|Zerodeposits|FlatFair|SafeDeposits|Other), depositAmount, guarantor/rollingTenancy/inventoryUndertaken/legionellaInspectionRequired (Yes|No).",
      inputSchema: {
        propertyId: z.string(),
        name: z.string().min(1),
        email: z.string().email().optional(),
        rentPayment: z.number().optional().describe("Rent amount per payment"),
        paymentFrequency: z
          .enum(["Weekly", "Bi-Weekly", "Four-Weekly", "Monthly", "Quarterly", "4 Months", "6 Months", "Annually", "Free"])
          .optional(),
        status: z.enum(["Actual", "Prospect"]).default("Actual"),
        fields: z.record(z.string(), fieldValue).optional(),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ propertyId, name, email, rentPayment, paymentFrequency, status, fields, confirm: ok }) => {
      const blocked = gate(`add tenant "${name}"`, ok);
      if (blocked) return blocked;
      await lendlord.property(propertyId);
      const user = await lendlord.user();
      const tenant = normaliseTenantFields({
        subTenants: [],
        ...fields,
        name,
        ...(email ? { email } : {}),
        ...(rentPayment !== undefined ? { rentPayment } : {}),
        ...(paymentFrequency ? { paymentFrequency } : {}),
        propertyDetailsId: propertyId,
        status,
      });
      const created = await lendlord.client.post<Tenant>(`/api/addTenant/${user.clientDetailsId}`, { tenant });
      lendlord.invalidate();
      return json(summariseTenant(created));
    }),
  );

  server.registerTool(
    "update_tenant",
    {
      title: "Update tenant",
      description: "Change fields on a tenant (same field names as add_tenant). Only the fields you pass change; null clears.",
      inputSchema: { tenantId: z.string(), fields: z.record(z.string(), fieldValue), confirm },
      annotations: WRITE,
    },
    safe(async ({ tenantId, fields, confirm: ok }) => {
      const blocked = gate(`update tenant ${tenantId}`, ok);
      if (blocked) return blocked;
      const current = await lendlord.tenant(tenantId);
      const merged: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(normaliseTenantFields(fields))) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      const updated = await lendlord.client.put<Tenant>(`/api/updateTenant/${tenantId}`, { tenant: merged });
      lendlord.invalidate();
      return json(updated && typeof updated === "object" && "_id" in updated ? summariseTenant(updated) : { updated: tenantId });
    }),
  );

  server.registerTool(
    "delete_tenant",
    {
      title: "Delete tenant",
      description: "Permanently delete a tenant.",
      inputSchema: { tenantId: z.string(), confirm },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ tenantId, confirm: ok }) => {
      const t = await lendlord.tenant(tenantId);
      const blocked = gate(`delete tenant "${t.name}"`, ok);
      if (blocked) return blocked;
      await lendlord.client.delete(`/api/deleteTenant/${tenantId}`);
      lendlord.invalidate();
      return json({ deleted: tenantId });
    }),
  );

  // ---------- Communications / maintenance ----------

  server.registerTool(
    "get_communication",
    {
      title: "Get communication",
      description: "One maintenance report or conversation, including its messages.",
      inputSchema: { communicationId: z.string(), type: z.enum(["maintenanceReport", "conversation"]).default("maintenanceReport") },
      annotations: READ,
    },
    safe(async ({ communicationId, type }) => json(await lendlord.client.get(`/api/communications/${communicationId}`, { type }))),
  );

  server.registerTool(
    "create_maintenance_report",
    {
      title: "Create maintenance report",
      description: `Log a maintenance issue on a property. maintenanceType is one of: ${MAINTENANCE_TYPES.join(", ")}. Not shared with tenants unless shareWithTenants is true.`,
      inputSchema: {
        propertyId: z.string(),
        summary: z.string().min(1).describe("Short title of the issue"),
        description: z.string().optional(),
        maintenanceType: z.enum(MAINTENANCE_TYPES),
        tenantIds: z.array(z.string()).default([]).describe("Tenants to attach (each receives the report if shared)"),
        shareWithTenants: z.boolean().default(false),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ propertyId, summary, description, maintenanceType, tenantIds, shareWithTenants, confirm: ok }) => {
      const blocked = gate(`create maintenance report "${summary}"`, ok);
      if (blocked) return blocked;
      const res = await lendlord.client.post<Communication | Communication[]>("/api/communications", {
        propertyDetailsId: propertyId,
        tenant: tenantIds,
        shared: shareWithTenants,
        description: description ?? "",
        summary,
        status: "open",
        type: "maintenanceReport",
        maintenanceType,
      });
      // The API answers with a one-element array.
      return json(Array.isArray(res) ? res[0] : res);
    }),
  );

  server.registerTool(
    "update_communication",
    {
      title: "Update communication",
      description: "Change a maintenance report/conversation: status (open|closed), archived, summary, description, maintenanceType, shared.",
      inputSchema: {
        communicationId: z.string(),
        status: z.enum(["open", "closed"]).optional(),
        archived: z.boolean().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        maintenanceType: z.enum(MAINTENANCE_TYPES).optional(),
        shared: z.boolean().optional(),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ communicationId, confirm: ok, ...changes }) => {
      const body = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) return fail("Nothing to change.");
      const blocked = gate(`update communication ${communicationId}`, ok);
      if (blocked) return blocked;
      return json(await lendlord.client.put(`/api/communications/${communicationId}`, body));
    }),
  );

  server.registerTool(
    "add_communication_message",
    {
      title: "Add communication message",
      description:
        'Add a message to a maintenance report/conversation. kind "note" = internal note (landlord only); kind "message" = reply visible to the tenant.',
      inputSchema: {
        communicationId: z.string(),
        message: z.string().min(1),
        kind: z.enum(["note", "message"]).default("note"),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ communicationId, message, kind, confirm: ok }) => {
      const blocked = gate(kind === "message" ? `reply to tenant on ${communicationId}` : `add note to ${communicationId}`, ok);
      if (blocked) return blocked;
      const form = new FormData();
      form.append("type", kind);
      form.append("message", message);
      form.append("deferUpload", "true");
      const res = await lendlord.client.upload<Communication>(`/api/communications/${communicationId}/message`, form);
      return json({ id: res._id, messages: res.messages?.slice(-3) });
    }),
  );

  server.registerTool(
    "delete_communication",
    {
      title: "Delete communication",
      description: "Permanently delete a maintenance report/conversation (use update_communication archived:true to keep history).",
      inputSchema: { communicationId: z.string(), confirm },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ communicationId, confirm: ok }) => {
      const blocked = gate(`delete communication ${communicationId}`, ok);
      if (blocked) return blocked;
      await lendlord.client.delete(`/api/communications/${communicationId}`);
      return json({ deleted: communicationId });
    }),
  );

  // ---------- Tasks & alerts ("opportunities" in the API) ----------

  const TASK_STATUS = { active: "active", completed: "inActive", deleted: "inActiveDeleted" } as const;

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks and alerts",
      description:
        "Tasks (custom and Lendlord-generated, e.g. MISSING_DUE_DATES) and alerts (e.g. Payment Overdue). Defaults to active ones.",
      inputSchema: {
        status: z.enum(["active", "completed", "deleted", "all"]).default("active"),
        category: z.enum(["task", "alert", "all"]).default("all"),
      },
      annotations: READ,
    },
    safe(async ({ status, category }) => {
      const items = ((await lendlord.user()) as { opportunities?: Record<string, unknown>[] }).opportunities ?? [];
      return json(
        items
          .filter((o) => status === "all" || o.status === TASK_STATUS[status])
          .filter((o) => category === "all" || o.category === category)
          .map((o) => ({
            id: o._id,
            category: o.category,
            type: o.type,
            status: Object.entries(TASK_STATUS).find(([, v]) => v === o.status)?.[0] ?? o.status,
            subject: o.subject,
            description: o.description,
            dueDate: o.expiry_date,
            propertyId: o.propertyId,
            tenantId: o.tenantsId,
            paymentAmount: o.paymentAmount,
          })),
      );
    }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Add a custom task with a due date, optionally tied to a property.",
      inputSchema: {
        subject: z.string().min(1),
        description: z.string().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
        propertyId: z.string().optional(),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ subject, description, dueDate, propertyId, confirm: ok }) => {
      const blocked = gate(`create task "${subject}"`, ok);
      if (blocked) return blocked;
      const user = await lendlord.user();
      const created = await lendlord.client.post<Record<string, unknown>>("/api/opportunities", {
        expiry_date: `${dueDate}T00:00:00.000Z`,
        subject,
        description: description ?? "",
        ...(propertyId ? { propertyId } : {}),
        level: "client",
        category: "task",
        type: "CUSTOM_TASK",
        clientId: user.clientDetailsId,
      });
      lendlord.invalidate();
      return json({ id: created._id, subject: created.subject, dueDate: created.expiry_date, status: "active" });
    }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description: "Edit a task, or change its status: completed, active (reopen) or deleted.",
      inputSchema: {
        taskId: z.string(),
        status: z.enum(["active", "completed", "deleted"]).optional(),
        subject: z.string().optional(),
        description: z.string().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ taskId, status, subject, description, dueDate, confirm: ok }) => {
      const body: Record<string, unknown> = {};
      if (status) body.status = TASK_STATUS[status];
      if (subject !== undefined) body.subject = subject;
      if (description !== undefined) body.description = description;
      if (dueDate) body.expiry_date = `${dueDate}T00:00:00.000Z`;
      if (!Object.keys(body).length) return fail("Nothing to change.");
      // Lendlord answers 200 even for unknown ids, so check first.
      const known = ((await lendlord.user(true)) as { opportunities?: { _id: string }[] }).opportunities ?? [];
      if (!known.some((o) => o._id === taskId)) return fail(`No task with id ${taskId}. Use list_tasks to find ids.`);
      const blocked = gate(`update task ${taskId}`, ok);
      if (blocked) return blocked;
      await lendlord.client.put(`/api/opportunities/${taskId}`, body);
      lendlord.invalidate();
      return json({ updated: taskId, ...body });
    }),
  );

  // ---------- Documents: linking ----------

  server.registerTool(
    "link_document",
    {
      title: "Link document",
      description:
        "Attach an existing document to another property or tenant. Lendlord stores this as a separate copy (same file, own id) under the original name.",
      inputSchema: {
        documentId: z.string(),
        entityId: z.string(),
        entityType: z.enum(["property", "tenant"]).default("property"),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ documentId, entityId, entityType, confirm: ok }) => {
      const doc = (await lendlord.documents()).find((d) => d._id === documentId);
      if (!doc) return fail(`No document with id ${documentId}.`);
      const blocked = gate(`link document "${doc.name}" to ${entityType} ${entityId}`, ok);
      if (blocked) return blocked;
      const copy = await lendlord.client.post<LendlordDocument>("/api/documents/copy", {
        entities: [{ entityType, entityId }],
        key: doc.key,
        path: doc.path,
      });
      // The copy is named "<timestamp>_<key>.<ext>"; restore the original display name.
      const renamed = await lendlord.client.patch<LendlordDocument>(`/api/documents/${copy._id}`, { name: doc.name });
      return json({ id: copy._id, name: renamed?.name ?? doc.name, entities: copy.entities });
    }),
  );

  // ---------- Email filing helpers (agents read mail; these file it) ----------

  server.registerTool(
    "find_property",
    {
      title: "Find property",
      description:
        "Rank properties against free text such as an email's subject/body, an address, postcode, tenant name/email, or a policy/certificate number. Use before file_email to pick the property.",
      inputSchema: { text: z.string().min(2), limit: z.number().int().min(1).max(20).default(5) },
      annotations: READ,
    },
    safe(async ({ text, limit }) => {
      const [properties, tenants] = await Promise.all([lendlord.properties(), lendlord.tenants()]);
      return json(rankProperties(text, properties, tenants).slice(0, limit));
    }),
  );

  server.registerTool(
    "file_email",
    {
      title: "File email to property",
      description:
        "Store an email (and its attachments) as documents on a property or tenant. Pass either emlBase64 (raw RFC 822 message) or subject/from/to/date/text/html. Attachments are uploaded as separate documents named \"<date> - <subject> - <file>\".",
      inputSchema: {
        entityId: z.string().describe("Property id (from find_property) or tenant id"),
        entityType: z.enum(["property", "tenant"]).default("property"),
        emlBase64: z.string().optional(),
        subject: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        date: z.string().optional().describe("ISO date/time the email was sent"),
        text: z.string().optional(),
        html: z.string().optional(),
        attachments: z
          .array(z.object({ fileName: z.string(), base64: z.string(), mimeType: z.string().optional() }))
          .default([]),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      if (!args.emlBase64 && !args.subject && !args.text && !args.html) return fail("Provide emlBase64 or the email's subject/text/html.");
      const blocked = gate(`file email "${args.subject ?? "(raw .eml)"}" to ${args.entityType} ${args.entityId}`, args.confirm);
      if (blocked) return blocked;
      const eml = args.emlBase64 ? Buffer.from(args.emlBase64, "base64") : Buffer.from(buildEml(args), "utf8");
      const subject = args.subject ?? headerFrom(eml, "subject") ?? "Email";
      const sent = new Date(args.date ?? headerFrom(eml, "date") ?? Date.now());
      const day = Number.isNaN(sent.getTime()) ? new Date().toISOString().slice(0, 10) : sent.toISOString().slice(0, 10);
      const base = `${day} - ${subject}`.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 120).trim();
      const keyBase = `email${day.replace(/-/g, "")}${randomBytes(3).toString("hex")}`;

      const target = { entityType: args.entityType, entityId: args.entityId };
      const email = await uploadDocument(lendlord.client, {
        ...target,
        key: keyBase,
        name: `${base}.eml`,
        file: { name: `${base}.eml`, type: "message/rfc822", data: eml },
      });
      const attachments = [];
      for (const [i, a] of args.attachments.entries()) {
        attachments.push(
          await uploadDocument(lendlord.client, {
            ...target,
            key: `${keyBase}att${i + 1}`,
            name: `${base} - ${a.fileName}`,
            file: { name: a.fileName, type: mimeFor(a.fileName, a.mimeType), data: Buffer.from(a.base64, "base64") },
          }),
        );
      }
      return json({
        email: { id: email._id, name: email.name },
        attachments: attachments.map((d) => ({ id: d._id, name: d.name })),
      });
    }),
  );
}

function headerFrom(eml: Buffer, name: string): string | undefined {
  const head = eml.subarray(0, 64 * 1024).toString("utf8").split(/\r?\n\r?\n/)[0] ?? "";
  const m = new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, "im").exec(head);
  return m?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim();
}

export function buildEml(e: { subject?: string; from?: string; to?: string; date?: string; text?: string; html?: string }): string {
  const headers = [
    e.from && `From: ${e.from}`,
    e.to && `To: ${e.to}`,
    `Subject: ${e.subject ?? ""}`,
    `Date: ${new Date(e.date ?? Date.now()).toUTCString()}`,
    "MIME-Version: 1.0",
  ].filter(Boolean);
  if (e.text && e.html) {
    const b = `b${randomBytes(8).toString("hex")}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${b}"`,
      "",
      `--${b}`, "Content-Type: text/plain; charset=utf-8", "", e.text,
      `--${b}`, "Content-Type: text/html; charset=utf-8", "", e.html,
      `--${b}--`, "",
    ].join("\r\n");
  }
  const html = !e.text && e.html;
  return [...headers, `Content-Type: text/${html ? "html" : "plain"}; charset=utf-8`, "", html ? e.html! : e.text ?? "", ""].join("\r\n");
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim();
const compact = (s: string) => s.toLowerCase().replace(/\s+/g, "");
const STOP = new Set(["road", "street", "st", "rd", "avenue", "ave", "lane", "the", "upon", "flat", "house", "newcastle", "tyne", "london"]);

/** Score properties against free text. Postcodes and identifiers weigh most; street words least. */
export function rankProperties(text: string, properties: PropertyDetails[], tenants: { name?: string; email?: string; propertyDetailsId?: string }[]) {
  const hay = norm(text);
  const hayCompact = compact(text);
  const words = new Set(hay.split(" "));
  const results = [];
  for (const p of properties) {
    const f = p.property;
    const reasons: string[] = [];
    let score = 0;
    const postcode = typeof f["Property Postcode"] === "string" ? (f["Property Postcode"] as string) : "";
    if (postcode && hayCompact.includes(compact(postcode))) {
      score += 50;
      reasons.push(`postcode ${postcode}`);
    }
    const address = typeof f["Property Address"] === "string" ? (f["Property Address"] as string) : "";
    const addrWords = norm(address).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
    const number = /^\d+[a-z]?/.exec(norm(address))?.[0];
    const street = addrWords.filter((w) => !/^\d/.test(w));
    const hits = street.filter((w) => words.has(w));
    if (hits.length) {
      score += 10 * hits.length;
      reasons.push(`address words ${hits.join(", ")}`);
      if (number && new RegExp(`\\b${number}\\b`).test(hay)) {
        score += 15;
        reasons.push(`house number ${number}`);
      }
    }
    for (const key of ["Policy Number", "Certificate Number", "Gas Certificate Number", "Mortgage Account Number", "Council Tax Reference Number", "License Number"]) {
      const v = f[key];
      if (typeof v === "string" && v.length >= 5 && hayCompact.includes(compact(v))) {
        score += 40;
        reasons.push(key);
      }
    }
    for (const t of tenants.filter((t) => t.propertyDetailsId === p._id)) {
      if (t.email && hay.includes(t.email.toLowerCase())) {
        score += 40;
        reasons.push(`tenant email ${t.email}`);
      } else if (t.name && t.name.length > 3 && hay.includes(norm(t.name))) {
        score += 25;
        reasons.push(`tenant ${t.name}`);
      }
    }
    if (score > 0) results.push({ propertyId: p._id, address, postcode, score, reasons });
  }
  return results.sort((a, b) => b.score - a.score);
}
