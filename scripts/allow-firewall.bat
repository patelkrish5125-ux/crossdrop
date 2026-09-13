@echo off
echo =======================================================
echo   CrossDrop - Allow Windows Firewall for Ports 3000 & 4000
echo =======================================================
echo.
echo Requesting administrator privileges...
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Please right-click this script and select "Run as administrator".
    pause
    exit /b 1
)

echo Adding inbound firewall rule for TCP ports 3000 and 4000...
netsh advfirewall firewall delete rule name="CrossDrop Local Dev (3000, 4000)" >nul 2>&1
netsh advfirewall firewall add rule name="CrossDrop Local Dev (3000, 4000)" dir=in action=allow protocol=TCP localport=3000,4000

echo.
echo [SUCCESS] Firewall rule added! Your phone can now connect to port 3000 over Wi-Fi.
echo.
pause
