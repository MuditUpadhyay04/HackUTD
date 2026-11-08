@echo off
rem make_boot_sd.bat [drive] [weights.eog]
rem   Builds BOOT.BIN (FSBL + bitstream + eog_app.elf, deploy\eog_boot.bif) with bootgen and, if a drive letter is
rem   given, copies BOOT.BIN and weights.eog to the root of that (FAT32) microSD card. See FPGA/docs/SD_BOOT_WEIGHTS.md.
rem   Inputs come from deploy\win_vitis_build_eog.bat: %EOG_OUT% (default ..\vws_eog\out) holds fsbl.elf, eog.bit,
rem   eog_app.elf. weights.eog: the second argument, else %EOG_OUT%\weights.eog (make it with make_weights_sd.py).
rem   Examples:  make_boot_sd.bat            (BOOT.BIN only)
rem              make_boot_sd.bat E          (BOOT.BIN + %EOG_OUT%\weights.eog onto E:\)
rem              make_boot_sd.bat E C:\vb2\weights_v3.eog
rem   Log: deploy\make_boot_sd.log. Last line: BOOT_SD_OK or BOOT_SD_FAIL <reason>.
setlocal
set R=%~dp0..
set LOG=%R%\deploy\make_boot_sd.log
if "%EOG_OUT%"=="" set EOG_OUT=%R%\..\vws_eog\out
if "%VITIS_BIN%"=="" set VITIS_BIN=C:\AMDDesignTools\2026.1\Vitis\bin
set DRIVE=%~1
set WEIGHTS=%~2
if "%WEIGHTS%"=="" set WEIGHTS=%EOG_OUT%\weights.eog
echo make_boot_sd %DATE% %TIME% > "%LOG%"
echo out dir: %EOG_OUT% >> "%LOG%"

for %%F in (fsbl.elf eog.bit eog_app.elf) do (
    if not exist "%EOG_OUT%\%%F" (
        echo BOOT_SD_FAIL missing %EOG_OUT%\%%F: run deploy\win_vitis_build_eog.bat first >> "%LOG%"
        echo BOOT_SD_FAIL missing %EOG_OUT%\%%F: run deploy\win_vitis_build_eog.bat first
        exit /b 1
    )
)

rem bootgen: Vitis bin, else Vivado bin, else PATH
set BOOTGEN=
if exist "%VITIS_BIN%\bootgen.bat" set BOOTGEN=%VITIS_BIN%\bootgen.bat
if "%BOOTGEN%"=="" if exist "%VITIS_BIN%\bootgen.exe" set BOOTGEN=%VITIS_BIN%\bootgen.exe
if "%BOOTGEN%"=="" if exist "%VITIS_BIN%\..\..\Vivado\bin\bootgen.bat" set BOOTGEN=%VITIS_BIN%\..\..\Vivado\bin\bootgen.bat
if "%BOOTGEN%"=="" for /f "delims=" %%B in ('where bootgen 2^>nul') do if "%BOOTGEN%"=="" set BOOTGEN=%%B
if "%BOOTGEN%"=="" (
    echo BOOT_SD_FAIL bootgen not found: set VITIS_BIN to the Vitis bin folder >> "%LOG%"
    echo BOOT_SD_FAIL bootgen not found: set VITIS_BIN to the Vitis bin folder
    exit /b 1
)
echo bootgen: %BOOTGEN% >> "%LOG%"

copy /y "%R%\deploy\eog_boot.bif" "%EOG_OUT%\eog_boot.bif" > nul
if exist "%EOG_OUT%\BOOT.BIN" del "%EOG_OUT%\BOOT.BIN"
pushd "%EOG_OUT%"
call "%BOOTGEN%" -arch zynq -image eog_boot.bif -o BOOT.BIN -w on >> "%LOG%" 2>&1
popd
if not exist "%EOG_OUT%\BOOT.BIN" (
    echo BOOT_SD_FAIL bootgen made no BOOT.BIN, see %LOG% >> "%LOG%"
    echo BOOT_SD_FAIL bootgen made no BOOT.BIN, see %LOG%
    exit /b 1
)
echo BOOT.BIN: %EOG_OUT%\BOOT.BIN >> "%LOG%"
echo BOOT.BIN: %EOG_OUT%\BOOT.BIN

if "%DRIVE%"=="" (
    echo no drive given: BOOT.BIN only >> "%LOG%"
    echo BOOT_SD_OK >> "%LOG%"
    echo BOOT_SD_OK
    exit /b 0
)
set DRIVE=%DRIVE::=%
if not exist "%DRIVE%:\" (
    echo BOOT_SD_FAIL drive %DRIVE%: not found >> "%LOG%"
    echo BOOT_SD_FAIL drive %DRIVE%: not found
    exit /b 1
)
if not exist "%WEIGHTS%" (
    echo BOOT_SD_FAIL no weights file %WEIGHTS%: make_weights_sd.py --blob ... --version N --out weights.eog >> "%LOG%"
    echo BOOT_SD_FAIL no weights file %WEIGHTS%: make_weights_sd.py --blob ... --version N --out weights.eog
    exit /b 1
)
copy /y "%EOG_OUT%\BOOT.BIN" "%DRIVE%:\BOOT.BIN" >> "%LOG%" || goto copyfail
copy /y "%WEIGHTS%" "%DRIVE%:\weights.eog" >> "%LOG%" || goto copyfail
fc /b "%EOG_OUT%\BOOT.BIN" "%DRIVE%:\BOOT.BIN" > nul || goto copyfail
fc /b "%WEIGHTS%" "%DRIVE%:\weights.eog" > nul || goto copyfail
echo copied BOOT.BIN and %WEIGHTS% as weights.eog to %DRIVE%:\ (verified) >> "%LOG%"
echo copied BOOT.BIN and weights.eog to %DRIVE%:\ (verified). Eject the card, JP5 on SD, power-cycle.
echo BOOT_SD_OK >> "%LOG%"
echo BOOT_SD_OK
exit /b 0

:copyfail
echo BOOT_SD_FAIL copy to %DRIVE%:\ failed or differs >> "%LOG%"
echo BOOT_SD_FAIL copy to %DRIVE%:\ failed or differs
exit /b 1
