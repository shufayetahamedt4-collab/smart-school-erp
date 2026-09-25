@echo off
rem ============================================================
rem  Amar E School - double-click this to stop the app.
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not installed, so this app could not be running.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\stop.mjs" %*
echo.
pause
endlocal
