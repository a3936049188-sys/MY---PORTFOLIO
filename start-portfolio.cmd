@echo off
cd /d "%~dp0"

powershell.exe -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
    start "" "http://localhost:3000"
    exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is required. Install Node.js and try again.
    pause
    exit /b 1
)

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 900; Start-Process 'http://localhost:3000'"
node server.js

if errorlevel 1 (
    echo.
    echo The app server stopped with an error.
    pause
)
