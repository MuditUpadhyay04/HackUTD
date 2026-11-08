@echo off
rem Builds the EOG engine PS app (ps\eog_app.c + eog_proto + udp_mul on 7777) with Vitis. Log: deploy\vitis_eog.log
rem XSA: the T2.bd1 design with eog_top at 0x43C10000 (set EOG_XSA). Separate workspace from the mul-only build.
set V=C:\AMDDesignTools\2026.1\Vitis\bin
set R=%~dp0..
rem Vitis workspaces and the BOM-fixed lwIP repo live next to the old hackutd-fpga-link checkout on
rem lucaslegion (%USERPROFILE%\hackutd); override with HUTD_WORK.
if not defined HUTD_WORK if exist "%R%\..\vws2" set "HUTD_WORK=%R%\.."
if not defined HUTD_WORK set "HUTD_WORK=%USERPROFILE%\hackutd"
set WS=%HUTD_WORK%\vws_eog
rem Re-apply the BSP settings (lwIP sizes) on every build, also for an existing workspace.
set VITIS_RECONFIG=1
set EXTRA_SW_REPO=%HUTD_WORK%\eswfix
if "%EOG_XSA%"=="" set EOG_XSA=C:\vb2\eclypse_eog.xsa
call "%V%\vitis.bat" -s "%R%\deploy\vitis_build.py" "%WS%" "%EOG_XSA%" "%R%\ps\eog_app.c" "%R%\ps\eog_proto.c" "%R%\ps\eog_proto.h" "%R%\ps\udp_mul.c" > "%R%\deploy\vitis_eog.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\deploy\vitis_eog.log"
