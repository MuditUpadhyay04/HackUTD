@echo off
rem Full Vivado build of the EOG block design (axi_mul + eog_top). Usage: win_build_eog.bat [nobit]
rem Project/bit/xsa in C:\vb2; status + reports in FPGA\build\ (eog_status.txt, eog_*.rpt), log build\vivado_eog.log
set V=C:\AMDDesignTools\2026.1\Vivado\bin
set R=%~dp0..
if not exist "%R%\build" mkdir "%R%\build"
if not exist C:\vb2 mkdir C:\vb2
pushd C:\vb2
call "%V%\vivado.bat" -mode batch -source "%R%\vivado\build_eog.tcl" -log "%R%\build\vivado_eog.log" -journal "%R%\build\vivado_eog.jou" -tclargs C:/vb2 %*
echo EXIT %ERRORLEVEL% >> "%R%\build\eog_status.txt"
popd
