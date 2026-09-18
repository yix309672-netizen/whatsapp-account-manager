@echo off
REM One-time Cloudflare login. Opens a browser; click Allow.
REM The credential is stored locally, so later deploys need no login.
setlocal
set "NODE22=C:\waam-tools\node-v22.23.2-win-x64"
if not exist "%NODE22%\node.exe" (
  echo [ERROR] portable Node 22 not found at: %NODE22%
  pause
  exit /b 1
)
set "PATH=%NODE22%;%PATH%"
cd /d "%~dp0"

echo === Cloudflare login ===
call npx wrangler login
echo.
echo exit code: %errorlevel%
echo.
echo After login, run publish-hotline.cmd to deploy the hotline page.
pause
