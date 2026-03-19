@echo off
setlocal

set "CODEN_FILE=%~1"
if "%CODEN_FILE%"=="" (
  echo No .coden file provided.
  exit /b 1
)

set "CODEN_FILE_ABS=%~f1"

if not exist "%CODEN_FILE_ABS%" (
  echo Could not find .coden file:
  echo %CODEN_FILE_ABS%
  exit /b 1
)

REM Run the Node wrapper, passing the clicked file path
node "%~dp0coden.mjs" "%CODEN_FILE_ABS%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo CODEN session exited with error code %EXIT_CODE%.
  pause
)

endlocal & exit /b %EXIT_CODE%
