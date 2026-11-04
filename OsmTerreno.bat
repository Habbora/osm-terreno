@echo off
cd /d "%~dp0"
where py >nul 2>&1
if errorlevel 1 (
  echo Nao achei o Python. Instale o Python 3.12 com o py launcher.
  pause
  exit /b 1
)
start "" pyw -3.12 "%~dp0compilador\aplicar_terreno.pyw"
exit /b 0
