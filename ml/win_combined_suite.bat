@echo off
rem Combined test (ml/COMBINED_TEST.md): v4 on the board -> board JSON -> API incidents -> Nemotron agents.
rem Double-click from a FULL snapshot of the repo at main, after win_agents_setup.bat. Re-programs the board before
rem each board stage. Log: <this folder>\combined_suite.log; report: <this folder>\combined_suite_*\report.md
rem (also copied to combined_suite_report.md here). "board" as the first argument runs only the board stages
rem (store and forward: send the two L*.jsonl to Mudit); win_combined_suite_board.bat does that by double-click.
set "ML=%~dp0"
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set PY=python
if not defined HUTD_DATA set "HUTD_DATA=%USERPROFILE%\hackutd\zeroday\history\full_week"
rem Lucas's FPGA checkout (BOARD_SESSION.md): its deploy\win_deploy_eog.bat re-programs the board over JTAG
if not defined HUTD_FPGA set "HUTD_FPGA=%USERPROFILE%\OneDrive\Documents\GitHub\HackUTD\FPGA"
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
set "EXTRA="
if /i "%~1"=="board" set "EXTRA=--skip N1,N2,D1"
pushd "%ML%"
"%PY%" -m hutd_ml.combined_suite --data "%HUTD_DATA%" --reset-cmd "\"%HUTD_FPGA%\deploy\win_deploy_eog.bat\"" %EXTRA% > combined_suite.log 2>&1
echo EXIT %ERRORLEVEL% >> combined_suite.log
for /f "delims=" %%D in ('dir /b /ad /o-d combined_suite_*') do ( copy /y "%%D\report.md" combined_suite_report.md > nul & goto :done )
:done
popd
