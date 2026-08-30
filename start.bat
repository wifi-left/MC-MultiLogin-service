@echo off
chcp 65001 >nul
title MC-MultiLogin Service
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 未检测到 Node.js，请先安装 Node.js v21 或更高版本：https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] 首次运行，正在安装依赖（npm install）...
    call npm install
    if errorlevel 1 (
        echo [ERROR] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

echo [INFO] 正在启动 MC-MultiLogin 服务...
echo [INFO] 端口与子配置见 config\config.json（管理面板：manage_port + manage_url）
echo.
node src/index.js
echo.
echo [INFO] 服务已停止。
pause
