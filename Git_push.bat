@echo off
setlocal

REM Ensure this is a git repository
for /f %%i in ('git rev-parse --is-inside-work-tree 2^>nul') do set INSIDE_REPO=%%i
if /i not "%INSIDE_REPO%"=="true" (
  echo [ERROR] This folder is not a git repository.
  pause
  exit /b 1
)

REM Detect current branch
for /f %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set BRANCH=%%b
if "%BRANCH%"=="" (
  echo [ERROR] Could not detect current git branch.
  pause
  exit /b 1
)

set /p COMMIT_MSG=Enter commit comment: 
if "%COMMIT_MSG%"=="" (
  echo [ERROR] Commit comment cannot be empty.
  pause
  exit /b 1
)

echo.
echo Staging all changes...
git add -A
if errorlevel 1 (
  echo [ERROR] git add failed.
  pause
  exit /b 1
)

echo Committing...
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
  echo [INFO] No new changes to commit, or commit failed.
)

echo.
echo Pushing to origin/%BRANCH%...
git push origin %BRANCH%
if errorlevel 1 (
  echo [ERROR] Push failed.
  pause
  exit /b 1
)

echo.
echo Syncing with origin/%BRANCH% (pull --rebase)...
git pull --rebase origin %BRANCH%
if errorlevel 1 (
  echo [ERROR] Sync failed. Resolve conflicts if any, then retry.
  pause
  exit /b 1
)

echo.
echo Done. Changes pushed and synced on origin/%BRANCH%.
pause
exit /b 0