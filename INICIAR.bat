@echo off
setlocal
cd /d "%~dp0"
title Copiloto IA - Rotas Maritimas
rem prepara o Python e instala as bibliotecas sozinho (so demora na primeira vez)
call preparar_ambiente.bat
if defined PY (
  echo Iniciando o servidor com IA... o navegador vai abrir sozinho.
  echo Para parar, feche esta janela.
  "%PY%" servidor.py %*
  pause
) else (
  echo Python nao encontrado neste computador.
  echo Abrindo o mapa direto no navegador - rotas funcionam normalmente.
  echo Para o parecer do Gemini, clique na chave dentro da tela de Analise da Rota.
  start "" "%~dp0index.html"
  timeout /t 6 >nul
)
