@echo off
set R=%~dp0..
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%R%\deploy\uart_capture.ps1" 45
timeout /t 6 /nobreak > nul
call "%R%\deploy\win_deploy.bat"
timeout /t 12 /nobreak > nul
call "%R%\deploy\win_verify.bat"
