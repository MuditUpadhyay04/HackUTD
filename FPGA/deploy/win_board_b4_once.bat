@echo off
rem One B4 run (v4 g1 --heartbeat-test 6) on a freshly programmed board, UART captured.
rem Results copied to FPGA\build\b4exp\ (summary b4exp\summary.txt, uart.txt).
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
if not defined HUTD_ML set "HUTD_ML=%USERPROFILE%\hackutd\ml_f07ae06\ml"
set O=%R%\build\b4exp
if not exist "%O%" mkdir "%O%"
set G=artifacts\v4\golden\g1
echo b4 once %DATE% %TIME% > "%O%\summary.txt"
call "%R%\deploy\win_deploy_eog.bat"
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%R%\deploy\uart_capture.ps1" 75
timeout /t 8 /nobreak > nul
set /a TRIES=0
:waitping
ping -n 1 -w 1000 192.168.1.10 | find "TTL=" > nul
if not errorlevel 1 goto :up
set /a TRIES+=1
if %TRIES% GEQ 60 ( echo board not reachable >> "%O%\summary.txt" & exit /b )
goto :waitping
:up
timeout /t 5 /nobreak > nul
pushd "%HUTD_ML%"
"%PY%" -m hutd_ml.board --golden %G% --heartbeat-test 6 --wait 30 > "%O%\b4.log" 2>&1
if errorlevel 1 ( echo B4 FAIL %TIME% >> "%O%\summary.txt" ) else ( echo B4 PASS %TIME% >> "%O%\summary.txt" )
copy /y "%G%\board_run\*" "%O%\" > nul
popd
timeout /t 40 /nobreak > nul
copy /y "%R%\deploy\uart.log" "%O%\uart.txt" > nul
echo END %TIME% >> "%O%\summary.txt"
