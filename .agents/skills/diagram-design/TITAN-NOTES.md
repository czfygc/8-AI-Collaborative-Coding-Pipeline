# TITAN notes for the vendored diagram-design skill

## Source

- Upstream: https://github.com/cathrynlavery/diagram-design
- Commit: `f2f4d49ea8d632f17cf196ba26599277a93f767b` (2026-10-21 clone)
- License: MIT (see `LICENSE`, copyright Cathryn Lavery)
- Upstream version: 2.6

Files are copied unmodified from `skills/diagram-design/` at that commit, except this note.

**Exception (T-155, 2026-10-21)**: the `SKILL.md` frontmatter gained four TITAN quality
fields (`version: 2.6.0`, `requires`, `tests`, `provenance`) so the skill passes
`node orchestrator/skill-quality.mjs`. The upstream `metadata.version: "2.6"` and the
whole body are untouched; only the frontmatter block was appended to.

## What is vendored, and why

| Path | Contents | Reason |
|---|---|---|
| `SKILL.md` | full skill instructions | single source of truth |
| `references/*.md` | all 63 references (types, primitives, style, imports) | keeps every link in SKILL.md resolvable |
| `assets/template*.html` | minimal light/dark, full editorial | starting scaffolds |
| `scripts/self_check.py` | accessible-SVG / single-file / offline validator | acceptance check, stdlib only |

Not vendored: the 217 example diagrams (`assets/example-*.html`, ~4.5 MB), the
import extractors, and the PNG/SVG exporters. Examples can be browsed upstream at
the commit above. Exporters need Playwright and are out of scope for TITAN docs.

## Usage rules in TITAN

1. **Offline output is the default.** TITAN diagrams must not make network
   requests: omit the Google Fonts `<link>`, use the `system` font source, and
   validate with `python scripts/self_check.py --offline <file>`.
2. **Self-contained single HTML file.** No external CSS/JS/images, inline SVG
   only. Same rule as TITAN docs and evidence.
3. **Scope guard.** The skill may draw any diagram, but TITAN adoption is limited
   to documentation gains (architecture, call chain, dependency, recovery flow).
   It is a rendering aid, not a new runtime dependency.
4. **No silent branding.** If the style guide is still upstream default and the
   user has not chosen otherwise, ask before shipping a branded diagram. For the
   T-147 diagrams the user accepted the upstream default palette.
5. **TITAN rules win.** `AGENTS.md` > `ISSUE_REGISTRY.json` > this skill.

## Refresh procedure

Re-clone upstream at a newer commit, review `git diff` for SKILL.md and the
vendored references, re-copy, update the commit hash above, then run the
frontmatter test and `verify-gate`. Do not edit vendored files in place; keep
local deviations in this note or in the generated diagram folder.
