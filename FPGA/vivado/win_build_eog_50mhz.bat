@echo off
rem Bring-up build at FCLK0 = 50 MHz (the 100 MHz build misses timing in eog_validate). Same outputs as win_build_eog.bat.
call "%~dp0win_build_eog.bat" mhz50
