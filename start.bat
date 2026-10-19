@echo off
setlocal
cd /d "%~dp0"
title OpenShelf - Media Server

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on PATH.
    echo Install it from https://nodejs.org  ^(LTS is fine^) and run start.bat again.
    pause
    exit /b 1
)

if not exist openshelf.config.json (
    echo.
    echo No openshelf.config.json found.
    echo Copy openshelf.config.example.json to openshelf.config.json, set your
    echo media folders in the "roots" list, then run start.bat again.
    echo For now, serving the current folder as the library root.
    echo.
)

rem Give the server a moment, then open the web UI in the default browser.
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8090'"

if exist openshelf.config.json (
    node server.js --config openshelf.config.json
) else (
    node server.js
)

echo.
echo OpenShelf stopped.
pause
endlocal
