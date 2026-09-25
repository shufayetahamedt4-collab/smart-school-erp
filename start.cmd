@echo off
rem ============================================================
rem  Amar E School - double-click this to start the app.
rem  It opens http://localhost:3000 in your browser.
rem  Close it again with stop.cmd.
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Double-click install.cmd first
  echo   ^(or get Node.js from https://nodejs.org^).
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\launch.mjs" %*
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo   The app did not start ^(code %CODE%^). If it was never installed,
  echo   double-click install.cmd. Otherwise the messages above say why,
  echo   and app.log holds the server output.
) else (
  echo   The app is running in the background. Use stop.cmd to shut it down.
)
echo.
pause
endlocal
