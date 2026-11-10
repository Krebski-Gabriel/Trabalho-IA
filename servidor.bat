@echo off
setlocal
cd /d "%~dp0"
title Mapa de Correntes - servidor
call preparar_ambiente.bat
if not defined PY (
  echo Python nao encontrado. Instale o Python 3 e abra de novo.
  pause
  exit /b 1
)
"%PY%" servidor.py %*
echo.
pause
