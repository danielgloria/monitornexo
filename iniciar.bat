@echo off
echo.
echo  ╔══════════════════════════════════════╗
echo  ║     UTI Monitor - Iniciando...       ║
echo  ╚══════════════════════════════════════╝
echo.
cd /d "%~dp0"
start http://localhost:3000
python app.py
pause
