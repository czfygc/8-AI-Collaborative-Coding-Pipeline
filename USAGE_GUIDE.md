# Usage Guide — Ship Your Project Without Writing Code

> Written for **non-programmers**. You don't need to know how to code, but you do need to follow the steps below (about 30 minutes of one-time setup).

---

## 1. What this is

This is a pipeline of **8 collaborating AIs**:

- **4 web-AI reviewers** (Gemini, DeepSeek, Qwen, plus ChatGPT as final arbiter) — they produce solutions, break work into tasks, and review results
- **4 local coding clients** (deepseek Harness, OpenCode, Cline, Kilo Code) — they write the actual code

You only need to **describe what you want in plain language**; the pipeline handles decomposition, design, coding, and review.

## 2. Honest prerequisites (read this first)

This is an **Alpha** release. Please confirm you accept:

- ✅ You do **not** need to write code
- ✅ You do not need to write documents or draw architecture diagrams
- ⚠️ But you do need 4 small things: ① install one piece of software ② download and unzip the source ③ type two commands in a terminal ④ talk to an AI client in plain language
- ⚠️ The 4 web AIs require **free accounts that you register yourself** (about 1 minute each)
- ⚠️ Currently supported mainly on **Windows**

## 3. One-time setup (about 30 minutes)

### Step 1: Install Node.js

1. Open <https://nodejs.org>
2. Download the **LTS** version (the left button), double-click to install, click Next all the way through

### Step 2: Download this project's source

1. Open the repository home page <https://github.com/czfygc/8-AI-Collaborative-Coding-Pipeline>
2. Click **Code** → **Download ZIP**
3. Unzip to a folder you like, e.g. `D:\myproject`

### Step 3: Install dependencies in a terminal

1. Open the unzipped folder, type `cmd` in the address bar and press Enter (this opens a terminal on Windows)
2. Type and press Enter:

```powershell
npm install
```

Wait until it finishes (you'll see `added ... packages`).

### Step 4: Start the "browser driver"

The pipeline drives a browser to talk to the web AIs, so it needs a Chrome with remote debugging enabled:

1. Double-click `orchestrator\启动 CDP 浏览器.bat`
2. A Chrome window opens (keep it open — don't close it)

### Step 5: Log in to the 4 web AIs

In that Chrome window, open and log in to each (register free accounts if you don't have them):

| Site | Role |
|---|---|
| <https://gemini.google.com> | Reviewer 1 (architecture) |
| <https://chat.deepseek.com> | Reviewer 2 (correctness) |
| <https://chat.qwen.ai> | Reviewer 3 (adversarial / finding holes) |
| <https://chatgpt.com> | Final arbiter |

Stay logged in — don't sign out.

## 4. Start your first project (10 minutes)

Example: "I want a pet adoption mini-app."

1. Open any local AI client (OpenCode, Cline, or Kilo Code — pick one). It's your "assistant".
2. Tell it in plain language:

> Use this pipeline to build a pet adoption mini-app: users can browse pets available for adoption and submit adoption requests; admins can approve or reject them. First break this into tasks, design it, then write the code, and finally run the eight-party review.

3. The pipeline does the rest: web AIs propose a solution → tasks are decomposed → local clients write code → the eight-party review must pass fully before merging.

> Tip: the more specific your description, the better the result. You can add "which tech stack (e.g. web app)", "whether it needs login", "visual style", etc.

## 5. How to know it's done

- **Process records**: every consultation's raw replies and verdicts are in the `reviews/` directory
- **Actual code**: written in your project directory, viewable like a normal project
- **Task status**: each task has a clear state `todo → claimed → in_progress → verifying → done`; `done` means finished

## 6. Stuck? Common problems

| Symptom | Cause | Fix |
|---|---|---|
| A web AI never replies | It dropped offline or hit a CAPTCHA | Refresh the browser and log in again |
| Error: can't reach `127.0.0.1:9222` | The CDP browser was closed | Double-click `启动 CDP 浏览器.bat` again |
| "Quota exhausted / limit reached" | Free AIs have daily limits | Try again tomorrow, or switch to another AI |
| `node is not recognized as an internal or external command` | Node.js not installed correctly | Reinstall Node.js, then **reopen the terminal** |
| Want to give the author feedback | — | Open an **Issue** on this repository (the author can see it) |

## 7. This is not magic (boundaries & honest statement)

- **Alpha**: complex requests may need several rounds of back-and-forth and fine-tuning, not a one-shot perfect delivery
- **Web AIs change**: these sites often redesign, drop offline, or throttle; the pipeline recovers automatically where it can, but occasionally you'll need to refresh and log in again manually
- **You need basic computer skills**: install software, unzip, open a terminal, register accounts — all learnable in 10 minutes
- **Code quality**: goes through an eight-party review, but in Alpha we still recommend you (or someone technical you trust) review before putting it into production

---

*Questions or suggestions? Open an Issue on this repository.*
