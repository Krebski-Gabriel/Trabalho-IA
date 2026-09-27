#!/usr/bin/env python3
import os
# Para usar o copiloto IA, defina a variavel de ambiente antes de iniciar:
#   set GEMINI_API_KEY=sua_chave     (Windows)
#   export GEMINI_API_KEY=sua_chave  (Linux/Mac)

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
import json
import threading
import time
import webbrowser
from pathlib import Path

import ai_agent

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
            reg = ROOT / "dados-marinhos.js"
            bak = ROOT / "dados-marinhos_regional.js"
            if reg.exists() and not bak.exists():
                reg.rename(bak)
                with _lock:
                    _job["log"].append("(dados-marinhos.js -> _regional; mapa agora usa o global)")

        with _lock:
            _job.update(state=("done" if rc == 0 else "error"),
                        rc=rc, finished=time.time())
    except Exception as e:
        with _lock:
            _job.update(state="error", finished=time.time())
            _job["log"].append("ERRO: " + str(e))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            pass

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            with _lock:
                snap = json.loads(json.dumps(_job))
            return self._json(200, snap)
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}

        if path == "/api/atualizar":
            return self._handle_atualizar(body)
        if path == "/api/chat":
            return self._handle_chat(body)
        if path == "/api/route":
            return self._handle_route(body)
        return self._json(404, {"erro": "rota desconhecida"})

    def _handle_atualizar(self, opt):
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

    def _handle_chat(self, body):
        message = str(body.get("message", "")).strip()
        if not message:
            return self._json(400, {"erro": "mensagem vazia"})
        context = body.get("context") or {}
        history = body.get("history") or []
        try:
            result = ai_agent.llm_chat(message, context=context, history=history)
            return self._json(200, result)
        except Exception as e:
            return self._json(500, {"erro": str(e)})

    def _handle_route(self, body):
        a, b = body.get("a"), body.get("b")
        if not a or not b:
            return self._json(400, {"erro": "pontos 'a' e 'b' ([lon,lat]) sao obrigatorios"})
        try:
            speed_kn = float(body.get("speed_kn", 18))
            result = ai_agent.compute_three_routes(
                (float(a[0]), float(a[1])), (float(b[0]), float(b[1])), speed_kn
            )
            if not result:
                return self._json(422, {"erro": "nao achei rota entre os pontos informados"})
            return self._json(200, result)
        except Exception as e:
            return self._json(500, {"erro": str(e)})

    def end_headers(self):
        if self.path.endswith((".js", ".json")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):
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
    threading.Thread(target=ai_agent.warmup, daemon=True).start()

    url = f"http://localhost:{PORT}/index.html"
    print("=" * 52)
    print(f"  Mapa de correntes rodando em:\n  {url}")
    print("  (feche esta janela ou Ctrl+C para parar)")
    gemini_key = os.environ.get("GEMINI_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")
    if gemini_key:
        print(f"  Copiloto IA: chave GEMINI_API_KEY detectada (...{gemini_key[-4:]}) — usando Gemini.")
    elif openai_key:
        print(f"  Copiloto IA: chave OPENAI_API_KEY detectada (...{openai_key[-4:]}) — usando OpenAI.")
    else:
        print("  Copiloto IA: nenhuma chave (GEMINI_API_KEY/OPENAI_API_KEY) detectada —")
        print("  usando simulacao otimizada offline (rotas e chat funcionam normalmente,")
        print("  com o ganho de eficiencia da Rota IA calculado deterministicamente).")
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
