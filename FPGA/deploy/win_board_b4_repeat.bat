@echo off
rem Is B4 reproducible? Fresh board each run: B3 once, B4 twice at 2000 pps, B4 once at 500 pps.
rem Each run's board_run\ folder is copied to FPGA\build\b4rep_<n>\. Summary: FPGA\build\b4rep_summary.txt
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
if not defined HUTD_ML set "HUTD_ML=%USERPROFILE%\hackutd\ml_f07ae06\ml"
set L=%R%\build
set S=%L%\b4rep_summary.txt
set G=artifacts\v4\golden\g1
echo b4 repeat %DATE% %TIME% > "%S%"
pushd "%HUTD_ML%"
call :run 1 ""
call :run 2 "--heartbeat-test 6"
call :run 3 "--heartbeat-test 6"
call :run 4 "--heartbeat-test 6 --pps 500 --wait 20"
popd
echo END %TIME% >> "%S%"
exit /b

:run
call "%R%\deploy\win_deploy_eog.bat"
timeout /t 8 /nobreak > nul
set /a TRIES=0
:waitping
ping -n 1 -w 1000 192.168.1.10 | find "TTL=" > nul
if not errorlevel 1 goto :up
set /a TRIES+=1
if %TRIES% GEQ 60 ( echo run %1 board not reachable >> "%S%" & exit /b )
goto :waitping
:up
timeout /t 5 /nobreak > nul
"%PY%" -m hutd_ml.board --golden %G% %~2 > "%L%\b4rep_%1.log" 2>&1
if errorlevel 1 ( echo run %1 [%~2] FAIL %TIME% >> "%S%" ) else ( echo run %1 [%~2] PASS %TIME% >> "%S%" )
if not exist "%L%\b4rep_%1" mkdir "%L%\b4rep_%1"
copy /y "%G%\board_run\*" "%L%\b4rep_%1\" > nul
exit /b
