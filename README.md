# lendlord-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude Code, Claude Desktop, Claude.ai connectors, and any other MCP client) fully manage a [Lendlord](https://app.lendlord.io) landlord account: properties, documents, tenants, rent, transactions, compliance, and email filing.

Lendlord has no public API or MCP server. This project wraps the private JSON API used by the Lendlord web app, reverse-engineered from browser traffic and the public JS bundle. See [`docs/api.md`](docs/api.md).

> **Status:** early. Working now: the core client (encryption, key auto-discovery, login/session, re-login), stdio and HTTP transports, once-per-session write confirmation, and read tools (`get_account`, `list_properties`, `get_property`, `list_documents`, `get_rent_collection`, `list_transactions`, `get_profit_and_loss`, `list_communications`, `compliance_overview`), plus the `lendlord_request` escape hatch. Dedicated write tools come next, and each ships only after a live round-trip test. The plan is tracked in Beads (`bd ready`).

> **Disclaimer:** Unofficial and not affiliated with Lendlord. It uses undocumented endpoints that can change without notice. Use it only with your own account, and check Lendlord's terms of service before relying on it.

---

## Goals

1. **Manage everything from an AI agent.** Every action in the Lendlord UI that matters for running a portfolio should be callable as an MCP tool.
2. **Easy for online agents.** It ships as an npm package (`npx -y lendlord-mcp`) for local stdio clients and can also run as a **remote Streamable HTTP** server, so hosted agents can connect over HTTPS. There is no website or UI.
3. **Email → property filing.** Lendlord has no inbound-email feature. The MCP adds one: give it an email (raw `.eml`/MIME or structured fields), it matches the email to a property and files the message and its attachments as documents on that property.
4. **Safe by default.** Destructive tools need explicit confirmation, a read-only mode is available, and credentials and portfolio data never leave the machine or server you run it on.

## Non-goals

- No web UI or dashboard.
- No Lendlord admin, partner, broker, or bridging-lender features (`/api/admin/*` and similar).
- No scraping of the rendered HTML. Everything goes through the JSON API.

---

## Tech stack

| Choice | Why |
|---|---|
| **TypeScript + Node 20+** | The official MCP SDK (`@modelcontextprotocol/sdk`) is TypeScript-first, and most MCP servers are TS on npm. Users run it with `npx` and install no binary. |
| **stdio + Streamable HTTP transports** | stdio for local clients (Claude Code/Desktop). Streamable HTTP, with bearer-token auth, for remote and online agents. |
| `zod` | Tool input schemas. |
| Node `crypto` | Reproduces Lendlord's payload encryption (AES-256-CTR, see below). |
| `mailparser` | Parses `.eml`/MIME for email filing. |
| `vitest` | Tests, including recorded-fixture tests with no network. |

---

## How the Lendlord API works (summary)

The full write-up is in [`docs/api.md`](docs/api.md).

- **Base URL:** `https://app.lendlord.io/api/*`, same origin as the web app.
- **Auth:** `POST /api/loginUser` sets a **session cookie**. Every later request sends that cookie. `GET /api/getUserFromCookie` validates the session. The response includes `passedTwoFA`, so accounts with 2FA turned on need `POST /api/twoFA/verify`.
- **Payload encryption:** JSON request bodies and almost all JSON responses are wrapped as `"<ivHex>:<cipherHex>"` using **AES-256-CTR with a static key embedded in the public web bundle**. This is obfuscation, not real security. The client **extracts the key from the live bundle at startup** and caches it, so the key is never committed here and the client keeps working if Lendlord rotates it.
- **Multipart uploads** (documents, receipts, bulk property import) are sent as plain, unencrypted `FormData`.
- **Master read:** `GET /api/getUserById` returns the user, applicants, `client` settings and limits, and `portfolioDetails`, which holds every property with human-readable keys such as `"Property Address"`, `"Property Value"`, and `"EPC Due Date"`.
- **Documents** are linked to entities with `entities: [{ entityType: "property" | "tenant" | ..., entityId }]`. This one mechanism covers adding files, filing emails, and organising certificates.

---

## Planned MCP tools

Tools marked ⚠️ change or delete data. **Confirmation happens once per session.** The first ⚠️ call in a session is rejected with a prompt explaining what is about to change. The agent then asks the user and repeats the call with `confirm: true`. After that, every write in the same MCP session (one stdio process, or one `Mcp-Session-Id` over HTTP) goes through without asking again. ⚠️ tools are disabled entirely when `LENDLORD_READ_ONLY=true`. Unattended automation can set `LENDLORD_AUTO_CONFIRM=true` to skip the prompt.

### Account
| Tool | Endpoint(s) |
|---|---|
| `get_account` | `GET /getUserById`, `GET /getUserFromCookie` |
| `get_usage_limits` | `GET /usageCounts`, plus `client.accountLimitations` / `monthlyLimitations` |
| `list_team_users` | `GET /getClientUsers` |
| `list_applicants` / `update_applicant` ⚠️ | from `getUserById`, `PUT /updateApplicant/:id` |

### Properties
| Tool | Endpoint(s) |
|---|---|
| `list_properties` | `getUserById → portfolioDetails` (filter by status, ownership, postcode) |
| `get_property` | same, by id, plus documents and tenants for that property |
| `add_property` ⚠️ | `POST /addProperties` `{ properties:[{property, applicants}], country }` |
| `update_property` ⚠️ | `PUT /updateSingleProperty/:id` `{ property, country }` / `POST /updateProperty` |
| `delete_property` ⚠️ | `DELETE /deleteProperty/:id` |
| `mark_property_sold` / `unsold` ⚠️ | `POST /saleProperty`, `PUT /unSoldProperty/:id` |
| `get_property_history` | `GET /getPropertySnapshots/:id`, `GET /getClientSnapshots/:from/:to` |
| `lookup_epc` | `GET /epcAPI?address=&postcode=` |
| `import_properties_from_file` ⚠️ | `POST /extractPropertiesFromFile` (multipart) |

### Documents and files
| Tool | Endpoint(s) |
|---|---|
| `list_documents` | `GET /documents`, `GET /documents/:entityType/:entityId` |
| `upload_document` ⚠️ | `POST /documents` (multipart: `key`, `file`, `name`, `entities[]`). Accepts a local path, URL, or base64 |
| `download_document` | `GET /getSignedUrl?url=&fileName=&download=` |
| `update_document` ⚠️ | `PATCH /documents/:id` (rename, re-link) |
| `replace_document_file` ⚠️ | `PUT /documents/:id` (multipart) |
| `link_document` ⚠️ | `POST /documents/copy` `{ entities, key, path }` |
| `delete_document` ⚠️ | `DELETE /documents/:a/:b/:c` |
| `send_document_by_email` ⚠️ | `POST /documents/:id/send` |
| `extract_certificate_data` | `POST /openAI/extractDataFromCertificate` (gas safety, EPC, EICR, etc.) |

### Email → property filing (built by this project)
| Tool | What it does |
|---|---|
| `match_email_to_property` | Parses the email and scores every property by postcode, address, tenant name/email, policy and certificate numbers. Returns ranked candidates. Read-only. |
| `file_email_to_property` ⚠️ | Converts the email to a document (`.eml`, plus an optional rendered PDF/HTML copy), uploads it and every attachment with `entities:[{entityType:"property", entityId}]`, and names them `YYYY-MM-DD – <subject>`. |
| `file_email_auto` ⚠️ | Runs match and file in one call. Only files automatically when the match confidence is above a threshold; otherwise returns the candidates. |

The server is mailbox-agnostic. The agent fetches mail with whatever email tools it already has (Gmail/Outlook MCPs, IMAP) and passes the message in. Polling a mailbox is out of scope for v1.

### Tenants and rent
| Tool | Endpoint(s) |
|---|---|
| `list_tenants` | `GET /getClientTenants` |
| `get_tenant` / `update_tenant` ⚠️ | `/tenant`, `/tenant/details` |
| `get_rent_collection` | `GET /getRentCollection/:DD-MM-YYYY/:DD-MM-YYYY` |
| `generate_tenancy_agreement` ⚠️ | `POST /tenancyAgreement/:id` |

### Money
| Tool | Endpoint(s) |
|---|---|
| `list_transactions` | `GET /transactions?startDate=&endDate=&status=` |
| `get_pnl` | `GET /pnlData`, `GET /pnlCategory`, `GET /pnlCategoryMapping` |
| `categorise_transaction` ⚠️ | to be confirmed |

### Communications, maintenance and compliance
| Tool | Endpoint(s) |
|---|---|
| `list_communications` | `GET /communications?type=&skip=&limit=` |
| `create_communication` ⚠️ | `POST /communications` (JSON or multipart with files) |
| `update_communication` / `delete_communication` ⚠️ | `PUT` / `DELETE /communications/:id` |
| `post_communication_message` ⚠️ | `POST /communications/:id/message` |
| `compliance_overview` | Derived: EPC, gas, EICR and insurance expiry dates from properties and documents. Read-only. |

### Escape hatch
| Tool | Purpose |
|---|---|
| `lendlord_request` ⚠️ | Raw `{method, path, body}` call with encryption handled. Covers endpoints that don't have a dedicated tool yet. `/api/admin/*` is blocked. |

---

## Configuration (planned)

| Env var | Purpose |
|---|---|
| `LENDLORD_EMAIL` / `LENDLORD_PASSWORD` | Login credentials. Set them in your MCP client config or a secret store, never in this repo. |
| `LENDLORD_SESSION_COOKIE` | Alternative: reuse an existing browser session. |
| `LENDLORD_TOTP_SECRET` | Optional, for accounts with 2FA. |
| `LENDLORD_READ_ONLY` | `true` disables every ⚠️ tool. |
| `LENDLORD_AUTO_CONFIRM` | `true` skips the once-per-session write confirmation (for unattended agents). |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `MCP_HTTP_PORT` / `MCP_AUTH_TOKEN` | Port and required bearer token for HTTP mode. |

Example Claude Code config:

```json
{
  "mcpServers": {
    "lendlord": {
      "command": "npx",
      "args": ["-y", "lendlord-mcp"],
      "env": { "LENDLORD_EMAIL": "you@example.com", "LENDLORD_PASSWORD": "…" }
    }
  }
}
```

Remote and online agents: run `MCP_TRANSPORT=http MCP_AUTH_TOKEN=… npx lendlord-mcp` on a server or container (for example Fly.io or Cloud Run), then add `https://<host>/mcp` as a remote MCP server with the bearer token.

---

## Implementation plan

The phases are tracked as Beads issues (`bd list`). Summary:

1. **Core client.** Encryption (key auto-discovery from the bundle), login and session cookie handling, 2FA, automatic re-login on 401, and typed `get/post/put/patch/delete/upload` helpers. Unit tests against recorded encrypted fixtures.
2. **MCP server skeleton.** SDK setup, stdio and Streamable HTTP transports, auth token, read-only mode, a once-per-session write confirmation, and structured errors.
3. **Read tools.** Account, properties, documents, tenants, rent, transactions, P&L, communications, and compliance overview.
4. **Write tools.** Properties CRUD, document upload/link/rename/delete, communications, and tenants. Each one first needs a **live capture of the real request body** from the web app, to confirm field names before the tool ships.
5. **Email filing.** `.eml` parsing, the property matcher, and filing of the email and its attachments.
6. **Packaging.** npm publish, Dockerfile for HTTP mode, CI (lint, typecheck, test), and an MCP registry listing.

### Known unknowns
- The exact multipart field encoding for `entities` on upload (`entities[0][entityType]` vs JSON).
- The delete-document path segments (`/documents/:entityType/:entityId/:docId` is assumed).
- Tasks and reminders: the `/tasks` page made no distinct API call during capture, so they may arrive over the websocket (`/api/socketTicket`).
- Login request fields, and how strictly the session expires (`keepMeLoggedIn`).

## Development

```bash
npm install
npm run build
npm test                                   # unit + in-memory MCP tests, no network
LENDLORD_LIVE_TESTS=1 node --env-file=.env node_modules/vitest/vitest.mjs run   # read-only live tests
```

Put `LENDLORD_EMAIL` / `LENDLORD_PASSWORD` in a local `.env` file. It is git-ignored.

How the API was mapped:

1. Log into app.lendlord.io in a Playwright-controlled browser.
2. Capture `/api/*` traffic while using each page, then decrypt bodies locally.
3. Cross-reference against the `fetch("/api/...")` call sites in the JS bundle. `docs/endpoints-raw.txt` lists every non-admin path found there.

**Never commit captures.** They contain real portfolio data. `.playwright-mcp/` and `captures/` are git-ignored.
