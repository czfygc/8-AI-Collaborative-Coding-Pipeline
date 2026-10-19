from __future__ import annotations

import logging
from typing import Any

from langbot_plugin.api.definition.components.event_listener import (
    EventListenerComponent,
)
from langbot_plugin.api.entities.context import EventContext
from langbot_plugin.api.entities.event.message import NormalMessageResponsedEvent


logger = logging.getLogger("titan-claw-connector")


class DefaultMessageHandler(EventListenerComponent):
    """Listens for Telegram messages and forwards TITAN tasks to the HTTP gateway.

    Command format: !titan <your task description>
    Only users in TITAN_ALLOWED_USER_IDS may submit tasks.
    """

    name = "titan-message-handler"

    def __init__(self, plugin):
        super().__init__(plugin)
        self.plugin = plugin

    async def handle(self, event: NormalMessageResponsedEvent, ctx: Any) -> None:
        """Entry point called by LangBot runtime for each inbound message."""
        try:
            user_id = self._extract_user_id(event)
            if not user_id or user_id not in self.plugin.allowed_user_ids:
                logger.debug("Rejected message from non-allowed user: %s", user_id)
                return

            text = self._extract_text(event)
            if not text or not text.startswith("!titan "):
                return

            task = text[len("!titan "):].strip()
            if not task:
                await ctx.reply("Usage: !titan <your task description>")
                return

            await ctx.reply("Received task, dispatching to TITAN pipeline...")
            result = await self.plugin._dispatch_titan(task, user_id)
            await ctx.reply(result)
        except Exception:  # noqa: BLE001 - top-level handler must not crash
            logger.exception("Message handler error")
            try:
                await ctx.reply("Internal error, see TITAN gateway logs.")
            except Exception:  # noqa: BLE001
                pass

    def _extract_user_id(self, event: NormalMessageResponsedEvent) -> str:
        sender = getattr(event, "sender", None)
        if sender is not None:
            return str(getattr(sender, "user_id", getattr(sender, "id", "")) or "")
        return ""

    def _extract_text(self, event: NormalMessageResponsedEvent) -> str:
        msg = getattr(event, "message", None) or event
        chain = getattr(msg, "message_chain", None)
        if chain:
            parts = []
            for seg in chain:
                t = getattr(seg, "text", None)
                if t:
                    parts.append(t)
            if parts:
                return "".join(parts)
        return getattr(msg, "text", "")
