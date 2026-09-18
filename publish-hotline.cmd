@echo off
REM ============================================================
REM  Deploy the hotline (beige) page to Cloudflare Pages
REM
REM  Why this wrapper exists:
REM    wrangler 4 requires Node >= 22.12, but the system Node is 20.11.1
REM    (better-sqlite3 native module is bound to that ABI, so we must not
REM    upgrade the system Node). This script uses a portable Node 22 only
REM    for wrangler, leaving the system environment untouched.
REM
REM  Usage: double-click this file, or run publish-hotline.cmd
REM  First run opens a browser to log in to Cloudflare (one time only).
REM ============================================================
setlocal
set "NODE22=C:\waam-tools\node-v22.23.2-win-x64"
if not exist "%NODE22%\node.exe" (
  echo [ERROR] portable Node 22 not found at: %NODE22%
  echo         download https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip
  echo         and extract it under C:\waam-tools\
  pause
  exit /b 1
)

set "PATH=%NODE22%;%PATH%"
cd /d "%~dp0"

echo.
echo === [1/2] Cloudflare login status ===
call npx wrangler whoami
echo.
echo === [2/2] deploy hotline page to waam-web (www.whatspph.com) ===
call node scripts\publish-template.js hotline
echo.
echo exit code: %errorlevel%
pause
