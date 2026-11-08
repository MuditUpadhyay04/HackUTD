@echo off
rem Builds the PS app with Vitis (headless). Log: deploy\vitis.log
set V=C:\AMDDesignTools\2026.1\Vitis\bin
set R=%~dp0..
set WS=%R%\..\vws2
set EXTRA_SW_REPO=%R%\..\eswfix
call "%V%\vitis.bat" -s "%R%\deploy\vitis_build.py" "%WS%" "C:\vb2\eclypse_mul.xsa" "%R%\ps\udp_mul.c" > "%R%\deploy\vitis.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\deploy\vitis.log"
