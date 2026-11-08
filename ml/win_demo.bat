@echo off
rem Judging-day demo on the board PC (docs/plan/mudit/judging_day.md): the operator API, the console, listen.py and
rem replay.py, each in its own window, on one dataset folder through the board with weights v4.
rem   win_demo.bat                 -> <reference repo>\test if it exists, else its newest mock_test_* folder
rem   win_demo.bat <folder>        -> that dataset folder
rem Needs: a full snapshot of main, win_agents_setup.bat done once (Bun, .env), the board up at 192.168.1.10.
rem Not yet run on Windows: try it once before judging.
rem listen.py writes live.jsonl and the API reads it (no --post: a slow console must never stop the board's heartbeat).
rem replay.py sends hb_timeout_ms = 0, so the board never goes AUTONOMOUS (open issue B4) even if listen.py is late.
set "ML=%~dp0"
set "ROOT=%~dp0.."
set "PY=%USERPROFILE%\anaconda3\python.exe"
if not exist "%PY%" set PY=python
if not defined HUTD_REF set "HUTD_REF=%USERPROFILE%\hackutd\zeroday"
if not defined REPLAY_STEP set "REPLAY_STEP=0.5"
set "DS=%~1"
if "%DS%"=="" if exist "%HUTD_REF%\test\telemetry.csv" set "DS=%HUTD_REF%\test"
if "%DS%"=="" for /d %%D in ("%HUTD_REF%\history\mock_test_*") do set "DS=%%D"
if "%DS%"=="" ( echo No dataset: pass a folder, or set HUTD_REF to the reference repo & pause & goto :eof )
echo Dataset: %DS%
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
set "LIVE=%ML%live.jsonl"
type nul > "%LIVE%"
rem One environment for every window: each program reads only its own variables.
set "STORAGE_MODE=memory"
set "ALLOW_INSECURE_LOCAL=1"
set "HOSTNAME=127.0.0.1"
set "DATA_ROOT=%HUTD_REF%;%DS%\.."
set "BOARD_JSONL=%LIVE%"
set "BOARD_SOURCE=fpga"
start "HUTD API" /D "%ROOT%" cmd /k bun apps\api\src\index.ts
start "HUTD console" /D "%ROOT%" cmd /k bun run dev:web
timeout /t 15 /nobreak > nul
start "HUTD listen" /D "%ML%" cmd /k ""%PY%" -m hutd_ml.listen --data "%DS%" --model artifacts\v4 --source fpga --jsonl "%LIVE%""
timeout /t 3 /nobreak > nul
start "HUTD replay" /D "%ML%" cmd /k ""%PY%" -m hutd_ml.replay --data "%DS%" --weights artifacts\v4\weights.bin --weights-version 4 --config artifacts\v4\global_config.json --step-seconds %REPLAY_STEP%"
start "" http://127.0.0.1:3000/
