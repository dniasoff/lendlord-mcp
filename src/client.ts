import { createHmac } from "node:crypto";
import { clearCachedKey, decrypt, encrypt, isEncrypted, resolveKey } from "./crypto.js";

export interface ClientOptions {
  baseUrl?: string;
  email?: string;
  password?: string;
  /** A full Cookie header copied from a logged-in browser, used instead of email/password. */
  sessionCookie?: string;
  /** Base32 TOTP secret for accounts with 2FA enabled. */
  totpSecret?: string;
  fetch?: typeof fetch;
}

export class LendlordError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "LendlordError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body; encrypted the way the web app does. */
  json?: unknown;
  /** Multipart body; sent unencrypted. */
  form?: FormData;
}

export class LendlordClient {
  readonly baseUrl: string;
  private readonly opts: ClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly cookies = new Map<string, string>();
  private key?: string;
  private loginPromise?: Promise<void>;

  constructor(opts: ClientOptions = {}) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? "https://app.lendlord.io").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.sessionCookie) this.absorbCookieHeader(opts.sessionCookie);
  }

  static fromEnv(env = process.env): LendlordClient {
    return new LendlordClient({
      baseUrl: env.LENDLORD_BASE_URL,
      email: env.LENDLORD_EMAIL,
      password: env.LENDLORD_PASSWORD,
      sessionCookie: env.LENDLORD_SESSION_COOKIE,
      totpSecret: env.LENDLORD_TOTP_SECRET,
    });
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>("GET", path, { query });
  }
  post<T = unknown>(path: string, json?: unknown) {
    return this.request<T>("POST", path, { json });
  }
  put<T = unknown>(path: string, json?: unknown) {
    return this.request<T>("PUT", path, { json });
  }
  patch<T = unknown>(path: string, json?: unknown) {
    return this.request<T>("PATCH", path, { json });
  }
  delete<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }
  upload<T = unknown>(path: string, form: FormData, method: Method = "POST") {
    return this.request<T>(method, path, { form });
  }

  async request<T = unknown>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    if (!this.cookies.size) await this.login();
    try {
      return await this.send<T>(method, path, opts);
    } catch (err) {
      if (err instanceof LendlordError && err.status === 401 && this.canLogin()) {
        this.cookies.clear();
        await this.login();
        return this.send<T>(method, path, opts);
      }
      throw err;
    }
  }

  /** Log in with email/password (and TOTP if configured). Concurrent callers share one attempt. */
  login(): Promise<void> {
    this.loginPromise ??= this.doLogin().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private canLogin(): boolean {
    return Boolean(this.opts.email && this.opts.password);
  }

  private async doLogin(): Promise<void> {
    if (!this.canLogin()) {
      if (this.cookies.size) return;
      throw new Error("Set LENDLORD_EMAIL and LENDLORD_PASSWORD (or LENDLORD_SESSION_COOKIE)");
    }
    await this.send("POST", "/api/loginUser", {
      json: { email: this.opts.email, password: this.opts.password, keepMeLoggedIn: true },
    });
    const me = await this.send<{ passedTwoFA?: boolean }>("GET", "/api/getUserFromCookie");
    if (me?.passedTwoFA === false) {
      if (!this.opts.totpSecret) throw new Error("Account requires 2FA: set LENDLORD_TOTP_SECRET");
      await this.send("POST", "/api/twoFA/verify", {
        json: { code: totp(this.opts.totpSecret), keepMeLoggedIn: true },
      });
    }
  }

  private async payloadKey(): Promise<string> {
    this.key ??= await resolveKey(this.baseUrl, this.fetchImpl);
    return this.key;
  }

  private async send<T>(method: Method, path: string, opts: RequestOptions = {}, retriedKey = false): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = { accept: "*/*", referer: `${this.baseUrl}/` };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
      body = encrypt(await this.payloadKey(), JSON.stringify(opts.json));
      headers["content-type"] = "text/plain;charset=UTF-8";
    }

    const res = await this.fetchImpl(url, { method, headers, body, redirect: "manual" });
    this.absorbSetCookie(res.headers);
    const text = await res.text();

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")?.includes("/login")) {
      throw new LendlordError("Session expired", 401, path);
    }
    if (!res.ok) throw new LendlordError(text || res.statusText, res.status, path);

    const contentType = res.headers.get("content-type") ?? "";
    if (!text || (!isEncrypted(text) && !contentType.includes("json"))) return text as T;
    if (!isEncrypted(text)) return JSON.parse(text) as T;

    const plain = decrypt(await this.payloadKey(), text);
    // CTR mode never fails outright: a rotated key just yields garbage. Rediscover once and retry.
    if (looksLikeGarbage(plain)) {
      if (retriedKey) throw new LendlordError("Could not decrypt response (payload key changed?)", 500, path);
      await clearCachedKey();
      this.key = undefined;
      return this.send<T>(method, path, opts, true);
    }
    return parseJson(plain) as T;
  }

  private absorbSetCookie(headers: Headers): void {
    const list = headers.getSetCookie?.() ?? [];
    for (const raw of list) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  private absorbCookieHeader(header: string): void {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) this.cookies.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }
}

function looksLikeGarbage(text: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control bytes is the point (garbled decrypt)
  const control = text.slice(0, 256).match(/[\u0000-\u0008\u000e-\u001f�]/g)?.length ?? 0;
  return control > 2;
}

function parseJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  // Some endpoints (e.g. getUserById) double-encode: a JSON string containing JSON.
  while (typeof value === "string" && /^\s*[[{"]/.test(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

/** RFC 6238 TOTP (SHA-1, 30s, 6 digits) from a base32 secret. */
export function totp(secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/[\s=]/g, "").toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error("Invalid base32 TOTP secret");
    bits += v.toString(2).padStart(5, "0");
  }
  const keyBytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = createHmac("sha1", keyBytes).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}
