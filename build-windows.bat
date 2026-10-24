@echo off
echo ================================
echo    P2P Chat - Build Script
echo ================================
echo.

REM Check if node is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/3] Building Windows installer...
call npm run build:win
if %ERRORLEVEL% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

echo.
echo [3/3] Done!
echo.
echo ================================
echo Installers are in the dist\ folder:
echo.
dir /b dist\*.exe 2>nul
echo ================================
echo.
echo Share these files with your friends!
pause
