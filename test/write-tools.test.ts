import { describe, expect, it } from "vitest";
import { legacyPropertyImageForm, mergeProperty, normaliseFields } from "../src/write-tools.js";

describe("legacyPropertyImageForm", () => {
  it("matches the web app's property gallery multipart fields", () => {
    const form = legacyPropertyImageForm("image-key", {
      name: "front.jpg",
      type: "image/jpeg",
      data: new Uint8Array([1, 2]),
    });
    const sent = Object.fromEntries([...form.entries()]);
    expect(sent.key).toBe("image-key");
    expect(sent.name).toBe("front.jpg");
    expect(sent.collectionName).toBe("images");
    expect((sent.file as File).name).toBe("front.jpg");
    expect((sent.file as File).type).toBe("image/jpeg");
  });
});

describe("normaliseFields", () => {
  it("turns YYYY-MM-DD into ISO timestamps for date fields only", () => {
    expect(
      normaliseFields({
        "EPC Due Date": "2030-01-01",
        "Utility Supplier Gas Contract End": "2027-02-03",
        Lender: "2030-01-01",
      }),
    ).toEqual({
      "EPC Due Date": "2030-01-01T00:00:00.000Z",
      "Utility Supplier Gas Contract End": "2027-02-03T00:00:00.000Z",
      Lender: "2030-01-01",
    });
  });
});

describe("mergeProperty", () => {
  const current = {
    _id: "p1",
    status: "active",
    clientDetailsId: "c1",
    applicants: ["a1"],
    property: {
      "Property Address": "1 Test St",
      Lender: "Old Bank",
      "Property Value": 100,
      LTV: 0.5,
      Equity: 50,
      "Annual ROI": 3,
      "10Y IRR": 1,
    },
  };

  it("keeps existing editable fields, applies changes, drops computed fields", () => {
    const merged = mergeProperty(current, { "Property Value": 200, "Rate Expiry Date": "2028-06-30" });
    expect(merged).toEqual({
      _id: "p1",
      status: "active",
      clientDetailsId: "c1",
      applicants: ["a1"],
      assumptions: {},
      property: {
        "Property Address": "1 Test St",
        Lender: "Old Bank",
        "Property Value": 200,
        "Rate Expiry Date": "2028-06-30T00:00:00.000Z",
      },
    });
  });

  it("removes fields set to null", () => {
    expect(mergeProperty(current, { Lender: null }).property).not.toHaveProperty("Lender");
  });
});
