@echo off
rem One-time set-up for the combined test (ml/COMBINED_TEST.md) on Windows: Bun, the workspace packages, and a
rem Nemotron check. Run it from a FULL snapshot of the repo at main (the agents live in apps\api), by double-clicking.
rem The Nemotron key goes in <repo>\.env by hand (Mudit or Jason gives it); this script never prints it.
rem Log: <this folder>\agents_setup.log
set "ML=%~dp0"
set "ROOT=%~dp0.."
set "LOG=%~dp0agents_setup.log"
echo agents setup %DATE% %TIME% > "%LOG%"

if not exist "%USERPROFILE%\.bun\bin\bun.exe" (
  echo installing Bun >> "%LOG%"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" >> "%LOG%" 2>&1
)
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
bun --version >> "%LOG%" 2>&1 || ( echo FAIL: bun not available >> "%LOG%" & goto :end )

echo bun install >> "%LOG%"
pushd "%ROOT%"
bun install >> "%LOG%" 2>&1
if errorlevel 1 ( echo FAIL: bun install - use the store-and-forward path, win_combined_suite_board.bat >> "%LOG%" & popd & goto :end )
popd

if not exist "%ROOT%\.env" ( echo FAIL: create %ROOT%\.env with NVIDIA_BASE_URL, NEMOTRON_MODEL, NVIDIA_API_KEY - see ml\COMBINED_TEST.md >> "%LOG%" & goto :end )
set "NB="
set "NK="
for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%\.env") do (
  if "%%A"=="NVIDIA_BASE_URL" set "NB=%%B"
  if "%%A"=="NVIDIA_API_KEY" set "NK=%%B"
)
if not defined NK ( echo FAIL: NVIDIA_API_KEY missing in .env >> "%LOG%" & goto :end )
echo Nemotron check (expect the model list): >> "%LOG%"
curl -s -A hutd-check -H "Authorization: Bearer %NK%" "%NB%/models" >> "%LOG%" 2>&1
echo. >> "%LOG%"
echo OK: setup done; next double-click win_combined_suite.bat >> "%LOG%"

:end
set "NK="
echo END %TIME% >> "%LOG%"
