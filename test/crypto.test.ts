import { describe, expect, it } from "vitest";
import { decrypt, encrypt, isEncrypted, parseChunkFiles } from "../src/crypto.js";
import { totp } from "../src/client.js";

const KEY = "0123456789abcdef0123456789abcdef"; // test key, not Lendlord's

describe("payload crypto", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt(KEY, '{"hello":"world"}');
    const b = encrypt(KEY, '{"hello":"world"}');
    expect(a).not.toBe(b);
    expect(isEncrypted(a)).toBe(true);
    expect(decrypt(KEY, a)).toBe('{"hello":"world"}');
  });

  it("rejects malformed payloads", () => {
    expect(isEncrypted("plain text")).toBe(false);
    expect(() => decrypt(KEY, "nope")).toThrow();
  });
});

describe("parseChunkFiles", () => {
  it("builds chunk filenames and skips vendor/player chunks", () => {
    const runtime =
      't.u=e=>(({70525:"vendor.pdf",99340:"reactPlayerWistia"}[e]||e)+"."+{103:"60b8e8b535fd6a6b4fad",70525:"aaaaaaaaaaaaaaaaaaaa",99340:"bbbbbbbbbbbbbbbbbbbb"}[e]+".bundle.js")';
    expect(parseChunkFiles(runtime)).toEqual(["103.60b8e8b535fd6a6b4fad.bundle.js"]);
  });
});

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 test vector", () => {
    // Secret "12345678901234567890" in base32; RFC value 94287082 at T=59s (last 6 digits).
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
  });
});
