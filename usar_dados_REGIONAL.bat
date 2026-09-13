@echo off
setlocal
cd /d "%~dp0"
title Voltar para os dados REGIONAIS
chcp 65001 >nul

if exist dados-marinhos_regional.js (
  if exist dados-marinhos.js del dados-marinhos.js
  ren dados-marinhos_regional.js dados-marinhos.js
  echo  Mapa configurado para os dados REGIONAIS (costa BR).
  echo  Abra/recarregue o index.html (Ctrl+F5).
) else if exist dados-marinhos.js (
  echo  Ja esta nos dados regionais.
) else (
  echo  Nao achei dados-marinhos_regional.js nem dados-marinhos.js.
  echo  Gere de novo com:
  echo      python converter_dados.py teste\projeto_oceano_ia\dados_maritimos.nc
)

echo.
pause
