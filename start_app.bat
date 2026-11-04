@echo off
title Sudanese Voice Studio
echo Checking free voice engine...
python -m pip install --quiet edge-tts
echo Starting Sudanese Voice Studio at http://localhost:3000 ...
start http://localhost:3000
node server.js
pause
