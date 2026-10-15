import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LendlordError, RETRY_DELAYS_MS, sleep } from "./client.js";
import { coerceFields, PERCENT_NOTE, propertyFieldKind } from "./fields.js";
import type { LendlordDocument, PropertyDetails } from "./lendlord.js";
import { EDITABLE_PROPERTY_FIELDS, isComputedField, PROPERTY_DOCUMENT_SLOTS } from "./schema.js";
import { fail, json, safe, type ToolContext } from "./tools.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const confirm = z.boolean().optional().describe("Set true once the user has approved writes for this session");
const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".eml": "message/rfc822",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/** Validate and coerce property fields: dates to ISO, money/area/percent strings to numbers (throws FieldError). */
export function coercePropertyFields(fields: Record<string, unknown>) {
  return coerceFields(fields, propertyFieldKind);
}

export function normaliseFields(fields: Record<string, unknown>): Record<string, unknown> {
  return coercePropertyFields(fields).values;
}

/** Full replacement body for /api/updateProperty: current editable fields + changes; null deletes a field. */
export function mergeProperty(current: PropertyDetails, changes: Record<string, unknown>) {
  const property: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current.property)) if (!isComputedField(k)) property[k] = v;
  for (const [k, v] of Object.entries(normaliseFields(changes))) {
    if (v === null) delete property[k];
    else property[k] = v;
  }
  return {
    _id: current._id,
    status: current.status,
    clientDetailsId: current.clientDetailsId,
    property,
    applicants: current.applicants ?? [],
    assumptions: (current as { assumptions?: unknown }).assumptions ?? {},
  };
}

export function registerWriteTools(server: McpServer, { lendlord, guard }: ToolContext): void {
  const gate = (action: string, ok: boolean | undefined): CallToolResult | undefined => {
    const verdict = guard.check(action, ok);
    return verdict.ok ? undefined : fail(verdict.message);
  };

  server.registerTool(
    "list_property_fields",
    {
      title: "List property fields",
      description:
        "Field names accepted by add_property / update_property, and the document slot keys for upload_document.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => json({ propertyFields: EDITABLE_PROPERTY_FIELDS, documentSlots: PROPERTY_DOCUMENT_SLOTS })),
  );

  server.registerTool(
    "add_property",
    {
      title: "Add property",
      description:
        'Create a property. `fields` uses Lendlord field names (see list_property_fields), e.g. {"Property Value": 150000, "Date of Purchase": "2024-05-01"}. Owned by the first applicant unless ownerApplicantId is given.',
      inputSchema: {
        address: z.string().min(1),
        postcode: z.string().optional(),
        city: z.string().optional(),
        status: z.enum(["active", "potential"]).default("active").describe('"active" = owned, "potential" = prospect'),
        ownerApplicantId: z.string().optional(),
        fields: z.record(z.string(), fieldValue).optional(),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ address, postcode, city, status, ownerApplicantId, fields, confirm: ok }) => {
      const { values, conversions } = coercePropertyFields(fields ?? {});
      const blocked = gate(`add property "${address}"`, ok);
      if (blocked) return blocked;
      const user = await lendlord.user();
      const owner = ownerApplicantId ?? (user.applicants?.[0]?._id as string | undefined);
      if (!owner) return fail("No applicant (owner) found on the account; pass ownerApplicantId.");
      const property = normaliseFields({
        "HMO Property": "No",
        "Capital Gains Tax": 0,
        Ownership: "Private",
        ...values,
        "Property Address": address,
        ...(city ? { "Property City": city } : {}),
        ...(postcode ? { "Property Postcode": postcode } : {}),
        "Applicant 1": owner,
        "Ownership Percentage 1": 1,
      });
      const created = await lendlord.client.post<PropertyDetails[]>("/api/addProperties", {
        properties: [{ status, clientDetailsId: user.clientDetailsId, property, applicants: [owner], assumptions: {} }],
        country: user.client?.country ?? "uk",
      });
      lendlord.invalidate();
      return json({
        created: created.map((p) => ({ id: p._id, address: p.property["Property Address"] })),
        ...(conversions.length ? { conversions } : {}),
      });
    }),
  );

  server.registerTool(
    "update_property",
    {
      title: "Update property",
      description: `Change fields on a property. Only the fields you pass change; set a field to null to clear it. Field names from list_property_fields. Dates as YYYY-MM-DD (DD/MM/YYYY also accepted). Money accepts 150000, "£150,000" or "150k". "Internal Area" is square metres ("73", "73 sq m"; "790 sq ft" is converted). ${PERCENT_NOTE} Invalid values are rejected with a field-specific error.`,
      inputSchema: {
        propertyId: z.string(),
        fields: z.record(z.string(), fieldValue),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ propertyId, fields, confirm: ok }) => {
      const computed = Object.keys(fields).filter(isComputedField);
      if (computed.length)
        return fail(`These fields are calculated by Lendlord and can't be set: ${computed.join(", ")}`);
      const { values, conversions } = coercePropertyFields(fields);
      const blocked = gate(`update property ${propertyId}`, ok);
      if (blocked) return blocked;
      const current = await lendlord.property(propertyId);
      const user = await lendlord.user();
      const res = await lendlord.client.post<{ propertiesUpdated: PropertyDetails[] }>("/api/updateProperty", {
        properties: [mergeProperty(current, values)],
        country: user.client?.country ?? "uk",
      });
      lendlord.invalidate();
      const updated = res.propertiesUpdated?.[0];
      if (!updated) return fail("Lendlord did not confirm the update.");
      return json({
        id: updated._id,
        changed: Object.fromEntries(Object.keys(fields).map((k) => [k, updated.property[k] ?? null])),
        ...(conversions.length ? { conversions } : {}),
      });
    }),
  );

  server.registerTool(
    "delete_property",
    {
      title: "Delete property",
      description: "Permanently delete a property from the portfolio.",
      inputSchema: { propertyId: z.string(), confirm },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ propertyId, confirm: ok }) => {
      const p = await lendlord.property(propertyId);
      const blocked = gate(`delete property "${p.property["Property Address"]}"`, ok);
      if (blocked) return blocked;
      await lendlord.client.delete(`/api/deleteProperty/${propertyId}`);
      lendlord.invalidate();
      return json({ deleted: propertyId });
    }),
  );

  server.registerTool(
    "upload_document",
    {
      title: "Upload document",
      description:
        "Upload a file to Lendlord and link it to a property (or tenant). To attach a file to a bank transaction (payment) use attach_transaction_receipt instead. Provide exactly one of filePath (on the server's machine), url, or base64 + fileName. `key` is a document slot from list_property_fields (e.g. gasCertificate, epc, eicr, insurancePolicy); any other key creates a custom document. Uses the account's upload quota.",
      inputSchema: {
        entityId: z.string().describe("Property id (or tenant id with entityType tenant)"),
        entityType: z.enum(["property", "tenant"]).default("property"),
        key: z.string().min(1).describe("Document slot key or a custom document key"),
        name: z.string().optional().describe("Display/file name; defaults to the source file name"),
        filePath: z.string().optional(),
        url: z.string().url().optional(),
        base64: z.string().optional(),
        fileName: z.string().optional(),
        mimeType: z.string().optional(),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const sources = [args.filePath, args.url, args.base64].filter(Boolean).length;
      if (sources !== 1) return fail("Provide exactly one of filePath, url, or base64.");
      const blocked = gate(`upload document to ${args.entityType} ${args.entityId}`, args.confirm);
      if (blocked) return blocked;
      const file = await loadFile(args);
      const doc = await uploadDocument(lendlord.client, {
        entityType: args.entityType,
        entityId: args.entityId,
        key: args.key,
        name: args.name ?? file.name,
        file,
      });
      return json(doc);
    }),
  );

  server.registerTool(
    "rename_document",
    {
      title: "Rename document",
      description: "Change a document's display name.",
      inputSchema: { documentId: z.string(), name: z.string().min(1), confirm },
      annotations: WRITE,
    },
    safe(async ({ documentId, name, confirm: ok }) => {
      const blocked = gate(`rename document ${documentId}`, ok);
      if (blocked) return blocked;
      return json(await lendlord.client.patch<LendlordDocument>(`/api/documents/${documentId}`, { name }));
    }),
  );

  server.registerTool(
    "delete_document",
    {
      title: "Delete document",
      description: "Remove a document from the property/tenant it is linked to (deletes it if that was its only link).",
      inputSchema: {
        documentId: z.string(),
        entityId: z.string().describe("The property/tenant id the document is linked to"),
        entityType: z.enum(["property", "tenant"]).default("property"),
        confirm,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ documentId, entityId, entityType, confirm: ok }) => {
      const blocked = gate(`delete document ${documentId}`, ok);
      if (blocked) return blocked;
      await lendlord.client.delete(`/api/documents/${documentId}/${entityType}/${entityId}`);
      return json({ deleted: documentId });
    }),
  );
}

export interface UploadFile {
  name: string;
  type: string;
  data: Uint8Array;
}

export async function uploadDocument(
  client: ToolContext["lendlord"]["client"],
  opts: { entityType: string; entityId: string; key: string; name: string; file: UploadFile },
): Promise<LendlordDocument> {
  // Mirrors the web app: entities is a single JSON-string field (captured 2026-10-15).
  const form = new FormData();
  form.append("key", opts.key);
  form.append("file", new Blob([new Uint8Array(opts.file.data)], { type: opts.file.type }), opts.file.name);
  form.append("name", opts.name);
  form.append("entities", JSON.stringify([{ entityType: opts.entityType, entityId: opts.entityId }]));

  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.upload<LendlordDocument>("/api/documents", form);
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!(err instanceof LendlordError) || !err.transient || delay === undefined) throw err;
      // Lendlord sometimes stores the file and still answers "500 socket hang up" (issue #7).
      // Only re-upload if the document really isn't there, so retries never create duplicates.
      await sleep(delay);
      const landed = await findUploaded(client, opts, startedAt).catch(() => undefined);
      if (landed) return landed;
    }
  }
}

async function findUploaded(
  client: ToolContext["lendlord"]["client"],
  opts: { entityType: string; entityId: string; key: string; name: string },
  since: number,
): Promise<LendlordDocument | undefined> {
  const docs = await client.get<LendlordDocument[]>(`/api/documents/${opts.entityType}/${opts.entityId}`);
  return docs.find(
    (d) => d.key === opts.key && d.name === opts.name && Date.parse(d.createdAt ?? d.date ?? "") >= since - 5 * 60_000,
  );
}

export async function loadFile(args: {
  filePath?: string;
  url?: string;
  base64?: string;
  fileName?: string;
  mimeType?: string;
}): Promise<UploadFile> {
  let data: Uint8Array;
  let name = args.fileName;
  let type = args.mimeType;
  if (args.filePath) {
    data = await readFile(args.filePath);
    name ??= basename(args.filePath);
  } else if (args.url) {
    const res = await fetch(args.url);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    data = new Uint8Array(await res.arrayBuffer());
    name ??= basename(new URL(args.url).pathname) || "download";
    type ??= res.headers.get("content-type")?.split(";")[0];
  } else {
    if (!args.fileName) throw new Error("fileName is required with base64");
    data = Buffer.from(args.base64 ?? "", "base64");
  }
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new Error("File is larger than 25 MB");
  name ??= "upload";
  return { name, data, type: mimeFor(name, type) };
}

export function mimeFor(fileName: string, given?: string): string {
  if (given && given !== "application/octet-stream") return given;
  return MIME[extname(fileName).toLowerCase()] ?? given ?? "application/octet-stream";
}
