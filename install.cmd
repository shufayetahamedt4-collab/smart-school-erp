@echo off
rem ============================================================
rem  Amar E School - double-click this to install the app.
rem
rem  It runs scripts\install-windows.ps1, which checks Node.js,
rem  connects your Firebase project, installs everything, seeds
rem  the demo data and builds the app.
rem
rem  Nothing here needs Administrator rights.
rem ============================================================
setlocal
cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
  echo.
  echo   PowerShell was not found. This installer is for Windows.
  echo   On macOS or Linux, run:  npm ci ^&^& npm run setup ^&^& npm run build ^&^& npm run app
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo   Installer finished with errors ^(code %CODE%^). The messages above say why.
) else (
  echo   Done. Start the app any time with start.cmd, or the desktop shortcut.
)
echo.
pause
endlocal
