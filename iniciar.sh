#!/usr/bin/env sh
# Mac/Linux: prepara o Python do projeto (.venv + requirements.txt, so na primeira
# vez) e inicia o servidor com IA; sem Python, abre o index.html direto.
cd "$(dirname "$0")"

BASE=""
if command -v python3 >/dev/null 2>&1; then BASE=python3
elif command -v python >/dev/null 2>&1; then BASE=python
else
  echo "Python nao encontrado - abrindo o mapa direto no navegador."
  (command -v open >/dev/null && open index.html) || xdg-open index.html
  exit 0
fi

PY="$BASE"
# .venv quebrado (ex.: criado sem o pacote python3-venv, fica sem pip): apaga e tenta de novo
if [ -x .venv/bin/python ] && ! .venv/bin/python -m pip --version >/dev/null 2>&1; then rm -rf .venv; fi
if [ -x .venv/bin/python ] || "$BASE" -m venv .venv >/dev/null 2>&1; then
  PY=.venv/bin/python
  if ! cmp -s requirements.txt .venv/requirements.instalado; then
    echo "Instalando as bibliotecas do projeto (so na primeira vez, pode levar alguns minutos)..."
    if "$PY" -m pip install --disable-pip-version-check -r requirements.txt; then
      cp requirements.txt .venv/requirements.instalado
    else
      echo "Algumas bibliotecas nao instalaram; o programa abre mesmo assim."
    fi
  fi
else
  rm -rf .venv
  echo "Nao consegui criar o .venv (no Debian/Ubuntu: sudo apt install python3-venv)."
  echo "Usando o Python do sistema."
fi

exec "$PY" servidor.py "$@"
