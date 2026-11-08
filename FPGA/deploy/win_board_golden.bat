@echo off
rem Board bring-up (T2.board1): Mudit's golden sets through the real board, stop at the first FAIL.
rem Usage: win_board_golden.bat [weights_dir]   (default v4). Logs: FPGA\build\board_<set>.log, summary board_summary.txt
rem Mudit's code: a plain snapshot of branch ml in %USERPROFILE%\hackutd\ml_<hash> (override with HUTD_ML).
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
if not defined HUTD_ML set "HUTD_ML=%USERPROFILE%\hackutd\ml_4c6abd1\ml"
set VER=%1
if "%VER%"=="" set VER=v4
set L=%R%\build
if not exist "%L%" mkdir "%L%"
set S=%L%\board_summary.txt
echo board golden run %VER% %DATE% %TIME% > "%S%"
pushd "%HUTD_ML%"
for %%G in (g0 g2 g1) do (
  "%PY%" -m hutd_ml.board --golden artifacts\%VER%\golden\%%G > "%L%\board_%VER%_%%G.log" 2>&1
  if errorlevel 1 ( echo %VER% %%G FAIL >> "%S%" & goto :done )
  echo %VER% %%G PASS >> "%S%"
)
"%PY%" -m hutd_ml.board --golden artifacts\%VER%\golden\g0 --heartbeat-test 6 > "%L%\board_%VER%_hb.log" 2>&1
if errorlevel 1 ( echo %VER% heartbeat FAIL >> "%S%" ) else ( echo %VER% heartbeat PASS >> "%S%" )
:done
popd
echo END >> "%S%"
