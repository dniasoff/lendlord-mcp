# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org/). From 0.1.0 on, this file is maintained by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/).

## [0.2.0](https://github.com/dniasoff/lendlord-mcp/compare/v0.1.0...v0.2.0) (2026-10-15)


### Features

* add send_document tool, Biome lint/format CI and release-please versioning ([a83ef18](https://github.com/dniasoff/lendlord-mcp/commit/a83ef18d8e238803a1e877028ea7883ccb665703))

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
