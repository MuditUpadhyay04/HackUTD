@echo off
rem Zynq die temperature (XADC over JTAG, read-only: never programs the board). Double-click; it samples every 10 s for
rem 5 min by default ("win_board_temp.bat 360" = 1 h). Needs Vivado and the board's USB (JTAG) cable.
rem Output in this window and in board_temp.log next to this file.
if not defined VIVADO_BIN set "VIVADO_BIN=C:\AMDDesignTools\2026.1\Vivado\bin"
set N=%1
if "%N%"=="" set N=30
call "%VIVADO_BIN%\vivado.bat" -mode batch -nolog -nojournal -source "%~dp0board_temp.tcl" -tclargs %N% 10
pause
