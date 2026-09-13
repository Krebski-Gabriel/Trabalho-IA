@echo off
setlocal
cd /d "%~dp0"
title Mapa de Correntes - servidor
where python >nul 2>nul && (set "PY=python") || (set "PY=py")
%PY% servidor.py %*
echo.
pause
