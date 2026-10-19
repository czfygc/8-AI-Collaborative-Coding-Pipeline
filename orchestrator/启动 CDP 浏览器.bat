@echo off
rem TITAN CDP browser launcher (four-party consult)
rem --user-data-dir is PERSISTENT: keeps reviewer logins + Cloudflare verification state across restarts.
rem If Chrome is already running with this profile, this launch is a no-op for the existing instance.
rem Chrome 路径走 %LOCALAPPDATA%（脱敏：不再硬编码本机用户名绝对路径；如需自定义设 CHROME_EXE）
if not defined CHROME_EXE set "CHROME_EXE=%LOCALAPPDATA%\ms-playwright\chromium-1243\chrome-win64\chrome.exe"
start "" "%CHROME_EXE%" ^
  --remote-debugging-port=9222 ^
  --remote-debugging-address=127.0.0.1 ^
  --user-data-dir=D:\TITAN_ARCHAEOLOGY\chrome-cdp-profile ^
  --no-first-run ^
  --no-default-browser-check
echo CDP browser launching on 127.0.0.1:9222 (profile: chrome-cdp-profile)