@echo off
echo =======================================================
echo   CrossDrop - Export mkcert Root CA for Android Phone
echo =======================================================
echo.

where mkcert >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] mkcert is not yet installed on PATH.
    echo.
    echo To install mkcert, open PowerShell and run:
    echo   winget install FiloSottile.mkcert
    echo   mkcert -install
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('mkcert -CAROOT') do set CAROOT=%%i

if not exist "%CAROOT%\rootCA.pem" (
    echo [!] Could not find rootCA.pem in %CAROOT%.
    echo Running 'mkcert -install' first...
    mkcert -install
)

if exist "%CAROOT%\rootCA.pem" (
    copy "%CAROOT%\rootCA.pem" "%~dp0..\rootCA.crt" >nul
    echo.
    echo [SUCCESS] Root CA exported to:
    echo   %~dp0..\rootCA.crt
    echo.
    echo Send this 'rootCA.crt' file to your Android phone (via email, USB, or Google Drive),
    echo then on your phone go to:
    echo   Settings > Security > Encryption & credentials > Install a certificate > CA certificate
    echo and select 'rootCA.crt'.
    echo.
) else (
    echo [ERROR] rootCA.pem not found in %CAROOT%.
)

pause
