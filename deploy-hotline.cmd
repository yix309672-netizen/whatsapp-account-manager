@echo off
REM ============================================================
REM  Deploy the hotline page to Cloudflare Pages via API token.
REM
REM  Requires .cf-token in this folder (line 1: API token,
REM  line 2: optional account id). See .cf-token.example.
REM
REM  No browser login needed, no wrangler needed, works on Node 20+.
REM ============================================================
setlocal
set "NODE22=C:\waam-tools\node-v22.23.2-win-x64"
if exist "%NODE22%\node.exe" (
  set "PATH=%NODE22%;%PATH%"
)
cd /d "%~dp0"

echo === deploying hotline-dist -> waam-web ===
node scripts\cf-pages-deploy.js hotline-dist waam-web main
echo.
echo exit code: %errorlevel%
pause
