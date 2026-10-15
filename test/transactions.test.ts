import { describe, expect, it } from "vitest";
import { filterTransactions, type TransactionRecord } from "../src/tools.js";
import { transactionForm } from "../src/transaction-tools.js";

const tx: TransactionRecord = {
  _id: "t1",
  clientDetailsId: "c1",
  type: "spent",
  description: "Octopus Energy DD",
  amount: 27.74,
  date: "2026-10-07T00:00:00.000Z",
  status: "mapped",
  hasSubTransactions: false,
  categoryId: "cat1",
  propertyDetailsId: "p1",
  autoMapped: null,
  notes: "",
  zero: 0,
  category: { _id: "cat1", name: "Utilities" }, // populated join: must not be sent back
  file: { url: "Receipts/c1/Transactions/t1/old.pdf", name: "old.pdf" },
};

const entries = (form: FormData) => Object.fromEntries([...form.entries()].map(([k, v]) => [k, v]));

describe("transactionForm", () => {
  it("attaches a file and re-sends only the transaction's plain values", () => {
    const form = transactionForm(tx, {
      file: { name: "inv.pdf", type: "application/pdf", data: new Uint8Array([1, 2]) },
    });
    const sent = entries(form);
    expect((sent.file as File).name).toBe("inv.pdf");
    expect((sent.file as File).type).toBe("application/pdf");
    expect(sent.fileName).toBe("inv.pdf");
    expect(sent).toMatchObject({
      _id: "t1",
      type: "spent",
      description: "Octopus Energy DD",
      amount: "27.74",
      categoryId: "cat1",
      propertyDetailsId: "p1",
      hasSubTransactions: "false", // booleans are kept, like the web app
      autoMapped: "null", // so are nulls
    });
    // empty strings and zeros are skipped like the web app; nested objects never go back
    expect(sent).not.toHaveProperty("notes");
    expect(sent).not.toHaveProperty("zero");
    expect(sent).not.toHaveProperty("category");
    expect(Object.values(sent)).not.toContain("[object Object]");
    expect(sent).not.toHaveProperty("removeReceipt");
  });

  it("removes the receipt without sending a file", () => {
    const sent = entries(transactionForm(tx, { removeReceipt: true }));
    expect(sent.removeReceipt).toBe("true");
    expect(sent).not.toHaveProperty("file");
    expect(sent).not.toHaveProperty("fileName");
    expect(sent.description).toBe("Octopus Energy DD");
  });
});

describe("filterTransactions", () => {
  const all: TransactionRecord[] = [
    tx,
    { _id: "t2", type: "received", description: "Rent Mr Smith", amount: 650, propertyDetailsId: "p2" },
    { _id: "t3", type: "spent", description: "OCTOPUS ENERGY", amount: 31.1, propertyDetailsId: "p2" },
  ];
  const ids = (f: Parameters<typeof filterTransactions>[1]) => filterTransactions(all, f).map((t) => t._id);

  it("filters by text, case-insensitively", () => expect(ids({ search: "octopus" })).toEqual(["t1", "t3"]));
  it("filters by exact amount", () => expect(ids({ amount: 27.74 })).toEqual(["t1"]));
  it("filters by type and property", () => {
    expect(ids({ type: "received" })).toEqual(["t2"]);
    expect(ids({ propertyId: "p2" })).toEqual(["t2", "t3"]);
  });
  it("filters by whether a receipt is attached", () => {
    expect(ids({ hasReceipt: true })).toEqual(["t1"]);
    expect(ids({ hasReceipt: false })).toEqual(["t2", "t3"]);
  });
  it("combines filters and returns everything when none are given", () => {
    expect(ids({ search: "octopus", hasReceipt: false })).toEqual(["t3"]);
    expect(ids({})).toEqual(["t1", "t2", "t3"]);
  });
});
