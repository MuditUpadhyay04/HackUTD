@echo off
set R=%~dp0..
set PY=%USERPROFILE%\anaconda3\python.exe
"%PY%" "%R%\deploy\stats_peek.py" 4 > "%R%\build\stats_peek.txt" 2>&1
