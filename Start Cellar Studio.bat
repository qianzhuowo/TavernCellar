@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Cellar Studio

where node >nul 2>nul
if errorlevel 1 (
    echo 未找到 Node.js。请先安装 Node.js 20 或更新版本：https://nodejs.org/
    echo 安装后重新双击本文件。
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 (
    echo 当前 Node.js 版本过旧：
    node -v
    echo 需要 Node.js 20 或更新版本：https://nodejs.org/
    pause
    exit /b 1
)

if not exist "companion\node_modules\ws\package.json" (
    echo 首次运行，正在安装伴侣程序依赖……
    pushd companion
    call npm install --omit=dev --no-audit --no-fund
    set "NPM_EXIT=%errorlevel%"
    popd
    if not "%NPM_EXIT%"=="0" (
        echo 依赖安装失败。请检查网络后重试。
        pause
        exit /b 1
    )
)

node companion\src\cli.js studio %*
if errorlevel 1 pause
