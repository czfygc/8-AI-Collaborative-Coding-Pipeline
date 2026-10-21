# Multi-AI Collaboration Pipeline — Ship Your Project Without Writing Code

> **[English](README.md) | [简体中文](README.zh-CN.md)**

## What problem does this solve?

You have a project idea but you don't write code — or you don't want to spend months doing it.

Multi-AI Collaboration Pipeline is a multi-AI consultation and implementation pipeline that takes you from **project design to working code**: independent web-AI seats design and decompose the project, local coding agents implement it, and a full-quorum review gate signs off before anything merges. Non-coders drive the whole thing through natural-language human–computer interaction — describe the goal, and the pipeline does the rest.

Alpha, not production-grade — but the whole loop is real, runnable, and auditable.

## How it works — multi-seat, 3 stages

> Seats are composed per cycle: web-AI seats design and review, local coding clients implement, and an extra web-AI hot spare absorbs UI churn so the review quorum never shrinks (it does not take part in every review). The exact seat count is a deployment choice, not a fixed promise.

```
 Stage 1 · Design & decomposition        Stage 2 · Implementation        Stage 3 · Review gate
┌─────────────────────────────┐    ┌──────────────────────────────┐    ┌──────────────────────────┐
│  web-AI seats (multi)        │    │  local coding clients        │    │  full-quorum review       │
│  ├ review seats:             │───▶│  deepseek Harness            │───▶│  web reviewers          │
│  │  propose solution,       │    │  OpenCode                    │    │  + local reviewers      │
│  │  decompose the project   │    │  Cline                       │    │  = full pass required    │
│  └ hot-spare seat            │    │  Kilo Code                   │    │  before merge            │
│    (absorbs web-AI churn)   │    │  write the actual code       │    │                          │
└─────────────────────────────┘    └──────────────────────────────┘    └──────────────────────────┘
```

1. **Web seats design.** Independent web-AI seats produce the solution and break the project into verifiable work items. A **dedicated hot spare** — web AI is volatile (UI redesigns, CAPTCHAs, session drops), and the spare absorbs that churn so the review quorum never shrinks.
2. **Local seats implement.** Local coding clients (Harness, OpenCode, Cline, Kilo Code) run in this workspace, pick up the decomposed work items, and write the actual code under `orchestrator/` discipline (claim → implement → verify → commit).
3. **Full-quorum review gate.** Web reviewers and local reviewers independently re-check the result. Only a full pass merges; evidence is persisted for regression checks.

## Core characteristics

- **Layer A + Layer B consultation architecture**: automatically identifies consensus, complementarity, and fact conflicts among AI seats, producing auditable adjudication records (`delta.md`).
- **M1–M7 iron discipline**: self-contained multi-client collaboration contracts with a 50 KiB source-file freeze line, backslash-safe write-disk channel, and a shared task registry with a strict state machine.
- **Verify-Gate validation**: syntax / import / CLI / test / self-check / size / dynamic-import checks; `main` is always runnable.
- **Delivery gates (new)**: four artifact-level gates — `artifact-manifest` (file + size + SHA256), `license-notice-check` (third-party attribution), `anon-download-verify` (anonymous downloadability), `stage-gate` (**code / artifact / release are three independent verdicts — passing one never implies the next**).
- **Task-card discipline (new)**: every task carries scope / acceptance / out-of-scope / required-evidence; evidence is graded `firsthand` / `local_report` / `unverified`, and "the author never verifies their own change".
- **Model routing by task tier (new)**: task tiers (`mechanical` / `bounded_code` / `architecture` / `review` / `long_run`) map onto model tiers (`light` / `medium` / `heavy`); a shared probe + TTL health view tells you which model is actually alive right now, so weak-but-free models take the machine-checkable work and the scarce quota goes to the strong tier.
- **External tool integration**: can interface with freellmapi / OpenClaw / sing-box and other external open-source tools (see "External Dependencies"); this repository does not ship their source or configuration.

## Delivery gates, task cards and model routing (runnable today)

```powershell
# Task-card discipline check (scope / acceptance / out-of-scope / evidence grading)
node orchestrator/task-card.mjs <T-xx>

# Artifact gates: manifest, third-party attribution, anonymous download, stage verdict
node orchestrator/artifact-gate.mjs manifest       --root <artifact-dir> --out manifest.json
node orchestrator/artifact-gate.mjs verify-manifest --root <artifact-dir> --manifest manifest.json
node orchestrator/artifact-gate.mjs license         --root <artifact-dir>
node orchestrator/artifact-gate.mjs anon-download   --page <url> --download <url> --sha256 <hex> --bytes <n>
node orchestrator/artifact-gate.mjs stage-gate      --root <artifact-dir> --manifest manifest.json --code PASS

# Model health + routing recommendation (shared probe, TTL cache)
node orchestrator/model-health.mjs --task mechanical --kind summarize
node orchestrator/model-health.mjs --all --no-probe --json      # offline view, burns no quota

# Long-running child processes: keep them alive across sessions (Windows scheduled task)
node orchestrator/supervisor.mjs add <jobId> -- <cmd> [args...]
node orchestrator/supervisor.mjs install            # run as a scheduled task
node orchestrator/supervisor.mjs status
```

Exit codes are uniform: `0 = PASS`, `1 = FAIL`, `3 = UNKNOWN` (**explicit unknown is not a pass**), `2 = usage error`.

## Repository structure (this release)

| Path | Purpose |
|---|---|
| `orchestrator/` | Pipeline core: orchestration, CDP browser driving, review flow, plus `verify-gate.mjs` (syntax/import/CLI/test/self-check/size/dynamic import) |
| `orchestrator/lib/` | Responsibility modules (`scan-entry.mjs`, `analyze-core.mjs`, `architect.mjs`, `reviewers.mjs`, `task-card.mjs`, `stage-gate.mjs`, `model-health.mjs`, `supervisor.mjs`, …) |
| `orchestrator/test/` | 46 gate test files (`node --test orchestrator/test/`) |
| `titan-memory/` | Cross-client shared memory MCP server (zero-dependency) |
| `.agents/` | Review protocol skills (four-party consult, review channels, parallel delegation, TDD, diagnosis, …) |
| `AGENTS.md` | Public collaboration contract (auto-loaded, self-contained, machine-path free) |
| `NOTICE` | Third-party attribution for the runtime dependencies listed below |

**Not included in this repository** (local configs and deployment artifacts — part of the runtime environment, not the release):

- `freellmapi-src/` — FreeLLMAPI local gateway (<https://github.com/neclomin/freellmapi>)
- the internal task ledger, instance memory and release-sync ledger — they are private working assets and never ship (see `AGENTS.md` §13)

## Download

- **Source**: clone this repository, or download the release archive from
  <https://github.com/czfygc/multi-ai-collaboration-pipeline/releases> (a `.zip` of the published tree is attached to each release).
- **Verify what you downloaded**: `node orchestrator/artifact-gate.mjs anon-download --page <release-url> --download <asset-url> --sha256 <hex> --bytes <n>`.


## Environment setup

```powershell
# 0. Prerequisites: Node.js (>=18) and npm

# 1. Install pipeline dependencies (playwright-core, @playwright/mcp, js-yaml)
npm install
```

Only `npm install` is required for the checks below. A CDP browser is **only** needed when you run the web-AI review flow (the web seats in Stage 1 / Stage 3):

```powershell
# 2. Optional — only for the web-AI review flow
#    Launch Chrome/Edge with remote debugging on port 9222:
#    chrome.exe --remote-debugging-port=9222 --user-data-dir="<local-dir>"
#    The user-data-dir (chrome-cdp-profile) is local runtime data and is NOT in this repo.
```

## Quick Start

> **Not a programmer? Start here: [Usage Guide (English)](USAGE_GUIDE.md) / [使用说明（中文）](USAGE_GUIDE.zh-CN.md)** — a step-by-step walkthrough from install to your first shipped project, without writing code.

```powershell
# 1. Syntax check (all .mjs files)
node --check orchestrator/orchestrate.mjs

# 2. Full validation gate (syntax + import + CLI + test + self-check + size)
node orchestrator/verify-gate.mjs

# 3. Run gate tests
node --test orchestrator/test/
```

Expected: `verify-gate.mjs` exits with code `0`, `[GATE] RESULT: OK`. All base checks (syntax, import, CLI, test, self-check, size) run **without any browser** — the CDP browser is only needed for the web-AI review flow (`--review` / `--scan` web seats).

## Status (Alpha / not production-grade)

- Orchestrator split into `lib/` responsibility modules, single-file size below 50 KiB; `verify-gate` all green (syntax / import / CLI / test / self-check / size / dynamic import; 46 test files).
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

`orchestrator/` interacts with the integrated tools (FreeLLMAPI, sing-box) via standard HTTP/gRPC interfaces.

**Telegram entry (available in this release):** message your own Telegram bot with `!titan <your task>` and the pipeline answers in the same chat. The chain is `orchestrator/titan_telegram_bot.py` → local gateway `orchestrator/titan-gateway.mjs` (127.0.0.1:5301, allow-listed Telegram user IDs only) → `orchestrate.mjs --run` → web-AI seats → execution status returned to Telegram. Tokens live only in a local git-ignored `titan_secrets.env` (never in URLs or command lines), and the entry point only dispatches allow-listed tasks — it never hands out shell or repository-file access. Setup steps: `USAGE_GUIDE.md` section 8.

OpenClaw is an external open-source project for human-computer language interaction — **on the roadmap, not yet integrated** in this release. When integrated, it will widen this mobile entry point: OpenClaw is a personal AI assistant that runs on your own device and meets you in the channels you already use (Telegram, WhatsApp, Discord, iMessage, … 20+ channels plus native mobile apps), so you can drive the pipeline from your phone in a TG conversation. Concrete configs stay local.

## Contributing

See `CONTRIBUTING.md`. External contributors go through **fork + PR**; merges are controlled by maintainers through CI + review.

## Security

Vulnerability reporting channels see `SECURITY.md`. Secrets never go in URLs, command-line args, or conversations; use environment variables or a local (git-ignored) secrets file.

## License

Licensed under **Apache-2.0** (permissive, patent grant, enterprise-friendly). See `LICENSE`.
Third-party components used as runtime dependencies are attributed in `NOTICE`
(`@playwright/mcp` MIT, `playwright-core` Apache-2.0, `js-yaml` MIT) — none of them are vendored into this repository.

---

*Maintainer: TITAN_ARCHAEOLOGY (pseudonym, does not expose personal identity). Contact via GitHub Issues on this repository.*