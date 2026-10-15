import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LendlordError } from "./client.js";
import type { Lendlord } from "./lendlord.js";
import { fail, json, safe, type ToolContext, type TransactionRecord } from "./tools.js";
import { loadFile, type UploadFile } from "./write-tools.js";

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const confirm = z.boolean().optional().describe("Set true once the user has approved writes for this session");

/**
 * Bank transactions keep their attachment as a "receipt" stored on the transaction itself
 * (`file: { url, name }`), saved through the transaction's multipart PUT. It is NOT part of the
 * documents store, so upload_document cannot attach to a transaction. Captured 2026-10-15.
 */
export function transactionForm(
  tx: TransactionRecord,
  change: { file: UploadFile } | { removeReceipt: true } | { updates: Partial<TransactionRecord> } = { updates: {} },
): FormData {
  const form = new FormData();
  if ("file" in change) {
    form.append("file", new Blob([new Uint8Array(change.file.data)], { type: change.file.type }), change.file.name);
    form.append("fileName", change.file.name);
  } else if ("removeReceipt" in change) {
    form.append("removeReceipt", "true");
  }
  // Re-send the transaction's own plain values, as the web app does. Nested objects (the
  // populated category, rent collection, ...) are server-side joins and must not be sent back.
  const values = "updates" in change ? { ...tx, ...change.updates } : tx;
  for (const [key, value] of Object.entries(values)) {
    if (key === "file" || (typeof value === "object" && value !== null)) continue;
    if (typeof value === "boolean" || value || value === null) form.append(key, String(value));
  }
  return form;
}

export async function fetchTransaction(lendlord: Lendlord, id: string): Promise<TransactionRecord> {
  const res = await lendlord.client
    .get<TransactionRecord[] | TransactionRecord>(`/api/getAggregatedTransaction/${id}`)
    .catch((err) => {
      if (err instanceof LendlordError && [400, 404, 500].includes(err.status)) return undefined;
      throw err;
    });
  const tx = Array.isArray(res) ? res[0] : res;
  if (!tx?._id) throw new Error(`No transaction with id ${id}. Use list_transactions to find ids.`);
  return tx;
}

async function receiptLink(lendlord: Lendlord, file: { url: string; name: string }) {
  const res = await lendlord.client.get<{ url?: string }>("/api/getSignedUrl", {
    download: "true",
    url: file.url,
    fileName: file.name,
  });
  return res?.url;
}

const summarise = (tx: TransactionRecord) => ({
  id: tx._id,
  description: tx.description,
  amount: tx.amount,
  type: tx.type,
  date: tx.date,
});

export function registerTransactionTools(server: McpServer, { lendlord, guard }: ToolContext): void {
  const gate = (action: string, ok: boolean | undefined): CallToolResult | undefined => {
    const verdict = guard.check(action, ok);
    return verdict.ok ? undefined : fail(verdict.message);
  };

  server.registerTool(
    "update_transaction",
    {
      title: "Update transaction",
      description:
        "Change the property or category linked to a bank/manual transaction. Only the fields you pass change. The existing receipt is kept; this does not upload or remove a receipt.",
      inputSchema: {
        transactionId: z.string().describe("Transaction id from list_transactions"),
        propertyDetailsId: z.string().optional().describe("Property id to link, or an empty string to unlink"),
        categoryId: z.string().optional().describe("Category id to assign"),
        confirm,
      },
      annotations: WRITE,
    },
    safe(async ({ transactionId, propertyDetailsId, categoryId, confirm: ok }) => {
      if (propertyDetailsId === undefined && categoryId === undefined)
        return fail("Pass propertyDetailsId, categoryId, or both.");
      const tx = await fetchTransaction(lendlord, transactionId);
      const changes = {
        ...(propertyDetailsId !== undefined ? { propertyDetailsId } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
      };
      const blocked = gate(`update transaction "${tx.description}"`, ok);
      if (blocked) return blocked;
      const res = await lendlord.client.upload<{ transaction?: TransactionRecord }>(
        `/api/transactions/${transactionId}`,
        transactionForm(tx, { updates: changes }),
        "PUT",
      );
      if (!res.transaction) return fail("Lendlord did not confirm the transaction update. Check get_transaction.");
      lendlord.invalidate();
      return json({
        ...summarise(res.transaction),
        propertyDetailsId: res.transaction.propertyDetailsId,
        categoryId: res.transaction.categoryId,
        receipt: res.transaction.file ? { name: res.transaction.file.name } : null,
      });
    }),
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get transaction",
      description:
        "One bank/manual transaction with all its fields. If it has a receipt, `receipt` holds its name and a temporary download link.",
      inputSchema: { transactionId: z.string().describe("Transaction id from list_transactions") },
      annotations: READ,
    },
    safe(async ({ transactionId }) => {
      const tx = await fetchTransaction(lendlord, transactionId);
      const { file, ...rest } = tx;
      return json({
        ...rest,
        receipt: file ? { name: file.name, downloadUrl: await receiptLink(lendlord, file) } : null,
      });
    }),
  );

  server.registerTool(
    "attach_transaction_receipt",
    {
      title: "Attach receipt to a bank transaction",
      description:
        "Attach an invoice, receipt or other file to a bank/manual transaction (payment). A transaction holds ONE attachment: attaching again replaces it. Use this instead of upload_document, which only links files to properties and tenants. Provide exactly one of filePath (on the server's machine), url, or base64 + fileName. Accepts PDF, images, Word/Excel/PowerPoint, CSV and text. Use list_transactions (search / amount / hasReceipt) to find the transaction.",
      inputSchema: {
        transactionId: z.string(),
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
      if ([args.filePath, args.url, args.base64].filter(Boolean).length !== 1) {
        return fail("Provide exactly one of filePath, url, or base64.");
      }
      const file = await loadFile(args);
      const tx = await fetchTransaction(lendlord, args.transactionId);
      const blocked = gate(`attach "${file.name}" to transaction "${tx.description}"`, args.confirm);
      if (blocked) return blocked;
      const res = await lendlord.client.upload<{ transaction?: TransactionRecord }>(
        `/api/transactions/${args.transactionId}`,
        transactionForm(tx, { file }),
        "PUT",
      );
      const saved = res.transaction;
      if (!saved?.file) return fail("Lendlord did not confirm the attachment. Check get_transaction before retrying.");
      lendlord.invalidate();
      return json({
        ...summarise(saved),
        receipt: { name: saved.file.name },
        ...(tx.file ? { replaced: tx.file.name } : {}),
      });
    }),
  );

  server.registerTool(
    "remove_transaction_receipt",
    {
      title: "Remove a transaction's receipt",
      description: "Remove the file attached to a bank/manual transaction. The transaction itself is not changed.",
      inputSchema: { transactionId: z.string(), confirm },
      annotations: WRITE,
    },
    safe(async ({ transactionId, confirm: ok }) => {
      const tx = await fetchTransaction(lendlord, transactionId);
      if (!tx.file) return json({ ...summarise(tx), receipt: null, note: "Nothing to remove: no receipt attached." });
      const blocked = gate(`remove receipt "${tx.file.name}" from transaction "${tx.description}"`, ok);
      if (blocked) return blocked;
      const res = await lendlord.client.upload<{ transaction?: TransactionRecord }>(
        `/api/transactions/${transactionId}`,
        transactionForm(tx, { removeReceipt: true }),
        "PUT",
      );
      if (res.transaction?.file) return fail("Lendlord did not remove the receipt. Check get_transaction.");
      lendlord.invalidate();
      return json({ ...summarise(tx), receipt: null, removed: tx.file.name });
    }),
  );
}
