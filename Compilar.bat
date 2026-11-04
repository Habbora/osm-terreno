@echo off
cd /d "%~dp0"
py -3.12 "%~dp0compilador\aplicar_terreno.pyw" --compilar-todos
if errorlevel 1 pause
