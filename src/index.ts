#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { LendlordClient } from "./client.js";
import type { GuardConfig } from "./guard.js";
import { Lendlord } from "./lendlord.js";
import { createSessionServer } from "./server.js";

const env = process.env;
const lendlord = new Lendlord(LendlordClient.fromEnv(env));
const guardConfig: GuardConfig = {
  readOnly: env.LENDLORD_READ_ONLY === "true",
  autoConfirm: env.LENDLORD_AUTO_CONFIRM === "true",
};

if ((env.MCP_TRANSPORT ?? "stdio") === "http") await serveHttp();
else await createSessionServer(lendlord, guardConfig).connect(new StdioServerTransport());

async function serveHttp(): Promise<void> {
  const token = env.MCP_AUTH_TOKEN;
  if (!token) throw new Error("MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http");
  const port = Number(env.MCP_HTTP_PORT ?? env.PORT ?? 8080);
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const authorised = (req: IncomingMessage) => {
    const given = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return void res.writeHead(200).end("ok");
    if (url.pathname !== "/mcp") return void res.writeHead(404).end();
    if (!authorised(req)) return void res.writeHead(401, { "www-authenticate": "Bearer" }).end();

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return void res.writeHead(400).end("Invalid JSON");
      }
    }

    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId || req.method !== "POST" || !isInitializeRequest(body)) {
        return void res.writeHead(sessionId ? 404 : 400).end("Unknown or missing MCP session");
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, created),
      });
      created.onclose = () => {
        if (created.sessionId) sessions.delete(created.sessionId);
      };
      await createSessionServer(lendlord, guardConfig).connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  });

  http.listen(port, () => console.error(`lendlord-mcp listening on :${port}/mcp`));
}
