@echo off
rem Debug: B1 (v4 g0 --weights-negative) on a freshly programmed board with the UART captured (deploy\uart.log).
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
if not defined HUTD_ML set "HUTD_ML=%USERPROFILE%\hackutd\ml_f07ae06\ml"
call "%R%\deploy\win_deploy_eog.bat"
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%R%\deploy\uart_capture.ps1" 60
timeout /t 15 /nobreak > nul
pushd "%HUTD_ML%"
"%PY%" -m hutd_ml.board --golden artifacts\v4\golden\g0 --weights-negative > "%R%\build\board_B1_debug.log" 2>&1
popd
echo EXIT %ERRORLEVEL% >> "%R%\build\board_B1_debug.log"
