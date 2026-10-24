@echo off
echo ================================
echo    P2P Chat - Quick Start
echo ================================
echo.

REM Check if node is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed!
    echo.
    echo Please install Node.js first:
    echo   1. Go to https://nodejs.org
    echo   2. Download the LTS version
    echo   3. Run the installer
    echo   4. Restart this script
    echo.
    pause
    exit /b 1
)

echo Node.js found: 
node --version
echo.

if not exist node_modules (
    echo [1/2] First run - Installing dependencies...
    echo This may take a few minutes...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
) else (
    echo [1/2] Dependencies already installed
)

echo.
echo [2/2] Starting P2P Chat...
echo.
echo ================================
echo Press Ctrl+C to stop the app
echo ================================
echo.

npm start
