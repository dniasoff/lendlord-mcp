# lendlord-mcp

[![npm](https://img.shields.io/npm/v/lendlord-mcp)](https://www.npmjs.com/package/lendlord-mcp) [![CI](https://github.com/dniasoff/lendlord-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/dniasoff/lendlord-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude Code, Claude Desktop, Claude.ai connectors, or any MCP client) manage a [Lendlord](https://app.lendlord.io) landlord account: properties, documents, tenants, maintenance, tasks, rent, transactions, compliance, and filing emails against properties.

Lendlord has no public API. This server wraps the private JSON API used by the Lendlord web app, reverse-engineered from browser traffic and the public JS bundle ([`docs/api.md`](docs/api.md)). **Every write tool has passed a live round-trip test** against a real account (`test/live-write.test.ts`): it creates a throwaway property, exercises the tool, reads the result back, and cleans up.

> **Disclaimer:** Unofficial and not affiliated with Lendlord. It uses undocumented endpoints that may change without notice. Use it only with your own account, at your own risk, and check Lendlord's terms of service.

## Quick start

### Local (Claude Code / Claude Desktop / any stdio client)

```json
{
  "mcpServers": {
    "lendlord": {
      "command": "npx",
      "args": ["-y", "lendlord-mcp"],
      "env": {
        "LENDLORD_EMAIL": "you@example.com",
        "LENDLORD_PASSWORD": "your-password"
      }
    }
  }
}
```

Claude Code CLI:

```bash
claude mcp add lendlord -e LENDLORD_EMAIL=you@example.com -e LENDLORD_PASSWORD=... -- npx -y lendlord-mcp
```

### Cursor

Add the server to `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "lendlord": {
      "command": "npx",
      "args": ["-y", "lendlord-mcp@latest"],
      "env": {
        "LENDLORD_EMAIL": "you@example.com",
        "LENDLORD_PASSWORD": "your-password"
      }
    }
  }
}
```

Cursor starts the configured command as its MCP server. To pick up a newly published tool or version, use `lendlord-mcp@latest` as above, then restart the server from Cursor's MCP settings (or restart Cursor). If the tool list is still stale, remove and re-add the server so Cursor starts a fresh `npx` process.

### Remote (online / hosted agents)

Run it as a Streamable HTTP server behind HTTPS, then point the agent at `https://<host>/mcp` with the bearer token.

```bash
docker build -t lendlord-mcp .
docker run -p 8080:8080 \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e LENDLORD_EMAIL=you@example.com -e LENDLORD_PASSWORD=... \
  lendlord-mcp
```

Without Docker: `MCP_TRANSPORT=http MCP_AUTH_TOKEN=... npx -y lendlord-mcp`. `GET /health` is the health check, and every `/mcp` request must send `Authorization: Bearer <MCP_AUTH_TOKEN>`.

## Safety model

- **Write confirmation once per session.** The first tool call that would change data is refused, with a message telling the agent to ask you. After you approve, the agent repeats the call with `confirm: true`, and later writes in the same session go through without asking again. A new session (a new stdio process, or a new `Mcp-Session-Id` over HTTP) starts locked again.
- `LENDLORD_READ_ONLY=true` disables every write.
- `LENDLORD_AUTO_CONFIRM=true` skips the confirmation for unattended automation.
- Lendlord admin endpoints are blocked, including through the raw `lendlord_request` tool.
- Credentials stay in your environment. Nothing is sent anywhere except `app.lendlord.io`.

## Tools

| Area | Read | Write |
|---|---|---|
| Account | `get_account` (user, owners, plan limits) | |
| Properties | `list_properties`, `get_property`, `list_property_fields`, `compliance_overview` | `add_property`, `update_property`, `update_property_images`, `delete_property` |
| Documents | `list_documents` | `upload_document` (path / URL / base64, into a slot like `gasCertificate` or a custom key), `rename_document`, `link_document`, `send_document` (emails it), `delete_document` |
| Email filing | `find_property` | `file_email` |
| Tenants | `list_tenants`, `get_tenant` | `add_tenant`, `update_tenant`, `delete_tenant` |
| Maintenance & history | `list_communications` (up to 1000, filter by property), `get_communication` | `create_maintenance_report`, `log_communication` (back-dated email/call history), `update_communication`, `add_communication_message`, `delete_communication` |
| Tasks & alerts | `list_tasks` | `create_task`, `update_task` (edit, complete, reopen, delete) |
| Money | `get_rent_collection`, `list_transactions` (search, amount, type, property, with/without receipt), `get_transaction`, `get_profit_and_loss` | `update_transaction`, `attach_transaction_receipt`, `remove_transaction_receipt` |
| Anything else | `lendlord_request` (GET) | `lendlord_request` (POST/PUT/PATCH/DELETE) |

Property fields use Lendlord's own names, for example `"Property Value"`, `"EPC Due Date"` and `"Gas Certificate Due Date"`. Call `list_property_fields` for the full list. Updates are partial: only the fields you pass change, and `null` clears a field.

Values are checked and converted before anything is sent, and the response lists any conversions:

| Kind | Accepts | Stored as |
|---|---|---|
| Dates | `2026-10-15`, `15/10/2026`, ISO date-time | ISO timestamp |
| Money / counts | `150000`, `"£150,000"`, `"150k"`, `"1.2m"`, `"£650 pcm"` | number |
| `Internal Area` | `73`, `"73 sq m"`, `"73 square metres"`, `"790 sq ft"` (converted) | square metres |
| Rates, agent fee, ownership | `"4.5%"` or `4.5`; values of 1 or less are taken as fractions | fraction (`0.045`) |

Anything ambiguous, such as `"73 m"` or `"about 150k"`, is rejected with a field-specific error before the confirmation prompt, so no write is attempted.

**Tenants** belong to exactly one property (`propertyDetailsId`). `list_tenants`, `get_tenant` and `get_property` show the linked property's address, and `propertyMissing: true` flags a link to a deleted property. To move a tenant, use `update_tenant { fields: { propertyDetailsId } }`.

**Reliability:** network drops and Lendlord's transient `500 socket hang up` / 502–504 errors are retried automatically for reads and updates. Document uploads are retried only after checking that the file didn't actually land, so a retry never creates a duplicate document.

**Property Photos:** `update_property_images` uploads image files into the property's Photos gallery using Lendlord's legacy images collection. Pass `files` to add images, `removeImageKeys` to remove them, or both to replace old images after the new uploads succeed. The image keys are available under `get_property` → `fields.images`. `upload_document` remains for Documents such as deeds and EPCs.

## Filing emails against properties

The server doesn't read any mailbox. Your agent reads mail with its own email tools (Gmail, Outlook, IMAP and so on) and uses two helpers:

1. `find_property { text }` ranks properties against the email's subject and body. It scores postcode matches (spacing-insensitive), house number plus street, tenant email or name, and policy, certificate and account numbers.
2. `file_email { entityId, emlBase64 | subject/from/to/date/text/html, attachments[] }` stores the email as an `.eml` document named `YYYY-MM-DD - Subject.eml` on the property (or tenant). Each attachment becomes its own document named `YYYY-MM-DD - Subject - file.pdf`.

3. `log_communication { propertyId, date, subject, summary, counterparties[] }` adds a dated entry to the property's communication history, so threads appear in `list_communications`. Lendlord has no generic communication log, and landlords can't start a tenant "conversation" without a tenant. So the entry is stored as a back-dated, closed maintenance report of type "Other" that isn't shared with tenants.

A typical agent instruction: *"For each new email about a rental property, call find_property with the subject and body. If the top score is clearly ahead, file_email it to that property and log_communication a one-line summary. Otherwise ask me."*

## Attaching invoices to payments

Bank and manual transactions (payments) keep their attachment as a **receipt on the transaction**, not as a normal document, so `upload_document` can't reach them. Use:

1. `list_transactions { startDate, endDate, search?, amount?, hasReceipt? }` to find the payment, for example the £27.74 Octopus payment with no receipt yet.
2. `attach_transaction_receipt { transactionId, filePath | url | base64+fileName }` to attach the invoice. A transaction holds one attachment, and attaching again replaces it.
3. `get_transaction` returns the receipt name and a temporary download link, and `remove_transaction_receipt` removes it. `update_transaction` can change a transaction's property and/or category while keeping its receipt attached.

Only the receipt changes: the rest of the transaction is re-saved exactly as it was.

## Configuration

| Env var | Purpose |
|---|---|
| `LENDLORD_EMAIL`, `LENDLORD_PASSWORD` | Login. |
| `LENDLORD_SESSION_COOKIE` | Alternative to email/password: a `Cookie` header from a logged-in browser. |
| `LENDLORD_TOTP_SECRET` | Base32 TOTP secret, if 2FA is enabled. |
| `LENDLORD_READ_ONLY` | `true` disables writes. |
| `LENDLORD_AUTO_CONFIRM` | `true` skips the once-per-session write confirmation. |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `MCP_HTTP_PORT` / `PORT` | HTTP port (default 8080). |
| `MCP_AUTH_TOKEN` | Required bearer token in HTTP mode. |
| `LENDLORD_PAYLOAD_KEY` | Override the auto-discovered payload key (normally not needed). |

## How it works

- **Auth:** `POST /api/loginUser` sets a session cookie, and the client logs in again automatically when the session expires. TOTP 2FA is supported.
- **Payload encryption:** the web app wraps JSON bodies as `ivHex:cipherHex` using AES-256-CTR with a static key that ships in its public JavaScript. The client finds that key in the live bundle at startup and caches it in `~/.cache/lendlord-mcp`. The key is never stored in this repo, and the client picks up a new one if Lendlord rotates it.
- **Data model:** `GET /api/getUserById` returns most of the account in one payload: properties, tenants, tasks and alerts ("opportunities"), owners and companies. Documents link to properties and tenants through `entities`.

The full protocol notes, including request formats captured from the web app, are in [`docs/api.md`](docs/api.md).

## Development

```bash
npm install
npm run build
npm test                    # offline: unit tests + in-memory MCP tests against a fake Lendlord
```

Live tests run against your own account. Put `LENDLORD_EMAIL` and `LENDLORD_PASSWORD` in `.env`, which is git-ignored.

```bash
LENDLORD_LIVE_TESTS=1 node --env-file=.env node_modules/vitest/vitest.mjs run test/live.test.ts
LENDLORD_LIVE_WRITE_TESTS=1 LENDLORD_LIVE_UPLOAD_TESTS=1 node --env-file=.env node_modules/vitest/vitest.mjs run test/live-write.test.ts
```

The write test creates and deletes its own `ZZ TEST lendlord-mcp …` property, tenant, report, task and documents.

**Adding a tool:** capture the real request in the web app first, implement it, then add a step to `test/live-write.test.ts` that reads the result back. Never commit captures: `.playwright-mcp/`, `captures/` and `.env` are git-ignored.

Before pushing, run `npm run check` (Biome lint and format check, typecheck, tests). `npm run format` fixes formatting. CI runs the same checks plus tests on Node 20, 22 and 24, a build and package-contents check, a dependency audit and a Docker smoke test.

Issues and the roadmap are tracked with [Beads](https://github.com/gastownhall/beads) (`bd ready`).

## Versioning and releases

The project uses [Semantic Versioning](https://semver.org/), driven by [Conventional Commits](https://www.conventionalcommits.org/):

| Commit / PR title | Release |
|---|---|
| `fix: …` | patch (0.1.0 → 0.1.1) |
| `feat: …` | minor (0.1.0 → 0.2.0) |
| `feat!: …` or a `BREAKING CHANGE:` footer | major after 1.0. Before 1.0 it bumps minor |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:` | no release on their own |

[release-please](https://github.com/googleapis/release-please) keeps a **release PR** open with the next version and CHANGELOG entries. Merging it:

1. bumps `package.json`, `server.json` and `CHANGELOG.md`, and tags `vX.Y.Z`;
2. creates the GitHub release;
3. publishes `ghcr.io/dniasoff/lendlord-mcp:X.Y.Z` (and `:latest`);
4. publishes to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no token) with a signed provenance statement.

To pin a version, use `npx -y lendlord-mcp@0.1.0` (or `github:dniasoff/lendlord-mcp#v0.1.0`) or the matching Docker tag. `lendlord-mcp --version` and `GET /health` report the running version.

## License

[MIT](LICENSE)
