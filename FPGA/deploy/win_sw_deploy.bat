@echo off
rem Rebuild PS app, deploy over JTAG (capturing UART), then UDP check. Logs in deploy\.
set R=%~dp0..
call "%R%\deploy\win_vitis_build.bat"
findstr /c:"vitis_build: BUILD_OK" "%R%\deploy\vitis.log" > nul || (echo SW_BUILD_FAILED > "%R%\deploy\verify.log" & exit /b 1)
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%R%\deploy\uart_capture.ps1" 45
timeout /t 6 /nobreak > nul
call "%R%\deploy\win_deploy.bat"
timeout /t 12 /nobreak > nul
call "%R%\deploy\win_verify.bat"
