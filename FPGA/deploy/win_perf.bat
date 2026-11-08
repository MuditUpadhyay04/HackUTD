@echo off
rem Rebuild + deploy the PS app (with the UDP perf probe), then run the receive-ceiling test.
rem Logs: deploy\vitis.log, deploy\uart.log, deploy\verify.log, deploy\perf.log
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
echo PERF_START > "%R%\deploy\perf.log"
call "%R%\deploy\win_sw_deploy.bat"
findstr /c:"EXIT 0" "%R%\deploy\verify.log" > nul || (echo DEPLOY_OR_VERIFY_FAILED >> "%R%\deploy\perf.log" & exit /b 1)
"%PY%" "%R%\deploy\udp_perf.py" %* >> "%R%\deploy\perf.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\deploy\perf.log"
