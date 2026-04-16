@echo off
title Cartel Burgers - Starting...
color 0A

:: Check setup has been done
if not exist .env (
    echo  [!] Setup has not been run yet.
    echo      Please run SETUP.bat first.
    echo.
    pause
    exit
)

if not exist node_modules (
    echo  [!] Packages not installed.
    echo      Please run SETUP.bat first.
    echo.
    pause
    exit
)

echo.
echo  Starting Cartel Burgers system...
echo.

:: Start the API server in a new window
start "Cartel Server" cmd /k "color 0A && echo  [SERVER] Starting POS server... && node server.js"

:: Wait 3 seconds for server to be up before starting notifier
timeout /t 3 /nobreak >nul

:: Start the WhatsApp notifier in a new window
start "Cartel WhatsApp Notifier" cmd /k "color 0B && echo  [NOTIFIER] Starting WhatsApp notifier... && node whatsapp.js"

:: Wait 2 seconds then open browser
timeout /t 2 /nobreak >nul
start http://localhost:5000

echo.
echo  ========================================
echo    System is running!
echo.
echo    Admin panel: http://localhost:5000
echo.
echo    - Check the GREEN window for server logs
echo    - Check the BLUE window for WhatsApp notifier
echo    - Scan the QR code if the notifier asks for login
echo    - Use the Inventory tab to manage stock
echo    - Receipts can be printed from the POS
echo.
echo    To STOP: close both windows.
echo  ========================================
echo.
pause
