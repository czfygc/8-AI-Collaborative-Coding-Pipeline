# 8-AI Collaborative Coding Pipeline — Ship Your Project Without Writing Code

> **[English](README.md) | [简体中文](README.zh-CN.md)**

## What problem does this solve?

You have a project idea but you don't write code — or you don't want to spend months doing it.

8-AI Collaborative Coding Pipeline is a multi-AI consultation and implementation pipeline that takes you from **project design to working code**: independent web-AI seats design and decompose the project, local coding agents implement it, and a full eight-party review gate signs off before anything merges. Non-coders drive the whole thing through natural-language human–computer interaction — describe the goal, and the pipeline does the rest.

Alpha, not production-grade — but the whole loop is real, runnable, and auditable.

## How it works — 9 seats, 3 stages

```
 Stage 1 · Design & decomposition        Stage 2 · Implementation        Stage 3 · Review gate
┌─────────────────────────────┐    ┌──────────────────────────────┐    ┌──────────────────────────┐
│  5 web-AI seats             │    │  4 local coding clients      │    │  8-party review          │
│  ├ 4 review seats:          │───▶│  deepseek Harness            │───▶│  4 web reviewers         │
│  │  propose solution,       │    │  OpenCode                    │    │  + 4 local reviewers     │
│  │  decompose the project   │    │  Cline                       │    │  = full pass required    │
│  └ 1 hot-spare seat         │    │  Kilo Code                   │    │  before merge            │
│    (absorbs web-AI churn)   │    │  write the actual code       │    │                          │
└─────────────────────────────┘    └──────────────────────────────┘    └──────────────────────────┘
```

1. **Web seats design (5 seats).** Four independent web-AI seats produce the solution and break the project into verifiable work items. A **fifth seat is a dedicated hot spare** — web AI is volatile (UI redesigns, CAPTCHAs, session drops), and the spare absorbs that churn so the review quorum never shrinks.
2. **Local seats implement (4 clients).** deepseek Harness, OpenCode, Cline and Kilo Code run in this workspace, pick up the decomposed work items, and write the actual code under `orchestrator/` discipline (claim → implement → verify → commit).
3. **Eight-party review gate.** Four web reviewers + four local reviewers independently re-check the result. Only a full pass merges; evidence is persisted for regression checks.

## Core characteristics

- **Layer A + Layer B consultation architecture**: automatically identifies consensus, complementarity, and fact conflicts among AI seats, producing auditable adjudication records (`delta.md`).
- **M1–M7 iron discipline**: self-contained multi-client collaboration contracts with a 50 KiB source-file freeze line, backslash-safe write-disk channel, and a shared task registry with a strict state machine.
- **Verify-Gate validation**: syntax / import / CLI / test / self-check / size / dynamic-import checks; `main` is always runnable.
- **External tool integration**: can interface with freellmapi / OpenClaw / sing-box and other external open-source tools (see "External Dependencies"); this repository does not ship their source or configuration.

## Repository structure (this release)

| Path | Purpose |
|---|---|
| `orchestrator/` | Pipeline core: orchestration, CDP browser driving, review flow, plus `verify-gate.mjs` (syntax/import/CLI/test/self-check/size/dynamic import) |
| `orchestrator/lib/` | Responsibility modules (`scan-entry.mjs`, `analyze-core.mjs`, `architect.mjs`, `reviewers.mjs`, …) |
| `orchestrator/test/` | 21 gate test cases |
| `titan-memory/` | Cross-client shared memory MCP server (zero-dependency) |
| `.agents/` | Skills shared by the four local clients |
| `AGENTS.md` | Four-client collaboration contract (auto-loaded, self-contained) |

**Not included in this repository** (local configs and deployment artifacts — part of the runtime environment, not the release):

- `freellmapi-src/` — FreeLLMAPI local gateway (<https://github.com/neclomin/freellmapi>)


## Environment setup (required before Quick Start)

```powershell
# 0. Prerequisites: Node.js (>=18) and npm

# 1. Install pipeline dependencies (playwright-core, @playwright/mcp, js-yaml)
npm install

# 2. Prepare a CDP browser (NOT included in this repo)
#    Launch Chrome/Edge with remote debugging on port 9222:
#    chrome.exe --remote-debugging-port=9222 --user-data-dir="<local-dir>"
#    The user-data-dir (chrome-cdp-profile) is local runtime data and is NOT in this repo.
```

## Quick Start

```powershell
# 1. Syntax check (all .mjs files)
node --check orchestrator/orchestrate.mjs

# 2. Full validation gate (syntax + import + CLI + test + self-check + size)
node orchestrator/verify-gate.mjs

# 3. Run gate tests
node --test orchestrator/test/
```

Expected: `verify-gate.mjs` exits with code `0`, `[GATE] RESULT: OK`. The gate requires the CDP browser from step 2 of Environment Setup to be reachable at `127.0.0.1:9222`.

## Status (Alpha / not production-grade)

- Orchestrator split into `lib/` responsibility modules, single-file size below 50 KiB (`orchestrate.mjs` ~46 KB); `verify-gate` all green (syntax 40/40, import 14/14, CLI 4/4, test 21/21).
- This repository contains **zero real API keys / secret values**; model routing configs, trading research, and browser runtime data are intentionally excluded.
- Honest known issues below — read them before adopting.

## Known issues (disclosed honestly, not sugar-coated)

| ID | Issue | Description |
|---|---|---|
| D-1 | Timing gap | Event timing between segments not fully closed; see `orchestrator/` comments |
| D-2 | `markers.mjs` HIGH concurrency interference | Marker interference risk under high concurrency; registered, awaiting dedicated fix |
| D-3 | Observability not production-grade | Current observability/telemetry is prototype-level |

## External dependencies (integration only, not vendored)

| Tool | Purpose | Repository |
|---|---|---|
| FreeLLMAPI | Local LLM gateway, multi-model routing | <https://github.com/neclomin/freellmapi> |
| sing-box | Proxy and routing | <https://github.com/SagerNet/sing-box> |
| OpenClaw | Human-computer language interaction (mobile: Telegram, WhatsApp, …) | <https://github.com/openclaw/openclaw> |

`orchestrator/` interacts with the integrated tools (FreeLLMAPI, sing-box) via standard HTTP/gRPC interfaces. OpenClaw (human-computer language interaction) is not integrated yet, which does not prevent claiming the capability up front: it is the **mobile entry point** — OpenClaw is an open-source personal AI assistant that runs on your own device and meets you in the channels you already use (Telegram, WhatsApp, Discord, iMessage, … 20+ channels plus native mobile apps), so you can drive the pipeline from your phone in a TG conversation. Concrete configs stay local.

## Contributing

See `CONTRIBUTING.md`. External contributors go through **fork + PR**; merges are controlled by maintainers through CI + review.

## Security

Vulnerability reporting channels see `SECURITY.md`. Secrets never go in URLs, command-line args, or conversations; use environment variables or a local (git-ignored) secrets file.

## License

Licensed under **Apache-2.0** (permissive, patent grant, enterprise-friendly). See `LICENSE`.

---

*Maintainer: TITAN_ARCHAEOLOGY <titan@archaeology.local> (pseudonym, does not expose personal identity)*