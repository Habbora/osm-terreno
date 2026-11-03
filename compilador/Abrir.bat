@echo off
cd /d "%~dp0..\editor"
pyw -3.12 servir-editor.py
if errorlevel 1 py -3.12 servir-editor.py
