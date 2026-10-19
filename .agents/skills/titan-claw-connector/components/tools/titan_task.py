from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from typing import Any

from langbot_plugin.api.definition.components.tool import ToolComponent


class TitanTaskTool(ToolComponent):
    """Tool component that exposes TITAN pipeline execution to the LLM agent."""

    name = "titan_task"
    description = (
        "Submit a task to the TITAN multi-AI pipeline orchestrator and return "
        "the review result. Input: { task: string }. Returns dispatchId and summary."
    )

    def __init__(self, plugin):
        super().__init__(plugin)
        self.plugin = plugin

    async def execute(self, args: dict[str, Any], ctx: Any) -> str:
        task = args.get("task", "")
        user_id = getattr(ctx, "sender_user_id", "") or getattr(
            ctx, "user_id", ""
        )
        if not task:
            return "Error: task is required"
        if user_id not in self.plugin.allowed_user_ids:
            return "Error: user not allowed"
        return await self.plugin._dispatch_titan(task, str(user_id))
