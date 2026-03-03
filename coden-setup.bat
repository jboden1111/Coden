@echo off
echo ========================================
echo CODEN Setup - File Association Installer
echo ========================================
echo.

:: Ensure script is run as Administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo This setup must be run as Administrator.
    echo Right-click this file and choose "Run as administrator".
    echo.
    pause
    exit /b 1
)

:: Set installation directory
set "CODEN_DIR=C:\Mine\Coden"
set "LAUNCHER=%CODEN_DIR%\coden-open.cmd"

:: Check if launcher exists
if not exist "%LAUNCHER%" (
    echo ERROR:
    echo Could not find %LAUNCHER%
    echo.
    echo Make sure you copied coden.mjs and coden-open.cmd into C:\Mine\Coden
    echo before running this setup.
    echo.
    pause
    exit /b 1
)

echo Registering .coden file extension...
assoc .coden=CodenFile

echo Setting open command...
ftype CodenFile="%LAUNCHER%" "%%1"

echo.
echo ========================================
echo Setup complete!
echo.
echo You can now double-click any .coden file
echo to start a CODEN topic session.
echo ========================================
echo.

pause
