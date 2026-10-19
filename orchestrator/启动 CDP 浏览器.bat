@echo off
rem 8-AI Collaborative Coding Pipeline - CDP browser launcher
rem Launches Chrome/Edge with remote debugging so the pipeline can drive the web-AI seats.
rem The profile folder (chrome-cdp-profile) is created next to this script and keeps your logins.
setlocal
set "PORT=9222"
set "PROFILE=%~dp0..\chrome-cdp-profile"
set "CHROME="
where chrome.exe >nul 2>nul && set "CHROME=chrome.exe"
if not defined CHROME (
  for %%P in (
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  ) do if exist "%%~P" set "CHROME=%%~P"
)
if not defined CHROME (
  echo Chrome or Edge not found. Install Chrome from https://www.google.com/chrome/ and re-run this script.
  pause
  exit /b 1
)
start "" "%CHROME%" --remote-debugging-port=%PORT% --remote-debugging-address=127.0.0.1 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check
echo CDP browser launching on 127.0.0.1:%PORT% (profile: %PROFILE%)
endlocal
