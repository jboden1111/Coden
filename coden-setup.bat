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

:: Set installation directory relative to this setup script
set "CODEN_DIR=%~dp0"
if "%CODEN_DIR:~-1%"=="\" set "CODEN_DIR=%CODEN_DIR:~0,-1%"
set "LAUNCHER=%CODEN_DIR%\coden-open.cmd"

:: Check if launcher exists
if not exist "%LAUNCHER%" (
    echo ERROR:
    echo Could not find %LAUNCHER%
    echo.
    echo Make sure you copied coden.mjs and coden-open.cmd into:
    echo %CODEN_DIR%
    echo before running this setup.
    echo.
    pause
    exit /b 1
)

echo Registering .coden file extension...
assoc .coden=CodenFile

echo Setting open command...
ftype CodenFile="%LAUNCHER%" "%%1"

echo Adding Explorer admin command...
reg delete "HKCR\CodenFile\shell\runas_coden" /f >nul 2>&1
reg add "HKCR\CodenFile\shell\runas" /ve /d "Run Coden as administrator" /f >nul
reg add "HKCR\CodenFile\shell\runas" /v "HasLUAShield" /t REG_SZ /d "" /f >nul
reg add "HKCR\CodenFile\shell\runas\command" /ve /d "\"%SystemRoot%\System32\cmd.exe\" /d /s /c \"\"%LAUNCHER%\" \"%%L\"\"" /f >nul

echo.
echo ========================================
echo Setup complete!
echo.
echo You can now double-click any .coden file
echo to start a CODEN topic session.
echo Right-click a .coden file and choose
echo "Run Coden as administrator" when needed.
echo ========================================
echo.

pause
