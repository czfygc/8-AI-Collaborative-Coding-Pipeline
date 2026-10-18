# 8-AI Collaborative Coding Pipeline — Security Policy

## Vulnerability Reporting

You can report security vulnerabilities through either of the following channels:

- GitHub Private Vulnerability Reporting (PVR): go to repository Settings -> Security -> Report a vulnerability (**must be tested externally before public launch**, see R-03)
- Email: titan@archaeology.local (internal pseudonym email; external reachability is verified via GitHub PVR testing, see R-03)

We will confirm receipt as soon as possible and prioritize by severity.

## Secret Handling (Pre-Open-Source Red Lines)

- **Secrets must never go in URLs, command-line arguments, or conversations** — use `titan_secrets.env` (already `gitignore`d) or environment variables.
- This tree has completed the secret audit: **no real API keys or secret values are tracked**. If you later add proxy/node credentials, replace every real UUID/secret with a `<YOUR_UUID>` placeholder before open-sourcing; real values stay only in `gitignored` local configs.

## Disclaimer

This project is Alpha / not production-grade and is provided "as is" without any express or implied warranty. See `LICENSE` sections 7-8.
