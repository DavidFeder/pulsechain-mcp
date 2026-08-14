# MCP protocol review — 2026-07-28 vs pulsechain-mcp

**Date:** 2026-08-14  
**Scope:** read-only decision support. No product-code changes.  
**Baseline reviewed:** `origin/main` = **v1.0.4** at `95e9a3370ced1024a80d7f861d5862a41709ec18`  
**Isolation branch:** `dev/mcp-protocol-review` (same SHA at branch creation; this file is docs-only)  
**Public repo:** https://github.com/DavidFeder/pulsechain-mcp  

**Not in scope:** wallet/security/analytics work, marketplace packaging, implementing protocol changes, removing dual support, merging to `main`, tagging.

---

## 0. Executive verdict

**KEEP dual. Do not remove 2025-11-25 `initialize` compatibility in this phase.**

| Question | Answer |
|----------|--------|
| Alignment with official 2026-07-28 | **High for a dual-era local stdio server.** Modern path is implemented via TypeScript SDK v2 (`server/discover`, per-request `_meta`, no app `Mcp-Session-Id`). Legacy `initialize` is still present and tested. |
| Remove legacy now? | **No.** Spec still defines dual-era as valid. All four operator-priority hosts still depend on initialize-era (or only advertise 2026-07-28 as *opt-in*). |
| Timed deprecation notice? | Optional later, **not now**. Earliest honest calendar review is **2027-07-28** *and* host confirmation (see §5). |
| Modern-only OK for Grok / Cursor / Claude / OpenAI today? | **No.** That would fail the spec’s Legacy-client × Modern-only-server cell. |

**Go / no-go on deprecating the old model:** **NO-GO.** Keep `PROTOCOL_MODE = dual:2026-07-28+2025-11-25`.

---

## 1. What was reviewed

Tree at `95e9a337` (also tag `v1.0.4`). Latest public release is **1.0.4**, not 1.0.3. Protocol posture is unchanged since 1.0.0 (dual-era + SDK 2.0.0).

**Primary anchors**

| Area | Path |
|------|------|
| Mode constant | `src/constants.ts` (`PROTOCOL_MODE`, `SERVER_VERSION`) |
| Stdio + HTTP entry | `src/index.ts` (`serveStdio` `legacy: "serve"`; `createMcpHandler` `legacy: "stateless"`) |
| Server factory | `src/server.ts` |
| Per-request `_meta` | `src/utils/requestMeta.ts` |
| Tool callback lift | `src/tools/define.ts` |
| Wallet confirm / MRTR | `src/utils/confirm.ts` |
| Host wiring helpers | `src/clientCompat.ts` |
| Bootstrap tests | `tests/protocol-bootstrap.test.ts` |
| MRTR tests | `tests/protocol-mrtr.test.ts` |
| Product docs | `MIGRATION_NOTES.md`, `CHANGELOG.md`, `README.md`, `docs/AGENT_GUIDANCE.md`, `examples/*` |
| Pins | `package.json`, lock asserted in bootstrap test |

**Official spec / SDK sources (2026-08-14)**

- https://modelcontextprotocol.io/specification/2026-07-28
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/community/feature-lifecycle
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- TypeScript SDK v2.0.0 release notes (`@modelcontextprotocol/server@2.0.0`, 2026-07-27)

**Client sources**

- Grok: `https://docs.x.ai/build/features/mcp-servers` (last updated 2026-07-02); local Grok Build user guide `~/.grok/docs/user-guide/07-mcp-servers.md`
- Cursor: `https://cursor.com/docs/context/mcp`; changelog through 2026-08-13
- Claude: `https://code.claude.com/docs/en/mcp`; Anthropic blog 2026-07-28 “Bringing MCP 2026-07-28 to Claude”
- OpenAI: Responses API MCP guide; Codex MCP docs (`learn.chatgpt.com/codex/extend/mcp`); Codex CLI 0.147.0 changelog 2026-08-07

---

## 2. Spec alignment (A)

### 2.1 What 2026-07-28 requires of a *modern* server

Official current revision is **2026-07-28** (stateless core). Relevant MUST / SHOULD items for this product:

| Item | Spec duty | pulsechain-mcp today | Evidence |
|------|-----------|----------------------|----------|
| `server/discover` | Servers **MUST** implement | **Yes**, via SDK (no custom handler) | `src/server.ts` comment; `src/index.ts` `serveStdio` / `createMcpHandler`; `tests/protocol-bootstrap.test.ts` “answers server/discover…” |
| Per-request `_meta` | Every modern request carries `io.modelcontextprotocol/protocolVersion` + `clientCapabilities`; `clientInfo` is **SHOULD** | **Yes** (SDK envelope; app reads via helper) | `src/utils/requestMeta.ts`; `src/tools/define.ts` lifts `ctx.mcpReq.envelope` |
| Server identity on results | Servers **SHOULD** stamp `_meta['io.modelcontextprotocol/serverInfo']` | **Yes**, SDK stamps from `{ name, version }` | `src/server.ts`; bootstrap test expects `SERVER_INFO_META_KEY` |
| No `Mcp-Session-Id` for correctness | Modern path has no protocol session | **Yes** at app layer. Fresh `McpServer` per stdio pin / per HTTP request | `src/index.ts`, `src/server.ts`, bootstrap “no sticky session” test |
| Legacy `initialize` | Dual-era servers **MAY** still answer `initialize` | **Yes**, explicit | `serveStdio({ legacy: "serve" })`; HTTP `legacy: "stateless"`; bootstrap “serves legacy initialize (2025-11-25…)” |
| `PROTOCOL_MODE` / negotiation | Dual-era: modern `_meta` → 2026; `initialize` → 2025 | **Yes** | `PROTOCOL_MODE = "dual:2026-07-28+2025-11-25"`; comments in `src/index.ts` |
| `UnsupportedProtocolVersionError` (`-32022`) | Modern server **MUST** reject unknown versions with this shape | **Delegated to SDK; not asserted in-repo** | No app test for `-32022` / `supported` / `requested` |
| `resultType` on results | All results require `resultType` (`complete` / `input_required`) | **MRTR path yes**; discover/list not asserted | `tests/protocol-mrtr.test.ts` expects `input_required`; discover/list tests omit `resultType` |
| `ttlMs` + `cacheScope` | Required on `tools/list`, `resources/list`, `resources/read`, etc. | **Delegated to SDK; not asserted** | No `ttlMs` / `cacheScope` matches in app tests or source |
| Streamable HTTP headers | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` | **SDK-owned** on `/mcp` | `src/index.ts` comments; bootstrap test sets those headers |
| HTTP+SSE (`/sse`, `/messages`) | Deprecated; migrate to Streamable HTTP | **Removed** (good) | `MIGRATION_NOTES.md` “SSE removed”; `src/types.ts` “not legacy SSE” |
| MRTR | Optional pattern replacing server-initiated elicitation | **Implemented** for wallet confirm | `src/utils/confirm.ts`; `src/server.ts` `requestState.verify` |
| OAuth / CIMD / RFC 9207 | Auth hardening for *remote* servers | **N/A** for shipped stdio local path | HTTP bind is `127.0.0.1` local-test only |
| Tasks / Apps extensions | Opt-in extensions | **Not claimed, not implemented** | — |
| Roots / Sampling / Logging | Deprecated in 2026-07-28; 12-month window | **Not adopted as product features** | Confirm uses MRTR, not Sampling |

### 2.2 Dual-era behavior (file/function anchors)

```text
src/constants.ts
  PROTOCOL_MODE = "dual:2026-07-28+2025-11-25"
  modern: server/discover + per-request _meta
  legacy: initialize (serveStdio + createMcpHandler legacy)

src/index.ts
  startStdio()  → serveStdio(() => createServer(config), { legacy: "serve" })
  startHttp()   → createMcpHandler(..., { legacy: "stateless" })
                  + toNodeHandler; GET /health includes protocolMode
  HTTP_TRANSPORT_PORT set  → HTTP-only (stdio not also bound)

src/server.ts
  createServer(config) → new McpServer({ name, version }, { instructions, requestState.verify })
  factory: one fresh instance per stdio pin / per HTTP request
  discover answered by SDK from registered tools + resources

src/utils/requestMeta.ts
  readClientRequestMeta(ctx) reads PROTOCOL_VERSION / CLIENT_INFO / CLIENT_CAPABILITIES keys
  missing envelope → {} (safe on legacy)

src/tools/define.ts
  registerTool wraps SDK registerTool; lifts _meta; passes InputRequiredResult through

src/utils/confirm.ts
  confirm=true → proceed (legacy/scripts)
  else if MRTR-capable → InputRequiredResult (resultType input_required)
  else PolicyError (fail closed)
```

Negotiation is **not** an app-owned state machine. The SDK selects era from the opening exchange. App code must not (and does not) key wallet or RPC identity on `Mcp-Session-Id`.

### 2.3 SDK pins vs Tier-1 guidance

| Package | Pin | Matches current Tier-1? |
|---------|-----|-------------------------|
| `@modelcontextprotocol/server` | **exact `2.0.0`** | Yes. Official v2 stable line for 2026-07-28, published 2026-07-27 with the final wire (`serverInfo` in `_meta`, `clientInfo` SHOULD). |
| `@modelcontextprotocol/node` | **exact `2.0.0`** | Yes (Node adapter for `createMcpHandler`). |
| `@modelcontextprotocol/core` | lock **2.0.0** | Yes (asserted in bootstrap test). |
| `@modelcontextprotocol/codemod` | exact `2.0.0` (dev) | Yes. |
| `@modelcontextprotocol/sdk` (v1) | **not used** | Correct. v1 line is still `1.30.0` (2025-era). |

`tests/protocol-bootstrap.test.ts` fails the build if those pins drift to beta/caret or if lockfile versions change.

Official 2026-07-28 blog: TypeScript is a Tier-1 SDK and “speaks 2026-07-28 as of today.” Dual-era serving (`legacy: "serve"` / `"stateless"`) is the documented v2 server story, not a fork.

### 2.4 Alignment score

**~85% of MUST items that apply to this host profile** (local dual-era stdio + optional loopback Streamable HTTP). Remaining gaps are SDK-delegated fields that the app does not regression-test, plus optional remote-auth / extension surfaces this product does not claim.

Not a ship-blocker for Grok / Cursor / Claude Desktop / Codex **stdio**.

---

## 3. Deprecate legacy 2025-11-25? (B)

### 3.1 What the spec actually says

Official versioning page defines three implementation classes:

- **Modern:** 2026-07-28+ per-request `_meta`
- **Legacy:** 2025-11-25 and earlier `initialize`
- **Dual-era:** supports both; **MAY** serve both on the same process/endpoint

Compatibility matrix (normative):

| Client | Server | Outcome |
|--------|--------|---------|
| Legacy | Dual-era | **Works** (`initialize`) |
| Dual-era | Dual-era / Modern / Legacy | Works (probe + fallback) |
| Legacy | **Modern-only** | **Fails.** Legacy has **no fall-forward**. |

The 12-month deprecation floor ([SEP-2596](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2596)) applies to **features** (Roots, Sampling, Logging, HTTP+SSE, DCR), **not** to the 2025-11-25 protocol revision itself. 2025-11-25 remains a named, valid revision. Dual-era is the official interoperability path, not a temporary hack.

Python / TypeScript v2 docs: serving 2026-07-28 “does not strand a client on the old one.”

### 3.2 Host risk (operator-priority only)

Removing `legacy: "serve"` / `"stateless"` would make this a **modern-only** server. Per the matrix, every remaining initialize-era Desktop/stdio client **hard-fails**.

As of 2026-08-14, that set still includes the operator’s four targets (details in §4).

### 3.3 Maintenance cost of dual

Low in *this* repo:

- Era selection is SDK (`legacy: "serve"` / `"stateless"`).
- App has one factory (`createServer`) and one `_meta` helper.
- Confirm is already dual (`confirm=true` **or** MRTR).
- Tests cover both openings plus MRTR integrity.

The dual tax is a few flags and tests, not two product stacks.

### 3.4 Recommendation

**Keep dual.** Do not flip `legacy: "reject"`. Do not delete the initialize path.

A *timed deprecation announcement* is only honest after **all four** hosts document 2026-07-28 as **default** (not opt-in) **and** an operator has verified live `server/discover` without `initialize`. That has not happened.

---

## 4. Client matrix (C) — Grok, Cursor, Claude, OpenAI

Production path for this product is **stdio**. Streamable HTTP is **127.0.0.1 local-test only** (`HTTP_TRANSPORT_PORT`). Setting that env **disables stdio** in the same process.

### 4.1 Grok Build / Grok CLI

| | |
|--|--|
| **Transport this product uses** | **stdio** (`examples/grok_mcp_config.toml`, `install-for-host --host grok`) |
| **Also documented by Grok** | HTTP and **SSE**; Streamable HTTP example still shows `headers = { "x-mcp-session-id" = "{{session_id}}" }` |
| **Era evidence** | xAI MCP docs last updated **2026-07-02** (before 2026-07-28 GA). User guide troubleshooting: “fails to **handshake**.” No public claim of `server/discover` / 2026-07-28-only. |
| **Implication** | Treat as **initialize-era / dual-client unknown**. **Must keep legacy.** Modern-only would break current Grok stdio until xAI publishes a modern default. |

Sources: https://docs.x.ai/build/features/mcp-servers ; Grok Build user guide §07.

### 4.2 Cursor

| | |
|--|--|
| **Transport this product uses** | **stdio** (`examples/cursor_mcp_config.json`) |
| **Also documented by Cursor** | SSE **and** Streamable HTTP (OAuth) |
| **Era evidence** | Current MCP docs still list **Roots** and **server-initiated Elicitation** (2025-era / deprecated features). FAQ still talks about “server **initialization**.” Changelog **2026-07-22 → 2026-08-13** has **no** 2026-07-28 / `server/discover` note. |
| **Implication** | **Must keep legacy.** Cursor is the highest-volume Desktop/stdio risk if initialize is removed. |

Sources: https://cursor.com/docs/context/mcp ; https://cursor.com/changelog

### 4.3 Claude (Desktop / Code / connectors)

| Surface | Transport | Era evidence | Implication |
|---------|-----------|--------------|-------------|
| **Claude Desktop** | **stdio** (this product’s sample) | Repo `MIGRATION_NOTES.md` still: “Current Desktop/Cursor → **2025-11-25 via initialize**.” No Desktop release note found that flips default to 2026-07-28. | **Keep legacy.** |
| **Claude Code** | stdio, HTTP, SSE (SSE marked deprecated), WebSocket | Docs still describe `roots/list`, `notifications/roots/list_changed`, **elicitation dialogs**, `list_changed` notifications. No published protocol-version pin. | **Keep legacy.** |
| **claude.ai connectors / Directory** | remote HTTP | Anthropic 2026-07-28 blog: support is “**being rolled out**” / “**rolling out … soon**.” Not a completed client cutover. | Remote HTTP is **not** this product’s production path. Dual still required for Desktop/Code. |

Source: https://claude.com/blog/bringing-mcp-2026-07-28-to-claude ; https://code.claude.com/docs/en/mcp

### 4.4 OpenAI (Codex / ChatGPT connectors / API MCP)

| Surface | Transport | Era evidence | Implication |
|---------|-----------|--------------|-------------|
| **Codex CLI / IDE / ChatGPT desktop Codex** | **stdio** (this product) + Streamable HTTP | Official Codex MCP page still: reads `instructions` “returned during **initialization**.” CLI **0.147.0 (2026-08-07)** adds “**opt-in** MCP 2026-07-28” (`server/discover`, multi-round) and still “handle **legacy** MCP discovery.” | Dual is exactly what Codex is designed to talk to. **Do not drop initialize.** Opt-in modern ≠ default-only. |
| **ChatGPT custom connectors / Developer Mode** | **Remote** Streamable HTTP or SSE. **No local stdio.** | Responses API MCP guide (fetched 2026-08-14) does not mention 2026-07-28 or `server/discover`. Older community traces (`openai-mcp/1.0.0`) used `initialize`. | This product **cannot** serve ChatGPT web connectors as shipped (HTTP is loopback-only, no public TLS/OAuth). Separate product decision if remote hosting is ever wanted. |
| **Responses API `tools: [{type:"mcp"}]`** | Remote HTTP/SSE | Same as above. Error docs still cite 2025-03-26 tool errors. | Out of band for current install path. |

Sources: https://learn.chatgpt.com/codex/extend/mcp ; https://learn.chatgpt.com/docs/changelog (2026-08-07); https://developers.openai.com/api/docs/guides/tools-connectors-mcp

### 4.5 Matrix (practical)

| Host | Transport we ship | 2026-07-28 as **default**? | Still needs `initialize`? | Modern-only OK? |
|------|-------------------|----------------------------|---------------------------|-----------------|
| Grok Build | stdio | **Unknown / unlikely** (docs still handshake + session header example) | **Yes** | **No** |
| Cursor | stdio | **No public evidence** | **Yes** | **No** |
| Claude Desktop / Code | stdio | **Rolling out, not done** | **Yes** | **No** |
| OpenAI Codex | stdio | **Opt-in only** (0.147.0) | **Yes** (default init language + legacy handling) | **No** |
| ChatGPT connectors / API MCP | remote HTTP (we do not ship this) | Unstated | N/A for current package | N/A until a public HTTP product exists |

**Unknowns (marked honestly):** we did not run live packet captures against each host binary. Conclusions are from current public docs + this repo’s own install samples. A future verification PR should record `server/discover` vs `initialize` on a real Grok / Cursor / Claude / Codex session.

---

## 5. Do **not** remove legacy until X

Do **not** remove 2025-11-25 / `initialize` until **all** of the following are true:

1. **Host default, not opt-in.** Public docs for **Grok Build**, **Cursor**, **Claude Desktop and Claude Code**, and **OpenAI Codex** state that stdio uses 2026-07-28 (`server/discover` + per-request `_meta`) **by default**, without an initialize fallback for the current stable release.
2. **Operator proof.** A recorded session on each of those four hosts against pulsechain-mcp shows the opening RPC is `server/discover` (or a modern method with `_meta`), not `initialize`. Prefer `grok mcp doctor` / host MCP logs, not guesswork.
3. **Spec still allows dual until then.** There is no SEP that *removes* 2025-11-25. The 12-month clock on Roots/SSE/etc. is a different clock.
4. **Calendar floor.** Do not schedule *removal* before **2027-07-28** (12 months after 2026-07-28 GA) **and** items 1–2. A *docs-only deprecation warning* can be considered earlier; **removal cannot**.
5. **Codex opt-in is not enough.** “Support the opt-in MCP 2026-07-28 protocol” (Codex 0.147.0) is evidence to **keep** dual, not drop it.

Until X: keep `legacy: "serve"` (stdio) and `legacy: "stateless"` (HTTP). Default bias confirmed by evidence.

---

## 6. Gaps vs 2026-07-28 (D)

### 6.1 Ship-blockers for current hosts (Grok / Cursor / Claude stdio / Codex stdio)

**None identified** for the dual-era stdio path these hosts actually use.

Removing legacy *would become* the ship-blocker.

### 6.2 Missing or unverified MUST items on the modern path (nice-to-have / future PR)

| Gap | Severity | Notes |
|-----|----------|-------|
| No in-repo assertion that `server/discover` includes `resultType: "complete"` | Nice | SDK should emit it; app tests never check. |
| No assertion of `ttlMs` / `cacheScope` on discover, `tools/list`, `resources/list`, `resources/read` | Nice | SEP-2549 MUST on those results. Stdio hosts today do not need HTTP cache intermediaries. |
| No `UnsupportedProtocolVersionError` (`-32022`) test | Nice | Required modern behavior; entirely SDK. Worth one negative test (bogus `MCP-Protocol-Version`). |
| Discover test only `arrayContaining(["2026-07-28"])` | Nice | Does not assert whether `2025-11-25` is listed in `supportedVersions`. Dual is proven via a separate `initialize` test, which is the correct legacy opening. |
| `MIGRATION_NOTES.md` says `resultType: "inputRequired"` | Docs typo | Wire + tests use `"input_required"` (spec). Not a runtime bug. |
| `clientSupportsMrtr()` is optimistic | Residual | Any live `mcpCtx` is treated as MRTR-capable. Legacy hosts still have `confirm=true`. Host UX only (already documented). |
| HTTP is loopback-only | Product limit | Not a 2026-07-28 MUST miss. Blocks ChatGPT *web* connectors until a real remote transport + auth story exists. |
| `subscriptions/listen` | N/A | App does not implement `resources/subscribe`. No claim. |
| Remote OAuth / CIMD / RFC 9207 | N/A | Not a stdio local-server requirement. |
| Tasks / MCP Apps | N/A | Not claimed. |

### 6.3 Docs that are slightly stale (not protocol bugs)

- `MIGRATION_NOTES.md`: “Future modern hosts → 2026-07-28” — Codex now has **opt-in** modern; others still initialize-first in public docs.
- Tool count in `MIGRATION_NOTES.md` still says 69 tools; bootstrap test expects **96** (analytics growth). Protocol-irrelevant.

---

## 7. Optional follow-ups (same branch, later implementation PR — still not merge-to-main)

Docs/tests only unless a later decision changes product protocol:

1. Add protocol tests: unknown version → `-32022` + `data.supported` / `data.requested`; discover/list `resultType`, `ttlMs`, `cacheScope`.
2. Fix `MIGRATION_NOTES.md` `inputRequired` → `input_required`; refresh tool-count sentence.
3. After host vendors publish default 2026-07-28: record live traces (Grok/Cursor/Claude/Codex) in a follow-up note.
4. Only then consider a **docs deprecation banner** (not `legacy: "reject"`).
5. If ChatGPT web connectors become a goal: separate design for public Streamable HTTP + auth. Out of scope here.

Do **not** implement `legacy: "reject"` on this branch as part of this review.

---

## 8. Isolation / safety confirmation

| Check | Status |
|-------|--------|
| Review branch created from `origin/main` | `dev/mcp-protocol-review` @ `95e9a337` |
| `main` default branch | **Unchanged** (`refs/heads/main`) |
| Tags `v1.0.0`–`v1.0.4` | **Unchanged** (peeled SHAs match pre-review) |
| Product / server / wallet / RPC / tools code | **Not modified** |
| This file | Docs-only on the review branch |
| Merge to `main` | **Not done** |
| Force-push / history rewrite | **Not done** |
| Secrets / funding / execute / broadcast | **None** |

---

## 9. Bottom line

pulsechain-mcp **1.0.4** is already a **correct dual-era 2026-07-28 + 2025-11-25 server** on the official TypeScript SDK **2.0.0**. Alignment with the modern MUST set is strong where the SDK owns the wire; leftover gaps are untested SDK fields, not missing product protocol.

**Grok, Cursor, Claude, and OpenAI Codex still need the old model today.** Codex is the only one of the four with *published* 2026-07-28 support, and it is **opt-in** next to initialize.

**Do not deprecate or remove 2025-11-25 now.** Revisit after host defaults flip **and** not before 2027-07-28.
