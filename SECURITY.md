# TITAN Archaeology — Security Policy

## Vulnerability Reporting

You can report security vulnerabilities through either of the following channels:

- **GitHub Private Vulnerability Reporting (PVR)** (preferred): go to the repository **Security** tab -> **Report a vulnerability**. The advisory is delivered privately to maintainers.
- **GitHub Issues**: open an issue with a `[security]` prefix for non-sensitive reports only. Never post exploit details in a public issue.

Maintainers are notified through the project's GitHub account for both channels; no email contact is published on purpose.

We will confirm receipt as soon as possible and prioritize by severity.

## Secret Handling (Pre-Open-Source Red Lines)

- **Secrets must never go in URLs, command-line arguments, or conversations** — use `titan_secrets.env` (already `gitignore`d) or environment variables.
- Current tree and git history have completed secret audits: **zero real API keys/secret values**. However, there are **3 VLESS UUIDs pending rotation** and tracked credentials in `bin/`/`cfnext/` (see `reports/OPEN_SOURCE_SECRET_AUDIT.md`). These are not "zero credentials" and must be rotated before open-sourcing (R-04 consistent).
- `cfnext/wrangler.toml` and several documents under `bin/` contain proxy node UUIDs. Before open-sourcing, rotate them and replace with `<YOUR_UUID>` placeholders (R-07: real UUIDs only in `gitignored` local configs; all tracked templates must use placeholders). Otherwise, publishing the repo immediately leaks node credentials.

## Disclaimer

This project is Alpha / not production-grade and is provided "as is" without any express or implied warranty. See `LICENSE` sections 7-8.
