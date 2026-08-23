@echo off
setlocal

set "WEB_DIR=%~dp0web"
set "AGENT_DIR=%~dp0canvas-agent"
set "RUNTIME_DIR=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies"
set "NODE_EXE=%RUNTIME_DIR%\node\bin\node.exe"
set "PNPM_CMD=%RUNTIME_DIR%\bin\fallback\pnpm.cmd"
set "VITE_JS=%WEB_DIR%\node_modules\vite\bin\vite.js"
set "AGENT_ENTRY=%AGENT_DIR%\dist\index.js"
set "CANVAS_URL=http://127.0.0.1:3000/"
set "AGENT_HEALTH_URL=http://127.0.0.1:17371/health"

if not exist "%WEB_DIR%\package.json" goto project_missing
if not exist "%NODE_EXE%" goto node_missing
if not exist "%AGENT_ENTRY%" goto agent_missing

call :ensure_agent
if errorlevel 1 goto agent_start_failed

call :check_server
if not errorlevel 1 goto already_running

if not exist "%VITE_JS%" (
    if not exist "%PNPM_CMD%" goto pnpm_missing
    echo [Infinite Canvas] Installing dependencies for the first run...
    set "PATH=%RUNTIME_DIR%\node\bin;%PATH%"
    call "%PNPM_CMD%" install --dir "%WEB_DIR%" --lockfile=false
    if not exist "%VITE_JS%" goto install_failed
)

echo [Infinite Canvas] Starting local server...
start "Infinite Canvas Server" /D "%WEB_DIR%" "%NODE_EXE%" "%VITE_JS%" --host 127.0.0.1 --port 3000

for /l %%I in (1,1,20) do (
    call :check_server
    if not errorlevel 1 goto ready
    timeout /t 1 /nobreak >nul
)
goto start_failed

:ready
echo [Infinite Canvas] Started successfully: %CANVAS_URL%
if /i not "%INFINITE_CANVAS_NO_BROWSER%"=="1" start "" "%CANVAS_URL%"
exit /b 0

:already_running
echo [Infinite Canvas] Server is already running: %CANVAS_URL%
if /i not "%INFINITE_CANVAS_NO_BROWSER%"=="1" start "" "%CANVAS_URL%"
exit /b 0

:check_server
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri '%CANVAS_URL%' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%

:ensure_agent
call :check_agent
if not errorlevel 1 exit /b 0
echo [Infinite Canvas] Starting local Canvas Agent...
start "Infinite Canvas Agent" /D "%AGENT_DIR%" "%NODE_EXE%" "%AGENT_ENTRY%"
for /l %%I in (1,1,20) do (
    call :check_agent
    if not errorlevel 1 exit /b 0
    timeout /t 1 /nobreak >nul
)
exit /b 1

:check_agent
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $response = Invoke-RestMethod -Uri '%AGENT_HEALTH_URL%' -TimeoutSec 2; if ($response.ok) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%

:project_missing
echo [Infinite Canvas] Project directory was not found: %WEB_DIR%
goto failed

:node_missing
echo [Infinite Canvas] Codex Node.js was not found: %NODE_EXE%
echo Open Codex and ask it to start the local Infinite Canvas.
goto failed

:agent_missing
echo [Infinite Canvas] Local Canvas Agent build was not found: %AGENT_ENTRY%
echo Rebuild canvas-agent before starting Infinite Canvas.
goto failed

:pnpm_missing
echo [Infinite Canvas] pnpm was not found: %PNPM_CMD%
goto failed

:install_failed
echo [Infinite Canvas] Dependency installation failed. Check the network and retry.
goto failed

:start_failed
echo [Infinite Canvas] The server did not start within 20 seconds.
echo Check the newly opened server window for details.
goto failed

:agent_start_failed
echo [Infinite Canvas] Canvas Agent did not start within 20 seconds.
echo Check the newly opened Agent window for details.

:failed
pause
exit /b 1
