@echo off
title Cartel Burgers - First Time Setup
color 0A

echo.
echo  ========================================
echo    CARTEL BURGERS - First Time Setup
echo  ========================================
echo.

:: Check Node.js
node -v >nul 2>&1
if errorlevel 1 (
    echo  [!] Node.js is not installed.
    echo.
    echo  Please install it from: https://nodejs.org
    echo  Download the "LTS" version, install it, then run this file again.
    echo.
    pause
    start https://nodejs.org
    exit
)
echo  [OK] Node.js found.

:: Install packages
echo.
echo  Installing packages (this may take a minute)...
call npm install
if errorlevel 1 (
    echo.
    echo  [!] npm install failed. Check your internet connection and try again.
    pause
    exit
)
echo  [OK] Packages installed.

:: Create .env if missing
if exist .env (
    echo  [OK] .env already exists, skipping.
) else (
    echo.
    echo  ========================================
    echo    Let's set up your configuration
    echo  ========================================
    echo.

    set /p MONGO="  Paste your MongoDB URI: "
    set /p PASS="  Choose an admin panel password: "

    :: Generate a random JWT secret from Node
    for /f %%i in ('node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"') do set JWTSECRET=%%i

    (
        echo MONGO_URI=%MONGO%
        echo ADMIN_PASSWORD=%PASS%
        echo JWT_SECRET=%JWTSECRET%
        echo CORS_ORIGIN=http://localhost:5000
    ) > .env

    echo.
    echo  [OK] .env file created.
)

echo.
echo  ========================================
echo    Setup complete!
echo    Run START.bat to launch the system.
echo  ========================================
echo.
pause
