@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_node
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=15)?0:1)"
if errorlevel 1 goto missing_node
pushd "%~dp0sites\inspection-platform"
if errorlevel 1 exit /b 1
if not exist "node_modules\.package-lock.json" (
  call npm ci
  if errorlevel 1 goto failed
)
call npm run setup:local
if errorlevel 1 goto failed
echo.
echo Open http://127.0.0.1:5317/ in your browser.
echo Keep this window open. Press Ctrl+C to stop the platform.
call npm run serve
set "PLATFORM_EXIT=%ERRORLEVEL%"
popd
exit /b %PLATFORM_EXIT%
:missing_node
echo Please install Node.js 22.15 or newer with npm, then run this file again.
pause
exit /b 1
:failed
echo Startup failed. Read the error above before retrying.
popd
pause
exit /b 1
