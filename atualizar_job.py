#!/usr/bin/env python3
"""
atualizar_job.py — roda o download das correntes em segundo plano e grava o
andamento em .atualizar_status.json (lido por api/status.php).

E o que o botao "Atualizar correntes" usa quando o site e aberto pelo XAMPP
(Apache + PHP). O api/atualizar.php dispara:

    python atualizar_job.py [--date YYYY-MM-DD] [--no-sst]

que:
  1. instala sozinho o que faltar para o download (copernicusmarine, numpy,
     xarray) — so na primeira vez, demora alguns minutos;
  2. roda  python fetch_ocean.py --source copernicus;
  3. ao terminar com sucesso, faz o mesmo que o servidor.py: renomeia
     dados-marinhos.js para dados-marinhos_regional.js para o mapa passar a
     usar os dados globais novos.

O servidor.py tambem usa garantir_pacotes() daqui no botao dele.
Pode ser rodado a mao no terminal para testar.
"""
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATUS = ROOT / ".atualizar_status.json"
MAX_LOG = 80

# modulo importado -> pacote do pip (o que o fetch_ocean.py --source copernicus precisa)
PACOTES_DOWNLOAD = {
    "copernicusmarine": "copernicusmarine",
    "numpy": "numpy",
    "xarray": "xarray",
}


def _env_utf8():
    return dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")


def rodar(cmd, log):
    """Roda um comando mandando cada linha de saida para log(); devolve o codigo de saida."""
    p = subprocess.Popen(
        cmd, cwd=str(ROOT), env=_env_utf8(), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    for line in p.stdout:
        line = line.rstrip()
        if line:
            log(line)
    return p.wait()


def _em_venv():
    return sys.prefix != getattr(sys, "base_prefix", sys.prefix)


def garantir_pacotes(log, pacotes=PACOTES_DOWNLOAD):
    """
    Instala com o pip, neste mesmo Python, os pacotes que estiverem faltando.
    Devolve True se no fim esta tudo instalado.
    """
    faltando = [pip for mod, pip in pacotes.items() if importlib.util.find_spec(mod) is None]
    if not faltando:
        return True

    log("Instalando " + ", ".join(faltando) + " (so na primeira vez, pode levar alguns minutos)...")
    if importlib.util.find_spec("pip") is None:
        rodar([sys.executable, "-m", "ensurepip", "--upgrade"], log)

    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
    if not _em_venv():
        cmd.append("--user")  # Python do sistema: instala na pasta do usuario, sem pedir administrador
    rc = rodar(cmd + faltando, log)

    importlib.invalidate_caches()
    ainda = [pip for mod, pip in pacotes.items() if importlib.util.find_spec(mod) is None]
    if rc != 0 or ainda:
        log("ERRO: nao consegui instalar " + ", ".join(ainda or faltando)
            + ". Rode no terminal:  \"" + sys.executable + "\" -m pip install " + " ".join(ainda or faltando))
        return False
    log("Bibliotecas instaladas.")
    return True


def _write(job):
    """Grava o status de forma atomica (o PHP nunca le um arquivo pela metade)."""
    tmp = STATUS.with_name(STATUS.name + ".tmp")
    tmp.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, STATUS)


def main():
    extra = sys.argv[1:]
    cmd = [sys.executable, str(ROOT / "fetch_ocean.py"), "--source", "copernicus"] + extra
    job = {
        "state": "running",
        "log": [],
        "started": time.time(),
        "finished": None,
        "rc": None,
        "pid": os.getpid(),
    }
    ultima_gravacao = [0.0]

    def log(line):
        job["log"] = (job["log"] + [line])[-MAX_LOG:]
        if time.time() - ultima_gravacao[0] > 0.5:  # nao reescreve o arquivo a cada linha
            _write(job)
            ultima_gravacao[0] = time.time()

    _write(job)
    try:
        if not garantir_pacotes(log):
            job.update(state="error", rc=1, finished=time.time())
            _write(job)
            return 1

        log("$ " + " ".join(cmd))
        rc = rodar(cmd, log)

        if rc == 0:
            reg = ROOT / "dados-marinhos.js"
            bak = ROOT / "dados-marinhos_regional.js"
            if reg.exists() and not bak.exists():
                reg.rename(bak)
                log("(dados-marinhos.js -> _regional; mapa agora usa o global)")

        job.update(state=("done" if rc == 0 else "error"), rc=rc, finished=time.time())
    except Exception as e:
        job["log"].append("ERRO: " + str(e))
        job.update(state="error", finished=time.time())
    _write(job)
    return 0 if job["state"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
