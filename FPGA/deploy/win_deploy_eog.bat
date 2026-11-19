@echo off
rem JTAG: program PL (EOG design), init PS, run the EOG app ELF. Log: deploy\xsdb_eog.log
set V=C:\AMDDesignTools\2026.1\Vitis\bin
set R=%~dp0..
rem Vitis workspaces and the BOM-fixed lwIP repo live next to the old hackutd-fpga-link checkout on
rem lucaslegion (%USERPROFILE%\hackutd); override with HUTD_WORK.
if not defined HUTD_WORK if exist "%R%\..\vws2" set "HUTD_WORK=%R%\.."
if not defined HUTD_WORK set "HUTD_WORK=%USERPROFILE%\hackutd"
set WS=%HUTD_WORK%\vws_eog
call "%V%\xsdb.bat" "%R%\deploy\xsdb_deploy.tcl" "C:/vb2/eclypse_eog.bit" "%WS%/out/ps7_init.tcl" "%WS%/out/mul_app.elf" > "%R%\deploy\xsdb_eog.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\deploy\xsdb_eog.log"
