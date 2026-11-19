@echo off
rem Ping the board, capture UART for 75 s while redeploying, then retry the UDP check.
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
ping -n 3 192.168.1.10 > "%R%\deploy\ping.log" 2>&1
arp -a >> "%R%\deploy\ping.log" 2>&1
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%R%\deploy\uart_capture.ps1" 75
timeout /t 6 /nobreak > nul
call "%R%\deploy\win_deploy.bat"
timeout /t 40 /nobreak > nul
ping -n 3 192.168.1.10 >> "%R%\deploy\ping.log" 2>&1
call "%R%\deploy\win_verify.bat"
