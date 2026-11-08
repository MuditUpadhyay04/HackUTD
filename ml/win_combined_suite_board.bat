@echo off
rem Board stages of the combined test only (store and forward): writes combined_suite_*\L1_full_week.jsonl and
rem L3_mock_test_*.jsonl, verified bit-exact. Send those two files to Mudit, who runs the agent stages.
call "%~dp0win_combined_suite.bat" board
