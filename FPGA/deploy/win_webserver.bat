@echo off
rem Starts the browser UI at http://127.0.0.1:8000 talking to the board at 192.168.1.10.
title FPGA link web server (close this window to stop)
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
cd /d "%R%\host"
"%PY%" server.py --board-ip 192.168.1.10
pause
