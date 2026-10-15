import { describe, expect, it } from "vitest";
import { buildEml, normaliseTenantFields, rankProperties } from "../src/more-tools.js";
import { mimeFor } from "../src/write-tools.js";

const props = [
  { _id: "a", property: { "Property Address": "12 Acacia Avenue, Testtown", "Property Postcode": "AB1 2CD", "Policy Number": "POL-998877" } },
  { _id: "b", property: { "Property Address": "7 Birch Road, Testtown", "Property Postcode": "EF3 4GH" } },
  { _id: "c", property: { "Property Address": "12 Birch Close, Othertown", "Property Postcode": "IJ5 6KL" } },
];
const tenants = [{ name: "Jane Example", email: "jane@example.com", propertyDetailsId: "b" }];

describe("rankProperties", () => {
  it("matches postcodes regardless of spacing and case", () => {
    expect(rankProperties("boiler broken at ab12cd please help", props, tenants)[0]!.propertyId).toBe("a");
  });

  it("prefers house number + street over street alone", () => {
    const ranked = rankProperties("Leak at 12 Birch Close", props, tenants);
    expect(ranked[0]!.propertyId).toBe("c");
    expect(ranked.map((r) => r.propertyId)).toContain("b");
  });

  it("matches tenant email and identifiers", () => {
    expect(rankProperties("From: jane@example.com", props, tenants)[0]!.propertyId).toBe("b");
    expect(rankProperties("Renewal for policy POL-998877", props, tenants)[0]!.propertyId).toBe("a");
  });

  it("returns nothing for unrelated text", () => {
    expect(rankProperties("newsletter about interest rates", props, tenants)).toEqual([]);
  });
});

describe("buildEml", () => {
  it("builds a plain-text message with headers", () => {
    const eml = buildEml({ subject: "Hi", from: "a@x.com", to: "b@y.com", date: "2026-10-15T09:00:00Z", text: "Body" });
    expect(eml).toMatch(/^From: a@x\.com\r\nTo: b@y\.com\r\nSubject: Hi\r\nDate: Thu, 15 Oct 2026 09:00:00 GMT\r\n/);
    expect(eml).toContain("Content-Type: text/plain; charset=utf-8\r\n\r\nBody");
  });

  it("uses multipart/alternative when both text and html are given", () => {
    const eml = buildEml({ subject: "Hi", text: "t", html: "<p>h</p>" });
    expect(eml).toMatch(/multipart\/alternative; boundary="b[0-9a-f]+"/);
    expect(eml).toContain("<p>h</p>");
  });
});

describe("helpers", () => {
  it("normalises tenant dates only", () => {
    expect(normaliseTenantFields({ tenancyStartDate: "2026-01-01", notes: "2026-01-01" })).toEqual({
      tenancyStartDate: "2026-01-01T00:00:00.000Z",
      notes: "2026-01-01",
    });
  });

  it("infers MIME types Lendlord accepts from the file name", () => {
    expect(mimeFor("invoice.PDF")).toBe("application/pdf");
    expect(mimeFor("a.txt", "application/octet-stream")).toBe("text/plain");
    expect(mimeFor("a.png", "image/png")).toBe("image/png");
  });
});
