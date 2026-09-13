@echo off
setlocal
cd /d "%~dp0"
title Atualizar correntes GLOBAIS (Copernicus)
chcp 65001 >nul

echo ================================================
echo   Atualizando as correntes do mapa (Copernicus)
echo   - baixa o dia mais recente
echo   - gera o ocean-data.js
echo ================================================
echo.

where python >nul 2>nul && (set "PY=python") || (set "PY=py")

%PY% fetch_ocean.py --source copernicus %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" goto :fim

rem deixa o mapa usar o arquivo global (guarda o regional, se houver)
if exist dados-marinhos.js if not exist dados-marinhos_regional.js ren dados-marinhos.js dados-marinhos_regional.js
if exist dados-marinhos.js if exist dados-marinhos_regional.js del dados-marinhos.js

echo.
echo  Pronto^!  Abra/recarregue o index.html no navegador (Ctrl+F5).

:fim
echo.
if not "%ERR%"=="0" echo  Deu erro (codigo %ERR%). Veja as mensagens acima.
echo.
pause
