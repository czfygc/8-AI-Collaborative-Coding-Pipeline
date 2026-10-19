# 启动 TITAN Telegram Bot（后台常驻）
# 密钥从 gitignored 的 titan_secrets.env 读取 —— 本脚本内不含任何密钥、不走命令行参数（M5）
# 用法：  powershell -File orchestrator\start-titan-bot.ps1
# 停止：  停掉 python 进程（bot 是单进程轮询，无子进程）
$ErrorActionPreference = 'Stop'

$repo      = Split-Path -Parent $PSScriptRoot          # orchestrator/ 的上级 = 仓库根
$secrets   = Join-Path $repo 'titan_secrets.env'
$botScript = Join-Path $PSScriptRoot 'titan_telegram_bot.py'
$logDir    = Join-Path $repo 'archive\evidence\tmp\t120-m4'
$outLog    = Join-Path $logDir 'bot-run.out.log'
$errLog    = Join-Path $logDir 'bot-run.err.log'
$py        = 'C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe'

if (-not (Test-Path -LiteralPath $secrets)) { throw "缺少密钥文件: $secrets" }
if (-not (Test-Path -LiteralPath $botScript)) { throw "缺少 bot 脚本: $botScript" }

# 从密钥文件装载环境变量（只取 KEY=VALUE，跳过注释与空行）
Get-Content -LiteralPath $secrets -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    $parts = $line -split '=', 2
    if ($parts.Count -eq 2 -and $parts[0].Trim() -ne '') {
        Set-Item -Path ("env:{0}" -f $parts[0].Trim()) -Value $parts[1]
    }
}

# 非密钥配置（明文无妨）
$env:TITAN_GATEWAY_URL       = 'http://127.0.0.1:5301/task'
# 换成你自己的 Telegram 用户 ID（见 USAGE_GUIDE 第 8 节第 3 步）。留占位符 = 全部拒绝，安全默认。
$env:TITAN_ALLOWED_USER_IDS  = '<YOUR_TELEGRAM_USER_ID>'
$env:PYTHONUNBUFFERED        = '1'   # 日志实时落盘，否则块缓冲会卡住观察不到

if (-not $env:TITAN_BOT_TOKEN) { throw "titan_secrets.env 缺少 TITAN_BOT_TOKEN" }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 已有实例先停掉，避免多实例抢 getUpdates（会互相推进 offset 丢消息）
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*titan_telegram_bot.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$proc = Start-Process -FilePath $py `
    -ArgumentList @($botScript) `
    -WorkingDirectory $repo `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError  $errLog `
    -WindowStyle Hidden `
    -PassThru

Write-Output ("[launcher] bot PID={0}" -f $proc.Id)
Write-Output ("[launcher] out={0}" -f $outLog)
Write-Output ("[launcher] err={0}" -f $errLog)