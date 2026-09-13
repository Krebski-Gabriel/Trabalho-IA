#!/usr/bin/env python3
"""
Servidor local do mapa de correntes.

    python servidor.py [porta]        (padrao: 8000)

Abre  http://localhost:8000/index.html  no navegador e serve os arquivos
da pasta. Com o site aberto por aqui (e nao por file://), o botao
"Atualizar correntes" funciona: ele chama /api/atualizar, que roda
    python fetch_ocean.py --source copernicus
no seu proprio PC e, ao terminar, o site recarrega com os dados novos.

Pre-requisito (uma vez): ter feito login no Copernicus. Se nunca fez, rode
no terminal:  python fetch_ocean.py --source copernicus   (ele pergunta
usuario/senha e guarda).
"""
import http.server
import socketserver
import subprocess
import sys
import os
import json
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

_job = {"state": "idle", "log": [], "started": None, "finished": None, "rc": None}
_lock = threading.Lock()


def _has_login():
    if os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME"):
        return True
    return (Path.home() / ".copernicusmarine" / ".copernicusmarine-credentials").exists()


def _run_update(extra_args):
    cmd = [sys.executable, str(ROOT / "fetch_ocean.py"), "--source", "copernicus"] + extra_args
    with _lock:
        _job.update(state="running", log=["$ " + " ".join(cmd)],
                    started=time.time(), finished=None, rc=None)
    try:
        p = subprocess.Popen(
            cmd, cwd=str(ROOT), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        for line in p.stdout:
            line = line.rstrip()
            if not line:
                continue
            with _lock:
                _job["log"].append(line)
                _job["log"] = _job["log"][-80:]
        p.wait()
        rc = p.returncode

        if rc == 0:
            # se ainda ha dados regionais na frente, guarda pra ver o global novo
            reg = ROOT / "dados-marinhos.js"
            bak = ROOT / "dados-marinhos_regional.js"
            if reg.exists() and not bak.exists():
                reg.rename(bak)
                with _lock:
                    _job["log"].append("(dados-marinhos.js -> _regional; mapa agora usa o global)")

        with _lock:
            _job.update(state=("done" if rc == 0 else "error"),
                        rc=rc, finished=time.time())
    except Exception as e:  # noqa: BLE001
        with _lock:
            _job.update(state="error", finished=time.time())
            _job["log"].append("ERRO: " + str(e))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            with _lock:
                snap = json.loads(json.dumps(_job))
            return self._json(200, snap)
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/atualizar":
            return self._json(404, {"erro": "rota desconhecida"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            opt = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            opt = {}

        with _lock:
            busy = _job["state"] == "running"
        if busy:
            return self._json(409, {"erro": "ja esta atualizando"})
        if not _has_login():
            return self._json(428, {"erro": "faca login uma vez no terminal:  python fetch_ocean.py --source copernicus"})

        args = []
        if opt.get("date"):
            args += ["--date", str(opt["date"])[:10]]
        if opt.get("noSst"):
            args += ["--no-sst"]
        threading.Thread(target=_run_update, args=(args,), daemon=True).start()
        return self._json(202, {"ok": True})

    def end_headers(self):
        # nao deixa o navegador guardar os .js gerados
        if self.path.endswith((".js", ".json")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):  # silencia o log de acesso
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    os.chdir(ROOT)
    try:
        httpd = Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        sys.exit(f"nao consegui abrir a porta {PORT}: {e}\n(tente:  python servidor.py 8001)")
    url = f"http://localhost:{PORT}/index.html"
    print("=" * 52)
    print(f"  Mapa de correntes rodando em:\n  {url}")
    print("  (feche esta janela ou Ctrl+C para parar)")
    print("=" * 52)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nparado.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
