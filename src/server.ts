import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GuardConfig, WriteGuard } from "./guard.js";
import type { Lendlord } from "./lendlord.js";
import { registerTools } from "./tools.js";
import { registerMoreTools } from "./more-tools.js";
import { registerWriteTools } from "./write-tools.js";

export const VERSION = "0.1.0";

/** One McpServer per MCP session, so write confirmation is scoped to that session. */
export function createSessionServer(lendlord: Lendlord, guardConfig: GuardConfig): McpServer {
  const server = new McpServer(
    { name: "lendlord-mcp", version: VERSION },
    {
      instructions:
        "Manage the user's Lendlord landlord account. Start with list_properties to get property ids. " +
        "Tools that change data need the user's approval once per session: if a tool says confirmation is needed, " +
        "ask the user, then retry with confirm: true.",
    },
  );
  const ctx = { lendlord, guard: new WriteGuard(guardConfig) };
  registerTools(server, ctx);
  registerWriteTools(server, ctx);
  registerMoreTools(server, ctx);
  return server;
}
