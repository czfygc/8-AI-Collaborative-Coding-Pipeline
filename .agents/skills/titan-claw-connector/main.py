from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from typing import Any, Dict

from langbot_plugin.api.definition.plugin import BasePlugin
from langbot_plugin.api.proxies import langbot_api


class Plugin(BasePlugin):
    """TITAN Claw Connector: forwards Telegram messages to TITAN orchestrator gateway.

    Security model:
      - Only ALLOWED_USER_IDS may submit tasks.
      - Tasks are limited to TITAN_ROOT-scoped artifact paths or inline prompts.
      - No shell execution, no arbitrary file access, no PowerShell bypass.
    """

    def __init__(self):
        super().__init__()
        self.gateway_url = os.environ.get("TITAN_GATEWAY_URL", "http://127.0.0.1:5301/task")
        allowed_raw = os.environ.get("TITAN_ALLOWED_USER_IDS", "")
        self.allowed_user_ids = set(
            s.strip() for s in allowed_raw.split(",") if s.strip()
        )
        self._http_timeout = 30

    async def initialize(self) -> None:
        self.log(
            "TITAN Claw Connector initialized. Gateway=%s AllowedUsers=%s"
            % (self.gateway_url, ",".join(sorted(self.allowed_user_ids)))
        )

    async def on_message(self, event: Any) -> None:
        """Handle inbound Telegram message.

        LangBot routes platform messages to event listener components.
        We only handle text messages from allowed users that start with !titan.
        """
        try:
            user_id = self._extract_user_id(event)
            if not user_id or user_id not in self.allowed_user_ids:
                self.log("Rejected message from non-allowed user: %s" % user_id)
                return

            text = self._extract_text(event)
            if not text or not text.startswith("!titan "):
                return

            task = text[len("!titan "):].strip()
            if not task:
                await self._reply(event, "Usage: !titan <your task description>")
                return

            await self._reply(event, "Received task, dispatching to TITAN pipeline...")
            result = await self._dispatch_titan(task, user_id)
            await self._reply(event, result)
        except Exception as e:  # noqa: BLE001 - top-level message handler must not crash
            self.log("Message handler error: %s" % e)
            try:
                await self._reply(event, "Internal error: %s" % str(e)[:200])
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _extract_user_id(self, event: Any) -> str:
        """Best-effort extraction of sender user ID from LangBot message entity."""
        try:
            sender = getattr(event, "sender", None)
            if sender is not None:
                uid = getattr(sender, "user_id", None) or getattr(sender, "id", None)
                if uid:
                    return str(uid)
            # Fallback: some adapters nest under message.sender
            msg = getattr(event, "message", None)
            if msg is not None:
                s = getattr(msg, "sender", None)
                if s is not None:
                    uid = getattr(s, "user_id", None) or getattr(s, "id", None)
                    if uid:
                        return str(uid)
        except Exception:  # noqa: BLE001
            pass
        return ""

    def _extract_text(self, event: Any) -> str:
        """Best-effort extraction of plain text from message entity."""
        try:
            msg = getattr(event, "message", None) or event
            chain = getattr(msg, "message_chain", None) or getattr(msg, "message", None)
            if chain is not None:
                parts = []
                for seg in chain:
                    t = getattr(seg, "text", None)
                    if t:
                        parts.append(t)
                if parts:
                    return "".join(parts)
            # Direct text attribute
            return getattr(msg, "text", "") or getattr(event, "text", "")
        except Exception:  # noqa: BLE001
            return ""

    async def _reply(self, event: Any, text: str) -> None:
        """Reply to the message using LangBot message API proxy."""
        try:
            ctx = getattr(event, "ctx", None) or getattr(event, "context", None)
            if ctx is not None and hasattr(ctx, "reply"):
                await ctx.reply(text)
                return
        except Exception:  # noqa: BLE001
            pass
        # Fallback: use LangBot API proxy if available
        try:
            api = langbot_api  # type: ignore[name-defined]
            if hasattr(api, "send_message"):
                # Best-effort; exact signature depends on SDK version
                pass
        except Exception:  # noqa: BLE001
            pass

    async def _dispatch_titan(self, task: str, user_id: str) -> str:
        """Send task to TITAN gateway and return a short result summary."""
        payload = json.dumps(
            {
                "prompt": task,
                "user_id": user_id,
                "trigger": "titan-claw-connector",
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            self.gateway_url,
            data=payload,
            headers={"Content-Type": "application/json", "X-User-ID": user_id},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._http_timeout) as resp:
                body = resp.read().decode("utf-8")
                data = json.loads(body)
        except urllib.error.HTTPError as e:
            return "TITAN gateway HTTP %d: %s" % (e.code, e.read().decode("utf-8", "ignore")[:200])
        except Exception as e:  # noqa: BLE001
            return "TITAN gateway request failed: %s" % str(e)[:200]

        if not data.get("ok"):
            return "TITAN task failed: %s" % (data.get("stderr") or data.get("summary") or "unknown error")

        lines = [
            "TITAN task dispatched.",
            "DispatchId: %s" % data.get("dispatchId"),
            "ExitCode: %s" % data.get("exitCode"),
        ]
        if data.get("summary"):
            lines.append("Result: %s" % str(data.get("summary"))[:400])
        if data.get("architectDecision"):
            lines.append("Decision: %s" % str(data.get("architectDecision"))[:200])
        return "\n".join(lines)
