@echo off
rem Builds BOOT.BIN (FSBL + 50 MHz bitstream + eog_app.elf) and stages weights.eog (Mudit's v4) next to it.
rem Usage: win_make_sd.bat [drive]   e.g. win_make_sd.bat E  -> also copies BOOT.BIN + weights.eog to E:\
rem Needs deploy\win_vitis_build_eog.bat run first. Log: deploy\make_boot_sd.log
set R=%~dp0..
if not defined HUTD_WORK set "HUTD_WORK=%USERPROFILE%\hackutd"
if not defined HUTD_ML set "HUTD_ML=%USERPROFILE%\hackutd\ml_main_846463e\ml"
set "EOG_OUT=%HUTD_WORK%\vws_eog\out"
copy /y "%HUTD_ML%\artifacts\v4\weights.eog" "%EOG_OUT%\weights.eog" > nul
call "%R%\deploy\make_boot_sd.bat" %1
