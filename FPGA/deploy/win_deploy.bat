@echo off
rem JTAG: program PL, init PS, run ELF. Log: deploy\xsdb.log
set V=C:\AMDDesignTools\2026.1\Vitis\bin
set R=%~dp0..
rem Vitis workspaces and the BOM-fixed lwIP repo live next to the old hackutd-fpga-link checkout on
rem lucaslegion (%USERPROFILE%\hackutd); override with HUTD_WORK.
if not defined HUTD_WORK if exist "%R%\..\vws2" set "HUTD_WORK=%R%\.."
if not defined HUTD_WORK set "HUTD_WORK=%USERPROFILE%\hackutd"
set WS=%HUTD_WORK%\vws2
call "%V%\xsdb.bat" "%R%\deploy\xsdb_deploy.tcl" "C:/vb2/eclypse_mul.bit" "%WS%/out/ps7_init.tcl" "%WS%/out/mul_app.elf" > "%R%\deploy\xsdb.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\deploy\xsdb.log"
