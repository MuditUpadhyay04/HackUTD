@echo off
rem Mudit's final board suite (ml/hutd_ml/board_suite.py on main): B1-B3, B5, B6, live replay->board->listen,
rem v3->v4 swap, mock/snapshot folders, + throughput. Re-programs the board over JTAG before each test.
rem Log: FPGA\build\board_suite.log; report: <ml>\board_suite_*\report.md (copied to FPGA\build\board_suite_report.md)
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
if not exist "%PY%" set PY=python
if not defined HUTD_ML set "HUTD_ML=%USERPROFILE%\hackutd\ml_main_846463e\ml"
if not defined HUTD_DATA set "HUTD_DATA=%USERPROFILE%\hackutd\zeroday\history\full_week"
pushd "%HUTD_ML%"
"%PY%" -m hutd_ml.board_suite --data "%HUTD_DATA%" --reset-cmd "\"%R%\deploy\win_deploy_eog.bat\"" --throughput > "%R%\build\board_suite.log" 2>&1
echo EXIT %ERRORLEVEL% >> "%R%\build\board_suite.log"
for /f "delims=" %%D in ('dir /b /ad /o-d board_suite_*') do ( copy /y "%%D\report.md" "%R%\build\board_suite_report.md" > nul & goto :done )
:done
popd
