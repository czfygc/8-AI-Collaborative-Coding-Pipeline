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
import re
import subprocess
import sys
import tempfile
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
TITAN_ROOT = os.environ.get("TITAN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLL_INTERVAL = 3  # 秒
SEND_RETRIES = 3
DEDUP_WINDOW = 30  # 秒：同 chat 同文案在此窗口内只回一次

# T-122 步骤2.1：语音意图分流（方案B前缀优先 + 方案A关键词，不调大模型）
CONSULT_PREFIXES = ("咨询", "问一下", "帮我看看")
EXECUTE_PREFIXES = ("执行", "落地", "审阅")
EXECUTE_KEYWORDS = ("改代码", "修bug", "修 bug", "修复", "修改", "写代码", "实现", "重构", "落地")
CODEGEN_PREFIXES = ("生成", "写新", "新建代码", "从零生成", "新代码")
CODEGEN_KEYWORDS = ("生成新代码", "新代码", "新建", "从零写", "零代码", "新功能")
# T-166（R6）：机器人三档模式 → intent schema 枚举（consult/fix/implement；与网关 lib/intent.mjs 同表）
MODE_TO_INTENT = {"consult": "consult", "execute": "fix", "codegen": "implement"}
FILE_TOKEN_RE = re.compile(r"[\w./\\\-]+\.\w{1,4}")
SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", "chrome-cdp-profile",
             ".dsh-tmp-cache", ".dsh-tmp-pack", ".dsh-tmp-pnpm-store", "archive",
             "freellmapi-src", "test-projects", "HARNESS", "_session-import"}
PENDING_EXECUTE = {}  # chat_id -> 待补文件的落地任务原文
PENDING_CODEGEN = {}  # chat_id -> 待用户确认的代码生成任务

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


def titan_dispatch_json(task, user_id, mode=None, intent=None, reply_channel=None):
    """提交任务给 TITAN 网关，返回网关原始 JSON（失败时返回 {'ok': False, ...}）。"""
    payload = {
        "prompt": task,
        "user_id": str(user_id),
        "trigger": "titan-telegram-bot",
    }
    if mode:
        payload["mode"] = mode
    # T-166（R6）：意图随请求下发，网关落 reviews/_pending/intent-<ts>.json（审计面）。
    if intent:
        payload["intent"] = intent
    if reply_channel:
        payload["reply_channel"] = str(reply_channel)
    payload = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        TITAN_GATEWAY_URL,
        data=payload,
        headers={"Content-Type": "application/json", "X-User-ID": str(user_id)},
        method="POST",
    )
    try:
        # 20 分钟 > 网关 15 分钟：run 咨询 4 席并行 capture 实测可超 5 分钟（T-122）
        with urllib.request.urlopen(req, timeout=1200) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"TITAN 网关 HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}"}
    except Exception as e:
        return {"ok": False, "error": f"TITAN 网关请求失败: {str(e)[:200]}"}


def titan_dispatch(task, user_id, mode=None, intent=None, reply_channel=None):
    """将任务提交给 TITAN 网关，返回结果文本"""
    data = titan_dispatch_json(task, user_id, mode, intent, reply_channel)

    if not data.get("ok"):
        return f"TITAN 任务失败: {data.get('stderr') or data.get('summary') or data.get('error') or '未知错误'}"

    lines = [
        "TITAN 任务已分发",
        f"DispatchId: {data.get('dispatchId')}",
        f"ExitCode: {data.get('exitCode')}",
    ]
    if data.get("summary"):
        lines.append(f"结果摘要: {str(data.get('summary') or '')[:3500]}")
    if data.get("architectDecision"):
        lines.append(f"架构师裁决: {str(data.get('architectDecision') or '')[:200]}")
    return chr(10).join(lines)


def _node_bin():
    return os.environ.get("TITAN_NODE_BIN") or "node"


def _run_gate(args, timeout=300):
    """调用通用写闸 CLI（orchestrator/run-gate.mjs）。"""
    cmd = [_node_bin(), os.path.join(TITAN_ROOT, "orchestrator", "run-gate.mjs")] + list(args)
    return subprocess.run(cmd, cwd=TITAN_ROOT, capture_output=True, text=True, timeout=timeout)


def handle_codegen(chat_id, user_id, task):
    """T-156/T-153：从零生成新代码 → 登记「提交提案」→ 等用户回「提交」才 commit。

    提案走通用写闸（orchestrator/lib/write-gate.mjs），确认后才 git commit。
    """
    if not is_allowed(user_id):
        tg_send_message(chat_id, "抱歉，你不在授权用户名单中，无法提交 TITAN 任务。", dedup=True)
        return
    tg_send_message(chat_id, "已收到生成任务，正在生成代码并做独立验收（可能需要几分钟）...")
    data = titan_dispatch_json(task, user_id, mode="codegen", intent=MODE_TO_INTENT.get("codegen"), reply_channel=str(chat_id))
    if not data.get("ok"):
        msg = str(data.get("stderr") or data.get("summary") or data.get("error") or "未知错误")[:800]
        tg_send_message(chat_id, "生成失败: " + msg)
        return
    pid = data.get("proposalId")
    files = data.get("files") or []
    summary = str(data.get("summary") or "")[:1200]
    PENDING_CODEGEN[chat_id] = {
        "proposal_id": pid,
        "files": files,
        "summary": summary,
        "user_id": str(user_id),
    }
    lines = [
        "生成完成，独立验收通过（作者 != 验证者）。",
        "文件: " + (", ".join(files) if files else "(无)"),
        "提案: " + str(pid),
        "",
        "摘要:",
        summary,
        "",
        "回复「提交」确认 commit，或回复「取消」放弃。",
    ]
    tg_send_message(chat_id, chr(10).join(lines))


def do_codegen_commit(chat_id, user_id):
    """用户回「提交」→ 显式确认提案 + 落盘（git commit）。"""
    pend = PENDING_CODEGEN.pop(chat_id, None)
    if not pend or not pend.get("proposal_id"):
        tg_send_message(chat_id, "没有待提交的生成提案。", dedup=True)
        return
    try:
        r = subprocess.run(
            [
                _node_bin(),
                os.path.join(TITAN_ROOT, "orchestrator", "titan-codegen.mjs"),
                "--commit",
                pend["proposal_id"],
                "--by",
                f"telegram:{user_id}",
            ],
            cwd=TITAN_ROOT,
            capture_output=True,
            text=True,
            timeout=300,
        )
    except Exception as e:
        tg_send_message(chat_id, "提交失败: " + str(e)[:300])
        return
    if r.returncode != 0:
        detail = ((r.stdout or "") + (r.stderr or ""))[-800:]
        tg_send_message(chat_id, "提交失败: " + detail)
        return
    tg_send_message(chat_id, "已提交:" + chr(10) + (r.stdout or "")[-800:])


def do_codegen_cancel(chat_id):
    """用户回「取消」→ 提案标记 rejected，生成物保持未入库状态（不自动删文件）。"""
    pend = PENDING_CODEGEN.pop(chat_id, None)
    if not pend:
        tg_send_message(chat_id, "没有待确认的生成提案。", dedup=True)
        return
    pid = pend.get("proposal_id")
    if pid:
        try:
            _run_gate(["reject", "--proposal", pid, "--by", "telegram:cancel", "--reason", "用户取消"])
        except Exception as e:
            tg_send_message(chat_id, "取消提案时出错（已放弃提交）: " + str(e)[:200])
            return
    files = pend.get("files") or []
    tg_send_message(
        chat_id,
        "已放弃本次生成。提案 " + str(pid) + " 已标记 rejected。生成物未入库，路径: "
        + (", ".join(files) if files else "(无)"),
    )


def is_allowed(user_id):
    if not TITAN_ALLOWED_USER_IDS:
        # 未配置白名单时，拒绝全部（安全默认）
        return False
    return str(user_id) in TITAN_ALLOWED_USER_IDS


def handle_task(chat_id, user_id, task):
    """2. 长任务放后台 daemon 线程：轮询线程不被 300 秒的网关调用卡死。"""
    mode, sub, pipeline = classify_intent(task)
    if mode == "codegen":
        handle_codegen(chat_id, user_id, task)
        return
    if mode == "execute":
        handle_execute(chat_id, user_id, task, pipeline)
        return
    tg_send_message(chat_id, "已收到任务，正在提交给 TITAN 流水线...")
    try:
        result = titan_dispatch(task, user_id, intent=MODE_TO_INTENT.get(mode), reply_channel=str(chat_id))
    except Exception as e:  # noqa: BLE001
        result = f"内部错误: {str(e)[:200]}"
    tg_send_message(chat_id, result)


def classify_intent(text):
    """T-122 步骤2.1：轻量意图判断（不调大模型）。
    返回 (mode, task, pipeline)：mode='consult'|'execute'；pipeline='scan'|'review'。
    方案B：前缀命中即定模式并剥前缀；方案A：无前缀时扫关键词，默认咨询。"""
    t = (text or "").strip()
    low = t.lower()
    for p in CODEGEN_PREFIXES:
        if t.startswith(p):
            return "codegen", t[len(p):].strip(" ：:，,。"), ""
    if any(k in low for k in CODEGEN_KEYWORDS) and not FILE_TOKEN_RE.search(t):
        if not any(k in low for k in ("修复", "修bug", "修 bug", "改代码", "修改", "重构", "落地", "审阅", "执行")):
            return "codegen", t, ""
    for p in EXECUTE_PREFIXES:
        if t.startswith(p):
            return "execute", t[len(p):].strip(" ：:，,。"), ("review" if p == "审阅" else "scan")
    for p in CONSULT_PREFIXES:
        if t.startswith(p):
            return "consult", t[len(p):].strip(" ：:，,。"), ""
    low = t.lower()
    if any(k in low for k in EXECUTE_KEYWORDS):
        return "execute", t, "scan"
    return "consult", t, ""


def extract_file_hint(text):
    """从任务文本提取疑似文件名/路径 token；没有返回 None。"""
    m = FILE_TOKEN_RE.search(text or "")
    return m.group(0) if m else None


def resolve_file_path(hint):
    """把用户给的文件名/路径解析成 TITAN_ROOT 内的绝对路径。
    返回 (abs_path, err)：成功 err=None；失败 abs_path=None、err=给用户的提示。"""
    h = (hint or "").strip().strip("`\"'").rstrip("。，,；;、")
    if not h:
        return None, "文件名为空，请告诉我文件名或直接发文件给我。"
    cand = h if os.path.isabs(h) else os.path.join(TITAN_ROOT, h)
    cand = os.path.abspath(cand)
    if os.path.isfile(cand):
        if cand.startswith(TITAN_ROOT):
            return cand, None
        return None, f"文件必须在 TITAN 工作区内：{h}"
    base = os.path.basename(h.replace("\\", "/"))
    hits = []
    for root, dirs, files in os.walk(TITAN_ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if base in files:
            hits.append(os.path.join(root, base))
        if len(hits) > 5:
            break
    if len(hits) == 1:
        return hits[0], None
    if not hits:
        return None, f"没找到文件 {base}，请确认文件名，或直接把文件发给我。"
    return None, "找到多个同名文件，请回复完整路径之一：\n" + "\n".join(
        os.path.relpath(p, TITAN_ROOT) for p in hits[:5]
    )


def execute_dispatch(file_path, user_id, pipeline="scan"):
    """T-122 步骤2.3/2.5：落地派发。scan→--scan --auto-fix（改码）；
    review→--review --analyze --architect-local（审阅裁决，不改码）。"""
    if pipeline == "review":
        body = {"artifact_path": file_path, "user_id": str(user_id), "trigger": "titan-telegram-bot"}
    else:
        body = {"mode": "scan", "file_path": file_path, "user_id": str(user_id), "trigger": "titan-telegram-bot"}
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        TITAN_GATEWAY_URL,
        data=payload,
        headers={"Content-Type": "application/json", "X-User-ID": str(user_id)},
        method="POST",
    )
    try:
        # 32 分钟 > 网关 30 分钟：scan 全链实测 = 网页席 ~14.5min + 执行链数分钟（T-122 e2e）
        with urllib.request.urlopen(req, timeout=1900) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return f"TITAN 网关 HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}"
    except Exception as e:
        return f"TITAN 网关请求失败: {str(e)[:200]}"
    if not data.get("ok"):
        return "落地执行失败: " + str(data.get("summary") or data.get("stderr") or "未知错误")[:1500]
    lines = [
        "落地执行完成" if pipeline != "review" else "审阅完成",
        f"ExitCode: {data.get('exitCode')}",
    ]
    if data.get("summary"):
        lines.append(f"执行结果:\n{str(data.get('summary'))[:3000]}")
    if data.get("architectDecision"):
        lines.append(f"架构师裁决:\n{str(data.get('architectDecision'))[:1500]}")
    return chr(10).join(lines)


def dispatch_execute(chat_id, user_id, task, file_path, pipeline="scan"):
    """派发落地执行并回传结果（步骤2.5）。"""
    rel = os.path.relpath(file_path, TITAN_ROOT)
    action = "审阅并裁决" if pipeline == "review" else "扫描并修复"
    tg_send_message(chat_id, f"开始{action}：{rel}\n（最长约15分钟，完成后自动回传）", dedup=True)
    result = execute_dispatch(file_path, user_id, pipeline)
    tg_send_message(chat_id, result)


def handle_execute(chat_id, user_id, task, pipeline="scan", file_hint=None):
    """T-122 步骤2.3：落地路径。确定目标文件 → 派发；没有/歧义 → 挂起等用户补充。"""
    tg_send_message(chat_id, "我把你当成执行任务了。", dedup=True)
    hint = file_hint or extract_file_hint(task)
    if hint:
        file_path, err = resolve_file_path(hint)
        if err is None:
            threading.Thread(
                target=dispatch_execute,
                args=(chat_id, user_id, task, file_path, pipeline),
                daemon=True,
                name="titan-execute",
            ).start()
            return
        tg_send_message(chat_id, err, dedup=True)
        PENDING_EXECUTE[chat_id] = (task, pipeline)
        tg_send_message(chat_id, '要改哪个文件？请发给我或告诉我文件名（回复"取消"放弃）。', dedup=True)
        return
    PENDING_EXECUTE[chat_id] = (task, pipeline)
    tg_send_message(chat_id, '要改哪个文件？请发给我或告诉我文件名（回复"取消"放弃）。', dedup=True)


def save_document_to_inbox(document):
    """把用户直接发的文件存到 _tmp_inbox（.gitignore 已覆盖 _tmp_*），返回绝对路径。"""
    file_id = document.get("file_id")
    if not file_id:
        raise ValueError("文件消息缺少 file_id")
    info = tg_get_file(file_id)
    file_path = info["result"]["file_path"]
    data = tg_download_file(file_path)
    name = os.path.basename(file_path) or "upload.bin"
    inbox = os.path.join(TITAN_ROOT, "_tmp_inbox")
    os.makedirs(inbox, exist_ok=True)
    dest = os.path.join(inbox, name.replace("/", "_").replace("\\", "_"))
    with open(dest, "wb") as f:
        f.write(data)
    return dest


def handle_pending_answer(chat_id, user_id, answer_text=None, document=None):
    """处理挂起落地任务的文件补充（文本文件名 或 直接发的文件）。"""
    pending = PENDING_EXECUTE.pop(chat_id, None)
    if pending is None:
        return
    task, pipeline = pending
    if (answer_text or "").strip() == "取消":
        tg_send_message(chat_id, "已取消落地任务。", dedup=True)
        return
    file_path = None
    if document:
        try:
            file_path = save_document_to_inbox(document)
        except Exception as e:  # noqa: BLE001
            tg_send_message(chat_id, f"文件接收失败: {str(e)[:150]}，请重发或告诉我文件名。", dedup=True)
    else:
        file_path, err = resolve_file_path(answer_text)
        if err is not None:
            tg_send_message(chat_id, err, dedup=True)
    if file_path is None:
        PENDING_EXECUTE[chat_id] = (task, pipeline)
        return
    threading.Thread(
        target=dispatch_execute,
        args=(chat_id, user_id, task, file_path, pipeline),
        daemon=True,
        name="titan-execute",
    ).start()


def tg_get_file(file_id):
    """7. 取 Telegram 文件服务器路径（语音 ogg 用）。"""
    url = f"{BASE}/getFile?file_id={file_id}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def tg_download_file(file_path):
    """下载 Telegram 文件字节（语音 ogg）。"""
    url = f"https://api.telegram.org/file/bot{TG_BOT_TOKEN}/{file_path}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        return resp.read()


def ogg_to_wav(ogg_bytes):
    """8. ffmpeg 把 ogg/opus 语音转成 16kHz 单声道 wav，兼容 Whisper 上游。"""
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as fin:
        fin.write(ogg_bytes)
        in_path = fin.name
    out_path = in_path + ".wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", in_path, "-ar", "16000", "-ac", "1", out_path],
            check=True, capture_output=True, timeout=60,
        )
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        for p in (in_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass


def stt_transcribe(audio_wav_bytes):
    """9. POST FreeLLMAPI /v1/audio/transcriptions（免费 Whisper，Groq/Cloudflare）。
    不需 OpenAI API Key，不收费。（T-121）"""
    api_key = os.environ.get("TITAN_FREELLM_API_KEY", "")
    boundary = "----TITANSTT" + str(int(time.time() * 1000))
    parts = []

    def field(name, value):
        parts.append(f"--{boundary}".encode("utf-8"))
        parts.append(f'Content-Disposition: form-data; name="{name}"'.encode("utf-8"))
        parts.append(b"")
        parts.append(str(value).encode("utf-8"))

    field("model", "whisper-1")
    parts.append(f"--{boundary}".encode("utf-8"))
    parts.append(b'Content-Disposition: form-data; name="file"; filename="voice.wav"')
    parts.append(b"Content-Type: audio/wav")
    parts.append(b"")
    parts.append(audio_wav_bytes)
    parts.append(f"--{boundary}--".encode("utf-8"))
    body = b"\r\n".join(parts) + b"\r\n"
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(
        "http://127.0.0.1:3001/v1/audio/transcriptions",
        data=body, headers=headers, method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("text", "")


def handle_voice(chat_id, user_id, voice):
    """6. 语音消息：下载 ogg → ffmpeg 转 wav → FreeLLMAPI 免费 STT 转文字 → 当 !titan 任务正文执行。
    后台 daemon 线程，避免卡死轮询。（T-121）"""
    if not is_allowed(user_id):
        tg_send_message(chat_id, "抱歉，你不在授权用户名单中，无法提交 TITAN 任务。", dedup=True)
        return
    file_id = voice.get("file_id")
    if not file_id:
        tg_send_message(chat_id, "语音消息无法获取文件，请再发一次。", dedup=True)
        return
    tg_send_message(chat_id, "已收到语音，正在转文字...", dedup=True)
    try:
        file_info = tg_get_file(file_id)
        file_path = file_info["result"]["file_path"]
        ogg_bytes = tg_download_file(file_path)
        wav_bytes = ogg_to_wav(ogg_bytes)
        text = stt_transcribe(wav_bytes)
    except Exception as e:  # noqa: BLE001
        tg_send_message(chat_id, f"语音处理失败: {str(e)[:200]}", dedup=True)
        return
    if not text or not text.strip():
        tg_send_message(chat_id, "语音未识别出可用文字，请再试一次。", dedup=True)
        return
    tg_send_message(chat_id, f"语音转写: {text[:200]}", dedup=True)
    # T-122 步骤2.1/2.2/2.4：轻量意图分流（前缀优先，其次关键词，默认咨询）
    mode, task, pipeline = classify_intent(text)
    task = task or text
    if mode == "execute":
        handle_execute(chat_id, user_id, task, pipeline)
        return
    tg_send_message(chat_id, "我把你当成咨询了。", dedup=True)
    # 咨询路径：4 席并行咨询（handle_task 内部已开后台线程）
    handle_task(chat_id, user_id, task)


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
            voice = msg.get("voice")
            document = msg.get("document")
            print(
                f"[MSG] user={user_id} chat={chat_id} text={text[:80]} "
                f"voice={'yes' if voice else 'no'} doc={'yes' if document else 'no'}"
            )
            if voice:
                threading.Thread(
                    target=handle_voice,
                    args=(chat_id, user_id, voice),
                    daemon=True,
                    name="titan-voice",
                ).start()
                continue
            if chat_id in PENDING_CODEGEN:
                if not is_allowed(user_id):
                    tg_send_message(chat_id, "抱歉，你不在授权用户名单中，无法提交 TITAN 任务。", dedup=True)
                    continue
                ans = (text or "").strip()
                if ans == "提交":
                    do_codegen_commit(chat_id, user_id)
                elif ans == "取消":
                    do_codegen_cancel(chat_id)
                else:
                    tg_send_message(chat_id, "请回复「提交」确认 commit，或回复「取消」放弃。", dedup=True)
                continue
            # T-122：挂起落地任务的文件补充应答（文本文件名 或 直接发文件）
            if chat_id in PENDING_EXECUTE and (document or not text.startswith("!titan ")):
                if not is_allowed(user_id):
                    tg_send_message(
                        chat_id, "抱歉，你不在授权用户名单中，无法提交 TITAN 任务。", dedup=True
                    )
                    continue
                threading.Thread(
                    target=handle_pending_answer,
                    args=(chat_id, user_id, text, document),
                    daemon=True,
                    name="titan-execute-ans",
                ).start()
                continue
            if document:
                tg_send_message(
                    chat_id,
                    '收到文件。如需扫描修复，请发语音说"落地"，或用文字 !titan <任务> 发起。',
                    dedup=True,
                )
                continue
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