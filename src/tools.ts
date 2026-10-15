import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LendlordError } from "./client.js";
import type { WriteGuard } from "./guard.js";
import { type Communication, type Lendlord, type PropertyDetails, summariseProperty } from "./lendlord.js";

export interface ToolContext {
  lendlord: Lendlord;
  guard: WriteGuard;
}

export const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

export const fail = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Wrap a handler so API failures come back as tool errors instead of protocol errors. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof LendlordError) return fail(`Lendlord API error ${err.status} on ${err.path}: ${err.message}`);
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toDmy = (iso: string) => iso.split("-").reverse().join("-");

export function registerTools(server: McpServer, { lendlord, guard }: ToolContext): void {
  server.registerTool(
    "get_account",
    {
      title: "Get account",
      description:
        "The Lendlord account: user, team role, currency/country settings, applicants (property owners), and plan usage limits. Excludes property data (use list_properties).",
      annotations: READ,
    },
    safe(async () => {
      const u = await lendlord.user();
      return json({
        id: u._id,
        name: u.fullname,
        email: u.email,
        clientDetailsId: u.clientDetailsId,
        teamRole: u.teamRole,
        currency: u.client?.currency,
        country: u.client?.country,
        dateFormat: u.client?.dateFormat,
        applicants: u.applicants,
        accountLimitations: u.client?.accountLimitations,
        monthlyLimitations: u.client?.monthlyLimitations,
        propertyCount: u.portfolioDetails?.length ?? 0,
      });
    }),
  );

  server.registerTool(
    "list_properties",
    {
      title: "List properties",
      description:
        "All properties in the portfolio with key figures (address, postcode, value, rent, mortgage). Optionally filter by free text matched against address/postcode.",
      inputSchema: {
        search: z.string().optional().describe("Case-insensitive text to match in address or postcode"),
        status: z.string().optional().describe('Filter by status, e.g. "active"'),
      },
      annotations: READ,
    },
    safe(async ({ search, status }) => {
      const needle = search?.toLowerCase();
      const rows = (await lendlord.properties())
        .filter((p) => !status || p.status === status)
        .map(summariseProperty)
        .filter((p) => !needle || `${p.address ?? ""} ${p.postcode ?? ""}`.toLowerCase().includes(needle));
      return json(rows);
    }),
  );

  server.registerTool(
    "get_property",
    {
      title: "Get property",
      description: "Every stored field for one property, plus its tenants and the documents linked to it.",
      inputSchema: { propertyId: z.string().describe("Property id from list_properties") },
      annotations: READ,
    },
    safe(async ({ propertyId }) => {
      const [p, docs, tenants] = await Promise.all([
        lendlord.property(propertyId),
        lendlord.documents(),
        lendlord.tenants(),
      ]);
      return json({
        id: p._id,
        status: p.status,
        applicants: p.applicants,
        fields: p.property,
        tenants: tenants
          .filter((t) => t.propertyDetailsId === propertyId)
          .map((t) => ({ id: t._id, name: t.name, status: t.status, rent: t.rentPayment })),
        documents: docs.filter((d) => d.entities?.some((e) => e.entityId === propertyId)),
      });
    }),
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description:
        "Documents stored in Lendlord, with the entities (property, tenant, …) each is linked to. Optionally filter by linked entity id or name text.",
      inputSchema: {
        entityId: z.string().optional().describe("Only documents linked to this property/tenant id"),
        search: z.string().optional().describe("Case-insensitive text to match in the document name"),
      },
      annotations: READ,
    },
    safe(async ({ entityId, search }) => {
      const needle = search?.toLowerCase();
      const docs = (await lendlord.documents())
        .filter((d) => !entityId || d.entities?.some((e) => e.entityId === entityId))
        .filter((d) => !needle || d.name.toLowerCase().includes(needle))
        .map(({ _id, name, size, date, entities, key, path }) => ({ id: _id, name, size, date, entities, key, path }));
      return json(docs);
    }),
  );

  server.registerTool(
    "get_rent_collection",
    {
      title: "Get rent collection",
      description: "Expected rent payments (per tenant, with due dates and matched transactions) between two dates.",
      inputSchema: { from: isoDate, to: isoDate },
      annotations: READ,
    },
    safe(async ({ from, to }) => json(await lendlord.client.get(`/api/getRentCollection/${toDmy(from)}/${toDmy(to)}`))),
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description: "Bank/manual transactions between two dates.",
      inputSchema: {
        startDate: isoDate,
        endDate: isoDate,
        status: z.string().optional().describe('e.g. "mapped" (categorised); omit for all'),
      },
      annotations: READ,
    },
    safe(async ({ startDate, endDate, status }) =>
      json(await lendlord.client.get("/api/transactions", { startDate, endDate, status })),
    ),
  );

  server.registerTool(
    "get_profit_and_loss",
    {
      title: "Get profit and loss",
      description: "P&L per property by month, with the category list used for transactions.",
      annotations: READ,
    },
    safe(async () => {
      const [pnl, categories] = await Promise.all([
        lendlord.client.get<{ data?: unknown }>("/api/pnlData"),
        lendlord.client.get<{ _id: string; name: string; type: string }[]>("/api/pnlCategory"),
      ]);
      return json({
        byProperty: pnl?.data ?? {},
        categories: categories.map(({ _id, name, type }) => ({ id: _id, name, type })),
      });
    }),
  );

  server.registerTool(
    "list_communications",
    {
      title: "List communications",
      description:
        "Maintenance reports and other tenant/landlord communications, newest first. Fetches Lendlord's 100-item pages as needed up to `limit` (max 1000); continue with skip = nextSkip while hasMore is true.",
      inputSchema: {
        type: z.string().optional().describe('e.g. "maintenanceReport"'),
        propertyId: z.string().optional().describe("Only communications for this property"),
        limit: z.number().int().min(1).max(1000).default(100),
        skip: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    safe(async ({ type, propertyId, limit, skip }) =>
      json(await listCommunications(lendlord, { type, propertyId, limit, skip })),
    ),
  );

  server.registerTool(
    "compliance_overview",
    {
      title: "Compliance overview",
      description:
        "Upcoming and overdue expiry dates across the portfolio (EPC, insurance, gas safety, EICR, mortgage rate expiry, …), sorted soonest first.",
      inputSchema: { withinDays: z.number().int().default(90).describe("Flag items expiring within this many days") },
      annotations: READ,
    },
    safe(async ({ withinDays }) => json(complianceItems(await lendlord.properties(), withinDays))),
  );

  server.registerTool(
    "lendlord_request",
    {
      title: "Raw Lendlord API request",
      description:
        "Call any Lendlord /api endpoint directly (encryption handled). Use for features without a dedicated tool; see docs/api.md for endpoints. GET is read-only; other methods change data and need write confirmation.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().regex(/^\/api\//, "Path must start with /api/"),
        query: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional().describe("JSON body (encrypted automatically)"),
        confirm: z.boolean().optional().describe("Set true once the user has approved writes for this session"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ method, path, query, body, confirm }) => {
      if (/^\/api\/admin\b/i.test(path)) return fail("Admin endpoints are blocked.");
      if (method !== "GET") {
        const verdict = guard.check(`${method} ${path}`, confirm);
        if (!verdict.ok) return fail(verdict.message);
        lendlord.invalidate();
      }
      return json(await lendlord.client.request(method, path, { query, json: body }));
    }),
  );
}

const DATE_FIELD = /(due|end|expiry|expiration|renewal|next check) date$|contract end$/i;
const DAY_MS = 86_400_000;

export function complianceItems(properties: PropertyDetails[], withinDays: number, now = Date.now()) {
  const items = [];
  for (const p of properties) {
    for (const [field, value] of Object.entries(p.property)) {
      if (!DATE_FIELD.test(field) || typeof value !== "string") continue;
      const at = Date.parse(value);
      if (Number.isNaN(at)) continue;
      const daysLeft = Math.ceil((at - now) / DAY_MS);
      items.push({
        propertyId: p._id,
        address: p.property["Property Address"],
        item: field,
        date: value.slice(0, 10),
        daysLeft,
        status: daysLeft < 0 ? "overdue" : daysLeft <= withinDays ? "due_soon" : "ok",
      });
    }
  }
  return items.sort((a, b) => a.daysLeft - b.daysLeft);
}

const COMMUNICATIONS_PAGE = 100;

/** Page through /api/communications (Lendlord serves at most 100 per request; issue #5). */
export async function listCommunications(
  lendlord: Lendlord,
  opts: { type?: string; propertyId?: string; limit: number; skip: number },
) {
  const found: Communication[] = [];
  let skip = opts.skip;
  let hasMore = true;
  while (hasMore && found.length < opts.limit) {
    const page = await lendlord.client.get<{ communications?: Communication[]; hasMore?: boolean }>(
      "/api/communications",
      { type: opts.type, limit: COMMUNICATIONS_PAGE, skip },
    );
    const items = page.communications ?? [];
    for (const [i, c] of items.entries()) {
      if (opts.propertyId && c.propertyDetailsId !== opts.propertyId) continue;
      found.push(c);
      if (found.length === opts.limit) {
        // Stop mid-page: resume right after this item.
        return {
          communications: found,
          hasMore: i < items.length - 1 || Boolean(page.hasMore),
          nextSkip: skip + i + 1,
        };
      }
    }
    skip += items.length;
    hasMore = Boolean(page.hasMore) && items.length > 0;
  }
  return { communications: found, hasMore, nextSkip: skip };
}
