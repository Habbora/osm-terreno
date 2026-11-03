@echo off
title OrthoForge Patch Editor
cd /d "%~dp0"
echo Abrindo o editor...
echo Ctrl+C fecha o servidor.
echo.
where py >nul 2>&1 && (
  py -3 servir-editor.py
  goto :eof
)
python servir-editor.py
if errorlevel 1 pause
