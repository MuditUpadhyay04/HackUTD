@echo off
rem Board bring-up (T2.board1), Mudit's ml/BOARD_CHECKLIST.md section 2: B1-B4 on the v4 golden sets.
rem The board is re-programmed before each set (alarm latches survive CONFIG writes, so ALERTs need a fresh board).
rem Stops at the first FAIL. Logs: FPGA\build\board_B<n>.log, summary FPGA\build\board_summary.txt
rem Mudit's code: plain snapshot of branch ml in %USERPROFILE%\hackutd\ml_<hash>\ml (override with HUTD_ML).
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
if not defined HUTD_ML set "HUTD_ML=%USERPROFILE%\hackutd\ml_f07ae06\ml"
set L=%R%\build
if not exist "%L%" mkdir "%L%"
set S=%L%\board_summary.txt
echo board golden run v4 %DATE% %TIME% ml=%HUTD_ML% > "%S%"
pushd "%HUTD_ML%"

call :fresh
"%PY%" -m hutd_ml.board --golden artifacts\v4\golden\g0 --weights-negative > "%L%\board_B1.log" 2>&1
if errorlevel 1 ( echo B1 g0 weights-negative FAIL >> "%S%" & goto :done )
echo B1 g0 weights-negative PASS >> "%S%"

call :fresh
"%PY%" -m hutd_ml.board --golden artifacts\v4\golden\g2 > "%L%\board_B2.log" 2>&1
if errorlevel 1 ( echo B2 g2 FAIL >> "%S%" & goto :done )
echo B2 g2 PASS >> "%S%"

call :fresh
"%PY%" -m hutd_ml.board --golden artifacts\v4\golden\g1 > "%L%\board_B3.log" 2>&1
if errorlevel 1 ( echo B3 g1 FAIL >> "%S%" & goto :done )
echo B3 g1 PASS >> "%S%"

call :fresh
"%PY%" -m hutd_ml.board --golden artifacts\v4\golden\g1 --heartbeat-test 6 > "%L%\board_B4.log" 2>&1
if errorlevel 1 ( echo B4 g1 heartbeat FAIL >> "%S%" & goto :done )
echo B4 g1 heartbeat PASS >> "%S%"

:done
popd
echo END %TIME% >> "%S%"
exit /b

:fresh
echo reprogram %TIME% >> "%S%"
call "%R%\deploy\win_deploy_eog.bat"
rem The board reset drops the direct-cable link; wait until the PC sees the board again, then let it settle.
timeout /t 8 /nobreak > nul
set /a TRIES=0
:waitping
ping -n 1 -w 1000 192.168.1.10 | find "TTL=" > nul
if not errorlevel 1 goto :up
set /a TRIES+=1
if %TRIES% GEQ 60 ( echo board not reachable %TIME% >> "%S%" & exit /b )
goto :waitping
:up
echo board up after %TRIES% pings %TIME% >> "%S%"
timeout /t 5 /nobreak > nul
exit /b
