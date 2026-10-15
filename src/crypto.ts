import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Lendlord's web app wraps JSON bodies as "<ivHex>:<cipherHex>" using
// AES-256-CTR with a static key shipped in its public JS bundle.
const ALGORITHM = "aes-256-ctr";
const KEY_PATTERN = /"aes-256-ctr",\w+="([^"]{32})"/;
const ENCRYPTED_PATTERN = /^[0-9a-f]{32}:[0-9a-f]*$/;

export function encrypt(key: string, plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${data.toString("hex")}`;
}

export function decrypt(key: string, payload: string): string {
  const [ivHex, dataHex] = payload.trim().split(":");
  if (!ivHex || dataHex === undefined) throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

export function isEncrypted(text: string): boolean {
  return ENCRYPTED_PATTERN.test(text.trim());
}

type Fetch = typeof fetch;

/** Find the payload key by scanning the app's JS bundles: entry scripts first, then lazy chunks. */
export async function discoverKey(
  baseUrl: string,
  fetchImpl: Fetch = fetch,
): Promise<{ key: string; runtime: string }> {
  const html = await (await fetchImpl(`${baseUrl}/login`)).text();
  const scripts = [...html.matchAll(/src="\/?([\w.-]+\.bundle\.js)"/g)].map((m) => m[1]);
  const runtime = scripts.find((s) => s.startsWith("runtime.")) ?? "";

  const tryScripts = async (names: string[]): Promise<string | undefined> => {
    for (let i = 0; i < names.length; i += 24) {
      const batch = names.slice(i, i + 24);
      const bodies = await Promise.all(
        batch.map((n) =>
          fetchImpl(`${baseUrl}/${n}`)
            .then((r) => (r.ok ? r.text() : ""))
            .catch(() => ""),
        ),
      );
      for (const body of bodies) {
        const match = KEY_PATTERN.exec(body);
        if (match) return match[1];
      }
    }
    return undefined;
  };

  const fromEntry = await tryScripts(scripts.filter((s) => s !== runtime));
  if (fromEntry) return { key: fromEntry, runtime };
  if (!runtime) throw new Error("Could not locate Lendlord runtime bundle");

  const runtimeJs = await (await fetchImpl(`${baseUrl}/${runtime}`)).text();
  const chunks = parseChunkFiles(runtimeJs);
  const key = await tryScripts(chunks);
  if (!key) throw new Error("Could not find payload key in Lendlord bundles");
  return { key, runtime };
}

/** Extract lazy chunk filenames ("<name|id>.<hash>.bundle.js") from the webpack runtime. */
export function parseChunkFiles(runtimeJs: string): string[] {
  const end = runtimeJs.indexOf('}[e]+".bundle.js"');
  if (end < 0) return [];
  const start = runtimeJs.lastIndexOf('+"."+{', end);
  const hashes = [...runtimeJs.slice(start, end + 1).matchAll(/(\d+):"([0-9a-f]{20})"/g)];
  const names = new Map(
    [...runtimeJs.slice(Math.max(0, start - 4000), start).matchAll(/(\d+):"([A-Za-z][\w.]*)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  return hashes
    .map(([, id, hash]) => ({ name: names.get(id) ?? id, hash }))
    .filter(({ name }) => !name.startsWith("vendor.") && !name.startsWith("reactPlayer"))
    .map(({ name, hash }) => `${name}.${hash}.bundle.js`);
}

const cacheFile = join(homedir(), ".cache", "lendlord-mcp", "key.json");

/** Resolve the key from env, disk cache (keyed by runtime bundle), or by scanning bundles. */
export async function resolveKey(baseUrl: string, fetchImpl: Fetch = fetch): Promise<string> {
  if (process.env.LENDLORD_PAYLOAD_KEY) return process.env.LENDLORD_PAYLOAD_KEY;
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as { key: string };
    if (cached.key?.length === 32) return cached.key;
  } catch {
    // No cache yet.
  }
  const { key, runtime } = await discoverKey(baseUrl, fetchImpl);
  try {
    await mkdir(join(homedir(), ".cache", "lendlord-mcp"), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ key, runtime, discoveredAt: new Date().toISOString() }));
  } catch {
    // Cache is best-effort.
  }
  return key;
}

export async function clearCachedKey(): Promise<void> {
  await writeFile(cacheFile, "{}").catch(() => undefined);
}
