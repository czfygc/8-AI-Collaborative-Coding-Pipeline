#!/usr/bin/env python3
# TITAN Telegram Bot - TITAN 流水线 Telegram 消息入口
# 用法：
#   set TITAN_BOT_TOKEN=<你的 Bot Token>
#   set TITAN_ALLOWED_USER_IDS=<你的 Telegram 用户 ID>
#   set TITAN_GATEWAY_URL=http://127.0.0.1:5301/task
#   python titan_telegram_bot.py
#
# 在 Telegram 中向机器人发送：!titan <你的任务描述>
# 机器人会把任务提交给 TITAN 流水线，并把执行结果发回。
#
# T-120 吸收半年前 Claude 版 TITAN_Human_V30_B 的实战经验：
#   config.py  -> Windows GBK 编码兜底（否则中文/emoji print 直接 UnicodeEncodeError 崩溃）
#   bot_ui.py  -> 长任务丢后台 daemon 线程，轮询线程不被网关长调用卡死
#   bot_ui.py  -> sendMessage 3 次重试 + 2^n 退避 + not modified / message not found 特判
#   bot_ui.py  -> 内容 md5 去重，杜绝重复提示刷屏（历史红线：>10 次/分 会 429 封 bot 号）

import hashlib
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.error

# ---- 1. Windows GBK 编码兜底（历史 Claude config.py 同款，必须先于任何 print）----
# 同时开 line_buffering：stdout 重定向到日志文件时否则是块缓冲，日志会卡在缓冲区里观察不到。
try:
    if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
    if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
except Exception:
    pass

TG_BOT_TOKEN = os.environ.get("TITAN_BOT_TOKEN", "")
TITAN_ALLOWED_USER_IDS = set(
    s.strip() for s in os.environ.get("TITAN_ALLOWED_USER_IDS", "").split(",") if s.strip()
)
TITAN_GATEWAY_URL = os.environ.get("TITAN_GATEWAY_URL", "http://127.0.0.1:5301/task")
POLL_INTERVAL = 3  # 秒
SEND_RETRIES = 3
DEDUP_WINDOW = 30  # 秒：同 chat 同文案在此窗口内只回一次

if not TG_BOT_TOKEN:
    print("[FATAL] 请设置 TITAN_BOT_TOKEN 环境变量", file=sys.stderr)
    sys.exit(1)

BASE = f"https://api.telegram.org/bot{TG_BOT_TOKEN}"

# ---- 4. 内容 md5 去重（历史 bot_ui.py content_for_hash 同款）----
_dedup_lock = threading.Lock()
_dedup_state = {"key": "", "ts": 0.0}


def _dedup_ok(chat_id, text):
    key = hashlib.md5(f"{chat_id}|{text}".encode("utf-8")).hexdigest()
    now = time.time()
    with _dedup_lock:
        if _dedup_state["key"] == key and (now - _dedup_state["ts"]) < DEDUP_WINDOW:
            return False
        _dedup_state["key"] = key
        _dedup_state["ts"] = now
        return True


def tg_get_updates(offset):
    url = f"{BASE}/getUpdates?offset={offset}&timeout={POLL_INTERVAL}&limit=100"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[WARN] getUpdates 失败: {e}", file=sys.stderr)
        return {"ok": False, "result": []}


def tg_send_message(chat_id, text, dedup=False):
    """带 3 次重试 + 指数退避的发送（历史 bot_ui.py 同款）。
    dedup=True 用于提示类回复，避免同一句话 30 秒内刷屏。"""
    if dedup and not _dedup_ok(chat_id, text):
        print(f"[SKIP] 去重命中，跳过重复提示 chat={chat_id}", file=sys.stderr)
        return {"ok": True, "deduped": True}

    url = f"{BASE}/sendMessage"
    payload = json.dumps(
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    ).encode("utf-8")
    last_err = ""
    for attempt in range(SEND_RETRIES):
        try:
            req = urllib.request.Request(
                url, data=payload, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                out = json.loads(resp.read().decode("utf-8"))
            if out.get("ok"):
                return out
            last_err = str(out.get("description") or out)
            if "not modified" in last_err.lower():
                return out
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:200]
            last_err = f"HTTP {e.code}: {body}"
            if e.code in (400, 403, 404):
                break
        except Exception as e:
            last_err = str(e)[:200]
        if attempt < SEND_RETRIES - 1:
            time.sleep(2 ** attempt)
    print(
        f"[WARN] sendMessage 失败（已重试 {SEND_RETRIES} 次）: {last_err}",
        file=sys.stderr,
    )
    return None


def titan_dispatch(task, user_id):
    """将任务提交给 TITAN 网关，返回结果文本"""
    payload = json.dumps(
        {
            "prompt": task,
            "user_id": str(user_id),
            "trigger": "titan-telegram-bot",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        TITAN_GATEWAY_URL,
        data=payload,
        headers={"Content-Type": "application/json", "X-User-ID": str(user_id)},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
    except urllib.error.HTTPError as e:
        return f"TITAN 网关 HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}"
    except Exception as e:
        return f"TITAN 网关请求失败: {str(e)[:200]}"

    if not data.get("ok"):
        return f"TITAN 任务失败: {data.get('stderr') or data.get('summary') or '未知错误'}"

    lines = [
        "TITAN 任务已分发",
        f"DispatchId: {data.get('dispatchId')}",
        f"ExitCode: {data.get('exitCode')}",
    ]
    if data.get("summary"):
        lines.append(f"结果摘要: {str(data.get('summary'))[:500]}")
    if data.get("architectDecision"):
        lines.append(f"架构师裁决: {str(data.get('architectDecision'))[:200]}")
    return chr(10).join(lines)


def is_allowed(user_id):
    if not TITAN_ALLOWED_USER_IDS:
        # 未配置白名单时，拒绝全部（安全默认）
        return False
    return str(user_id) in TITAN_ALLOWED_USER_IDS


def handle_task(chat_id, user_id, task):
    """2. 长任务放后台 daemon 线程：轮询线程不被 300 秒的网关调用卡死。"""
    tg_send_message(chat_id, "已收到任务，正在提交给 TITAN 流水线...")
    try:
        result = titan_dispatch(task, user_id)
    except Exception as e:  # noqa: BLE001
        result = f"内部错误: {str(e)[:200]}"
    tg_send_message(chat_id, result)


def main():
    print(f"[TITAN Telegram Bot] 启动，Bot 令牌已设置，网关={TITAN_GATEWAY_URL}")
    print(
        "[TITAN Telegram Bot] 白名单用户: "
        f"{sorted(TITAN_ALLOWED_USER_IDS) if TITAN_ALLOWED_USER_IDS else '（空，全部拒绝）'}"
    )
    offset = 0
    # 5. 开机跳过积压（历史 main.py infinity_polling(skip_pending=True) 同款）：
    #    崩溃/停机期间堆积的旧消息不回放，否则一开机就对用户连发一堆提示 = 刷屏。
    #    peek 用 offset=0（不确认），随后取 max+1 才真正确认移除。
    pending = tg_get_updates(0)
    if pending.get("ok") and pending.get("result"):
        backlog = pending["result"]
        offset = backlog[-1]["update_id"] + 1
        print(f"[TITAN Telegram Bot] 启动跳过积压 {len(backlog)} 条（skip_pending）")
    print("[TITAN Telegram Bot] 等待消息... 向机器人发送 !titan <任务描述>")
    while True:
        resp = tg_get_updates(offset)
        if not resp.get("ok"):
            time.sleep(POLL_INTERVAL)
            continue
        updates = resp.get("result", [])
        for upd in updates:
            offset = upd["update_id"] + 1
            msg = upd.get("message") or upd.get("edited_message")
            if not msg:
                continue
            chat_id = msg.get("chat", {}).get("id")
            from_user = msg.get("from", {})
            user_id = str(from_user.get("id"))
            text = msg.get("text", "")
            print(f"[MSG] user={user_id} chat={chat_id} text={text[:80]}")
            if not text or not text.startswith("!titan "):
                if text:
                    tg_send_message(
                        chat_id, "未知指令。用法：!titan <你的任务描述>", dedup=True
                    )
                continue
            if not is_allowed(user_id):
                tg_send_message(
                    chat_id, "抱歉，你不在授权用户名单中，无法提交 TITAN 任务。", dedup=True
                )
                continue
            task = text[len("!titan "):].strip()
            if not task:
                tg_send_message(chat_id, "用法：!titan <你的任务描述>", dedup=True)
                continue
            threading.Thread(
                target=handle_task,
                args=(chat_id, user_id, task),
                daemon=True,
                name="titan-task",
            ).start()
        time.sleep(1)


if __name__ == "__main__":
    main()