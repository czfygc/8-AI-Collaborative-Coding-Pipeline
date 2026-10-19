# TITAN Claw Connector

LangBot/LangTARS plugin that connects Telegram (and other IM platforms) messages
to the TITAN multi-AI pipeline orchestrator via an HTTP gateway.

## What it does

Receives `!titan <task description>` commands from Telegram (via LangBot/LangTARS),
forwards them to the TITAN orchestrator HTTP gateway, and returns the pipeline
execution result (dispatch ID, Layer A/B summary, architect decision) back to the
same chat.

## Security model

- Only users listed in `TITAN_ALLOWED_USER_IDS` may submit tasks.
- Tasks are limited to a prompt string sent to the TITAN gateway.
- No shell execution, no arbitrary file access, no PowerShell bypass.
- The TITAN gateway itself only accepts artifact paths under `TITAN_ROOT`.

## Prerequisites

1. TITAN Archaeology workspace checked out at `D:\TITAN_ARCHAEOLOGY` (or set
   `TITAN_ROOT` env var).
2. TITAN gateway running:

   ```powershell
   # In one terminal, inside D:\TITAN_ARCHAEOLOGY
   set TITAN_ALLOWED_USER_IDS=<your_telegram_user_id>
   node orchestrator/titan-gateway.mjs
   ```

   The gateway listens on `127.0.0.1:5301`.

3. LangBot running with the `langbot-plugin-sdk` installed.

## Install the plugin

1. Copy this directory (`titan-claw-connector`) into your LangBot
   `data/plugins/` folder (or wherever your Plugin Runtime loads plugins from).
2. Install dependencies:

   ```bash
   cd titan-claw-connector
   uv pip install -r requirements.txt
   ```

3. Set environment variables (example for Windows PowerShell):

   ```powershell
   $env:TITAN_GATEWAY_URL="http://127.0.0.1:5301/task"
   $env:TITAN_ALLOWED_USER_IDS="<your_telegram_user_id>"
   ```

4. Start LangBot. The plugin will be auto-loaded by the Plugin Runtime.

## Usage

In your Telegram chat with the LangBot-connected bot:

```
!titan Create a simple calculator web app with HTML/CSS/JS
```

The pipeline will:
1. Decompose the task into verifiable work items (Layer A).
2. Have local coding clients (OpenCode/Cline/Kilo/Harness) write the code.
3. Run the eight-party review gate.
4. Return the dispatch ID and result summary to your Telegram chat.

## Files

- `main.py` - Plugin entry point, message handler, HTTP gateway client.
- `manifest.yaml` - Plugin manifest.
- `components/message_handler/default.py` - Telegram message listener.
- `components/tools/titan_task.py` - Tool component for LLM agent invocation.
- `requirements.txt` - Python dependencies.
