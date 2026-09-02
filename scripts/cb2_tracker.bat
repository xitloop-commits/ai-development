@echo off
REM Daily cb2-vs-candleblue tracker snapshot (scheduled by Lubas-CB2-Tracker-Daily).
cd /d C:\Users\Admin\ai-development\ai-development
py scripts\cb2_tracker.py >> logs\cb2_tracker.run.log 2>&1
