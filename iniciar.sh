#!/usr/bin/env sh
# Mac/Linux: inicia o servidor com IA; sem Python, abre o index.html direto.
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then exec python3 servidor.py "$@"
elif command -v python >/dev/null 2>&1; then exec python servidor.py "$@"
else
  echo "Python nao encontrado - abrindo o mapa direto no navegador."
  (command -v open >/dev/null && open index.html) || xdg-open index.html
fi
