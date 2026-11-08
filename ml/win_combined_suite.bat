@echo off
rem Combined test (ml/COMBINED_TEST.md): v4 on the board -> board JSON -> API incidents -> Nemotron agents.
rem Double-click from a FULL snapshot of the repo at main, after win_agents_setup.bat. Re-programs the board before
rem each board stage. Log: <this folder>\combined_suite.log; report: <this folder>\combined_suite_*\report.md
rem (also copied to combined_suite_report.md here). "board" as the first argument runs only the board stages
rem (store and forward: send the two L*.jsonl to Mudit); win_combined_suite_board.bat does that by double-click.
set "ML=%~dp0"
set "PY="
rem Python 3.10+ with numpy and pandas: HUTD_PY if set, else Anaconda / Miniconda, else the py launcher, else python on PATH
if defined HUTD_PY set "PY=%HUTD_PY%"
if not defined PY if exist "%USERPROFILE%\anaconda3\python.exe" set "PY=%USERPROFILE%\anaconda3\python.exe"
if not defined PY if exist "%USERPROFILE%\miniconda3\python.exe" set "PY=%USERPROFILE%\miniconda3\python.exe"
if not defined PY ( py -3 -c "import numpy, pandas" >nul 2>&1 && set "PY=py -3" )
if not defined PY ( python -c "import numpy, pandas" >nul 2>&1 && set "PY=python" )
if not defined PY ( echo No Python 3 with numpy and pandas found. Install Python 3.12 from python.org ^(Add to PATH^), then: py -3 -m pip install -r "%~dp0requirements.txt" & pause & goto :eof )
if not defined HUTD_DATA set "HUTD_DATA=%USERPROFILE%\hackutd\zeroday\history\full_week"
rem Lucas's FPGA checkout (BOARD_SESSION.md): its deploy\win_deploy_eog.bat re-programs the board over JTAG
if not defined HUTD_FPGA set "HUTD_FPGA=%USERPROFILE%\OneDrive\Documents\GitHub\HackUTD\FPGA"
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
set "EXTRA="
if /i "%~1"=="board" set "EXTRA=--skip N1,N2,D1"
pushd "%ML%"
%PY% -m hutd_ml.combined_suite --data "%HUTD_DATA%" --reset-cmd "\"%HUTD_FPGA%\deploy\win_deploy_eog.bat\"" %EXTRA% > combined_suite.log 2>&1
echo EXIT %ERRORLEVEL% >> combined_suite.log
for /f "delims=" %%D in ('dir /b /ad /o-d combined_suite_*') do ( copy /y "%%D\report.md" combined_suite_report.md > nul & goto :done )
:done
popd
