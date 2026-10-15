# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org/). From 0.1.0 on, this file is maintained by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/).

## [0.2.0](https://github.com/dniasoff/lendlord-mcp/compare/v0.1.1...v0.2.0) (2026-10-15)


### Features

* add log_communication for back-dated communication history ([0973421](https://github.com/dniasoff/lendlord-mcp/commit/097342110477c9dede4c017ad9dd347088cb8423)), closes [#3](https://github.com/dniasoff/lendlord-mcp/issues/3) [#4](https://github.com/dniasoff/lendlord-mcp/issues/4) [#5](https://github.com/dniasoff/lendlord-mcp/issues/5) [#6](https://github.com/dniasoff/lendlord-mcp/issues/6) [#7](https://github.com/dniasoff/lendlord-mcp/issues/7)


### Bug Fixes

* list_communications pages through results up to 1000 and filters by property ([#5](https://github.com/dniasoff/lendlord-mcp/issues/5)) ([0973421](https://github.com/dniasoff/lendlord-mcp/commit/097342110477c9dede4c017ad9dd347088cb8423))
* retry transient upload and network errors without duplicating documents ([0973421](https://github.com/dniasoff/lendlord-mcp/commit/097342110477c9dede4c017ad9dd347088cb8423))
* show each tenant's linked property, flag missing properties, list tenants in get_property ([#4](https://github.com/dniasoff/lendlord-mcp/issues/4)) ([0973421](https://github.com/dniasoff/lendlord-mcp/commit/097342110477c9dede4c017ad9dd347088cb8423))
* validate and convert property and tenant field values before sending ([0973421](https://github.com/dniasoff/lendlord-mcp/commit/097342110477c9dede4c017ad9dd347088cb8423))

## [0.1.1](https://github.com/dniasoff/lendlord-mcp/compare/v0.1.0...v0.1.1) (2026-10-15)


### Bug Fixes

* add MIT license and publish to npm via trusted publishing ([960e8b0](https://github.com/dniasoff/lendlord-mcp/commit/960e8b0dead5cafd40d864042c0e333eab5a2cac))


### Documentation

* install from npm in quick start; add npm and CI badges ([2ce8f5a](https://github.com/dniasoff/lendlord-mcp/commit/2ce8f5a896bd413c2253cef6e0f399229beb7a62))

## 0.1.0 (2026-10-15)

First release.

### Features

* Encrypted Lendlord API client: payload key auto-discovered from the public bundle, cookie session, TOTP 2FA, automatic re-login
* MCP server over stdio and Streamable HTTP (bearer auth, one server per session), with write confirmation once per session, read-only mode and auto-confirm
* Properties: list, get, add, update (partial; `null` clears), delete, field list, compliance overview
* Documents: list, upload (path, URL or base64, into slots or custom keys), rename, link to property/tenant, send by email, delete
* Email filing for agents: `find_property` ranking and `file_email` (`.eml` plus attachments)
* Tenants: list, get, add, update, delete
* Maintenance reports: create, update/close/archive, internal notes and tenant replies, delete
* Tasks and alerts: list, create, edit, complete, reopen, delete
* Money: rent collection, transactions, profit and loss
* `lendlord_request` for any other endpoint (admin endpoints blocked)
* Dockerfile for remote HTTP deployments
