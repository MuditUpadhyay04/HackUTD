@echo off
rem Builds the PS app with Vitis (headless). Log: deploy\vitis.log
set V=C:\AMDDesignTools\2026.1\Vitis\bin
set R=%~dp0..
rem Vitis workspaces and the BOM-fixed lwIP repo live next to the old hackutd-fpga-link checkout on
rem lucaslegion (%USERPROFILE%\hackutd); override with HUTD_WORK.
if not defined HUTD_WORK if exist "%R%\..\vws2" set "HUTD_WORK=%R%\.."
if not defined HUTD_WORK set "HUTD_WORK=%USERPROFILE%\hackutd"
set WS=%HUTD_WORK%\vws2
set EXTRA_SW_REPO=%HUTD_WORK%\eswfix
call "%V%\vitis.bat" -s "%R%\deploy\vitis_build.py" "%WS%" "C:\vb2\eclypse_mul.xsa" "%R%\ps\udp_mul.c" > "%R%\deploy\vitis.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\deploy\vitis.log"
