@echo off
rem UDP smoke test against the board. Log: deploy\verify.log
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
"%PY%" "%R%\deploy\fpga.py" verify --wait 45 > "%R%\deploy\verify.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\deploy\verify.log"
