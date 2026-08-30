@echo off
chcp 65001
title MC-MultiLogin Service
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js v21 or newer from https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] First run: installing dependencies via npm install...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies. Please check your network and retry.
        pause
        exit /b 1
    )
)

echo [INFO] Starting MC-MultiLogin service...
echo [INFO] Ports and methods are configured in config\config.json. Management panel: manage_port + manage_url
echo.
node src/index.js
echo.
echo [INFO] Service stopped.
pause
