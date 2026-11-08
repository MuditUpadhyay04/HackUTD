@echo off
rem Builds the EOG engine PS app (ps\eog_app.c + eog_proto + udp_mul on 7777) with Vitis. Log: deploy\vitis_eog.log
rem XSA: the T2.bd1 design with eog_top at 0x43C10000 (set EOG_XSA). Separate workspace from the mul-only build.
set V=C:\AMDDesignTools\2026.1\Vitis\bin
set R=%~dp0..
set WS=%R%\..\vws_eog
set EXTRA_SW_REPO=%R%\..\eswfix
if "%EOG_XSA%"=="" set EOG_XSA=C:\vb2\eclypse_eog.xsa
call "%V%\vitis.bat" -s "%R%\deploy\vitis_build.py" "%WS%" "%EOG_XSA%" "%R%\ps\eog_app.c" "%R%\ps\eog_proto.c" "%R%\ps\eog_proto.h" "%R%\ps\udp_mul.c" > "%R%\deploy\vitis_eog.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\deploy\vitis_eog.log"
