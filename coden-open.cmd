@echo off
setlocal

set "CODEN_FILE=%~1"
if "%CODEN_FILE%"=="" (
  echo No .coden file provided.
  exit /b 1
)

REM Run the Node wrapper, passing the clicked file path
node "C:\Mine\Coden\coden.mjs" "%CODEN_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo CODEN session exited with error code %EXIT_CODE%.
  pause
)

endlocal & exit /b %EXIT_CODE%
