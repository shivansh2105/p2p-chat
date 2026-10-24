#!/bin/bash
echo "================================"
echo "   P2P Chat - Build Script"
echo "================================"
echo

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed!"
    echo "Please install Node.js from https://nodejs.org"
    exit 1
fi

echo "[1/3] Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install dependencies"
    exit 1
fi

echo
echo "[2/3] Building for current platform..."

# Detect OS
case "$(uname -s)" in
    Darwin*)
        npm run build:mac
        ;;
    Linux*)
        npm run build:linux
        ;;
    *)
        npm run build
        ;;
esac

if [ $? -ne 0 ]; then
    echo "ERROR: Build failed"
    exit 1
fi

echo
echo "[3/3] Done!"
echo
echo "================================"
echo "Installers are in the dist/ folder:"
ls -la dist/ 2>/dev/null | grep -E '\.(dmg|AppImage|deb|exe)$'
echo "================================"
echo
echo "Share these files with your friends!"
