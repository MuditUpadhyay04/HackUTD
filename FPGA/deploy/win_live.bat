@echo off
rem Live pipeline (ml/BOARD_CHECKLIST.md section 4) on a freshly programmed board.
rem Usage: win_live.bat v4   -> L1/L2: stream the full week with weights v4
rem        win_live.bat swap -> L4: start on v3, live swap to v4 (+ its GLOBAL) at step 1029
rem listen.py runs in its own minimized window (title hutd_listen) and is stopped at the end.
rem Output: FPGA\build\live_<mode>.jsonl, live_<mode>_listen.log, live_<mode>_replay.log, live_summary_<mode>.txt
set R=%~dp0..
set MODE=%1
if "%MODE%"=="" set MODE=v4
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
if not defined HUTD_ML set "HUTD_ML=%USERPROFILE%\hackutd\ml_f07ae06\ml"
if not defined HUTD_DATA set "HUTD_DATA=%USERPROFILE%\hackutd\zeroday\history\full_week"
set L=%R%\build
if not exist "%L%" mkdir "%L%"
set S=%L%\live_summary_%MODE%.txt
echo live %MODE% %DATE% %TIME% ml=%HUTD_ML% data=%HUTD_DATA% > "%S%"

call "%R%\deploy\win_deploy_eog.bat"
timeout /t 8 /nobreak > nul
set /a TRIES=0
:waitping
ping -n 1 -w 1000 192.168.1.10 | find "TTL=" > nul
if not errorlevel 1 goto :up
set /a TRIES+=1
if %TRIES% GEQ 60 ( echo board not reachable >> "%S%" & goto :eof )
goto :waitping
:up
timeout /t 5 /nobreak > nul
echo board up %TIME% >> "%S%"

pushd "%HUTD_ML%"
if exist "%L%\live_%MODE%.jsonl" del "%L%\live_%MODE%.jsonl"
start "hutd_listen" /min cmd /c ""%PY%" -m hutd_ml.listen --data "%HUTD_DATA%" --model artifacts\v3 --model artifacts\v4 --jsonl "%L%\live_%MODE%.jsonl" --quiet > "%L%\live_%MODE%_listen.log" 2>&1"
timeout /t 4 /nobreak > nul
if /i "%MODE%"=="swap" (
  "%PY%" -m hutd_ml.replay --data "%HUTD_DATA%" --weights artifacts\v3\weights.bin --weights-version 3 --config artifacts\v3\global_config.json --swap-at-step 1029 --swap-weights artifacts\v4\weights.bin --swap-version 4 --swap-config artifacts\v4\global_config.json --step-seconds 0.05 > "%L%\live_%MODE%_replay.log" 2>&1
) else (
  "%PY%" -m hutd_ml.replay --data "%HUTD_DATA%" --weights artifacts\v4\weights.bin --weights-version 4 --config artifacts\v4\global_config.json --step-seconds 0.05 > "%L%\live_%MODE%_replay.log" 2>&1
)
echo replay exit %ERRORLEVEL% %TIME% >> "%S%"
rem listen.py lags behind the board (it waits 50 ms per idle socket per loop); stop it only once its output
rem count of RESULT/ALERT lines has stopped growing for 6 s (STATS keep arriving every second; max ~4 min).
set /a IDLE=0
set /a GUARD=0
set LASTSZ=-1
:drainwait
timeout /t 2 /nobreak > nul
for /f %%C in ('find /c "result_no" ^< "%L%\live_%MODE%.jsonl"') do set SZ=%%C
if "%SZ%"=="%LASTSZ%" ( set /a IDLE+=2 ) else ( set /a IDLE=0 )
set LASTSZ=%SZ%
set /a GUARD+=1
if %IDLE% LSS 6 if %GUARD% LSS 120 goto :drainwait
echo listen drained %TIME% lines %SZ% >> "%S%"
taskkill /fi "WINDOWTITLE eq hutd_listen*" /t /f >> "%S%" 2>&1
popd
echo END %TIME% >> "%S%"
