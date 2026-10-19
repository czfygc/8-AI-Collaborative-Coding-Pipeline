# 8-AI Collaborative Coding Pipeline — Security Policy

## Vulnerability Reporting

You can report security vulnerabilities through either of the following channels:

- **GitHub Private Vulnerability Reporting (PVR)** (preferred): go to the repository **Security** tab -> **Report a vulnerability**. The advisory is delivered privately to maintainers.
- **GitHub Issues**: open an issue with a `[security]` prefix for non-sensitive reports only. Never post exploit details in a public issue.

Maintainers are notified through the project's GitHub account for both channels; no email contact is published on purpose.

We will confirm receipt as soon as possible and prioritize by severity.

## Secret Handling (Pre-Open-Source Red Lines)

- **Secrets must never go in URLs, command-line arguments, or conversations** — use `titan_secrets.env` (already `gitignore`d) or environment variables.
- This tree has completed the secret audit: **no real API keys or secret values are tracked**. If you later add proxy/node credentials, replace every real UUID/secret with a `<YOUR_UUID>` placeholder before open-sourcing; real values stay only in `gitignored` local configs.

## Disclaimer

This project is Alpha / not production-grade and is provided "as is" without any express or implied warranty. See `LICENSE` sections 7-8.
