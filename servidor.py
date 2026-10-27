#!/usr/bin/env python3
"""
Servidor local do mapa de correntes.

    python servidor.py [porta]        (padrao: 8000)

Chave do Gemini: NUNCA gravada neste arquivo. Ela e lida da variavel de ambiente
GEMINI_API_KEY ou de um arquivo .env nesta pasta (linha  GEMINI_API_KEY=sua_chave ),
carregado com python-dotenv se estiver instalado. Sem chave, o Copiloto funciona em
modo de simulacao otimizada offline. Para definir a variavel no sistema:
    Windows (so esta janela):   set GEMINI_API_KEY=sua_chave
    Windows (permanente):       setx GEMINI_API_KEY "sua_chave"   (abra um terminal novo depois)
    Linux/macOS:                export GEMINI_API_KEY=sua_chave

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


class _Tee:
    """Duplica o que sai no terminal em servidor_log.txt (diagnostico do Gemini)."""
    def __init__(self, stream, path):
        self._s = stream
        self._f = open(path, "a", encoding="utf-8", buffering=1)
    def write(self, data):
        try:
            self._s.write(data)
        except Exception:
            pass
        self._f.write(data)
        return len(data)
    def flush(self):
        try:
            self._s.flush()
        except Exception:
            pass
        self._f.flush()
    def __getattr__(self, name):
        return getattr(self._s, name)


try:
    sys.stdout = _Tee(sys.stdout, ROOT / "servidor_log.txt")
    sys.stderr = _Tee(sys.stderr, ROOT / "servidor_log.txt")
    print("\n===== servidor iniciado", time.strftime("%Y-%m-%d %H:%M:%S"), "=====")
except Exception:
    pass


def _load_env_file():
    """Carrega ROOT/.env (GEMINI_API_KEY, OPENAI_API_KEY...) sem sobrescrever variaveis ja
    definidas no ambiente. Usa python-dotenv se instalado; senao, um leitor simples KEY=VALOR."""
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    try:
        from dotenv import load_dotenv
        load_dotenv(env_path, override=False)
        return
    except ImportError:
        pass
    try:
        for line in env_path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError as e:
        print(f"  aviso: nao consegui ler {env_path}: {e}")


_load_env_file()

import ai_agent  # noqa: E402  (depois do .env: o agente le as chaves do ambiente)

try:
    import google.generativeai as genai
except ImportError:  # SDK ausente: o parecer usa o texto offline (pip install google-generativeai)
    genai = None

GEMINI_TIMEOUT_S = 20
KM_TO_NM = 0.539957


def gerar_analise_gemini(dados_rota):
    api_key = os.getenv('GEMINI_API_KEY')
    if not api_key:
        return None
    # Identificadores ativos, em ordem de tentativa
    modelos_suportados = [
        'gemini-flash-latest',
        'gemini-3.8-flash',
        'gemini-flash-lite-latest',
    ]

    prompt = f"""
Atue como o Copiloto IA de Navegação Inteligente do navio.
Analise os dados reais da viagem de {dados_rota.get('origem')} para {dados_rota.get('destino')}:

--- DADOS DA ROTA COMERCIAL (REFERÊNCIA) ---
- Distância: {dados_rota.get('dist_comercial')} NM
- Duração: {dados_rota.get('tempo_comercial')}
- Combustível Gasto: {dados_rota.get('combustivel_comercial')} toneladas
- Emissões de CO2: {dados_rota.get('co2_comercial')} toneladas
- Custo Total de Combustível: US$ {dados_rota.get('custo_comercial')}

--- DADOS DA ROTA OPTIMIZADA PELO COPILOTO IA ---
- Distância: {dados_rota.get('dist_ia')} NM (variação de {dados_rota.get('diff_dist_ia')} NM)
- Duração: {dados_rota.get('tempo_ia')} (diferença de {dados_rota.get('diff_tempo_ia')})
- Combustível Gasto: {dados_rota.get('combustivel_ia')} toneladas ({dados_rota.get('pct_combustivel_ia')}% de redução)
- Poluição Evitada: {dados_rota.get('co2_evitado')} toneladas de CO2
- Economia Financeira Líquida: US$ {dados_rota.get('economia_usd')}
- Velocidade e Potência Média: {dados_rota.get('vel_ia')} nós com motor a {dados_rota.get('potencia_ia')}% de força.

--- SUA TAREFA ---
Escreva uma análise explicativa em um único parágrafo fluido e estruturado (máximo 4 a 5 frases), combinando rigor de dados e linguagem acessível.

Sua análise DEVE incluir obrigatoriamente:
1. **Os Dois Pilares da Economia:**
   - **Navegação com Correntes:** Explique que a IA desviou ativamente de correntes contrárias e aproveitou fluxos a favor para gastar menos força.
   - **Física da Velocidade (Slow Steaming):** Explique de forma simples que reduzir a velocidade ligeiramente faz a exigência do motor despencar (ex: caindo de 100% para a casa dos 40%), gerando corte drástico de consumo.
2. **Números Concretos:** Cite o valor em Dólares economizado (US$ {dados_rota.get('economia_usd')}), as toneladas de CO2 evitadas e o combustível poupado.
3. **Trade-off Transparente:** Mencione o acréscimo de tempo no destino como uma troca compensatória altamente lucrativa.

REGRAS DE ESTILO:
- Não use jargões indecifráveis sem explicação.
- Seja direto, convincente e profissional.
- Use tom de recomendação estratégica de um especialista.
- Use somente os números fornecidos acima, sem inventar outros.
- Responda apenas com o parágrafo, em texto simples, sem títulos, listas nem formatação Markdown.
"""

    if genai is None:
        # SDK ausente: usa a chamada REST direta do ai_agent (nao precisa de pip install)
        texto = ai_agent.call_llm_text(prompt)
        if texto and texto.strip():
            print("[GEMINI SUCESSO] Resposta gerada via REST")
            return texto.strip()
        return None

    genai.configure(api_key=api_key)

    erros = []
    for nome_modelo in modelos_suportados:
        try:
            model = genai.GenerativeModel(model_name=nome_modelo)
            response = model.generate_content(prompt, request_options={"timeout": GEMINI_TIMEOUT_S})
            if response and response.text:
                print(f"[GEMINI SUCESSO] Resposta gerada via {nome_modelo}")
                return response.text.strip()
            erros.append((nome_modelo, "resposta vazia"))
        except Exception as e:
            detalhe = " ".join(str(e).split())
            erros.append((nome_modelo, f"{type(e).__name__}: {detalhe}"))
            print(f"[GEMINI INFO] Tentativa com {nome_modelo} falhou: {detalhe[:200]}")
            # chave inválida/sem permissão falha igual em todos os modelos: não insiste
            if "API_KEY_INVALID" in detalhe or "PERMISSION_DENIED" in detalhe:
                break

    print("[ERRO GEMINI DETALHADO] nenhum modelo respondeu pela SDK:")
    for nome_modelo, detalhe in erros:
        print(f"    - {nome_modelo}: {detalhe}")
    print("[GEMINI INFO] tentando pela chamada REST direta...")
    texto = ai_agent.call_llm_text(prompt)
    if texto and texto.strip():
        print("[GEMINI SUCESSO] Resposta gerada via REST")
        return texto.strip()
    print("[ERRO GEMINI] REST tambem falhou — usando o parecer técnico local.")
    return None


def _fmt_ponto(nome, ll):
    if nome:
        return str(nome)[:80]
    lon, lat = ll
    return f"{abs(lat):.2f}°{'N' if lat >= 0 else 'S'} {abs(lon):.2f}°{'L' if lon >= 0 else 'O'}"


def _duracao(horas):
    """Horas -> texto legível: '13 dias e 8 horas'."""
    total = max(0, int(round(horas)))
    d, h = divmod(total, 24)
    if d and h:
        return f"{d} {'dia' if d == 1 else 'dias'} e {h} {'hora' if h == 1 else 'horas'}"
    if d:
        return f"{d} {'dia' if d == 1 else 'dias'}"
    return f"{h} {'hora' if h == 1 else 'horas'}"


def _texto_simples(texto):
    """O parecer aparece como texto puro no modal: tira negrito/títulos Markdown que o LLM possa usar."""
    if not texto:
        return texto
    linhas = [l.strip() for l in str(texto).replace("**", "").replace("__", "").splitlines()]
    return " ".join(l for l in linhas if l and not l.startswith("#"))  # títulos saem, o parágrafo fica


def _parecer_rota(origem, destino):
    """Adapta os números de ai_agent.compute_three_routes para o dicionário de gerar_analise_gemini."""
    br = ai_agent._br  # números no formato brasileiro: 1.234,5

    def gerar(comm_m, astar_m, ai_m, scenario):
        fuel_c, fuel_ia = comm_m["fuel_tons"], ai_m["fuel_tons"]
        economia_t = max(0.0, fuel_c - fuel_ia)
        nm_c, nm_ia = comm_m["km"] * KM_TO_NM, ai_m["km"] * KM_TO_NM
        dh = ai_m["hours"] - comm_m["hours"]
        dnm = nm_ia - nm_c
        # velocidade média sobre o fundo (a mesma da tabela do modal)
        vel_ia = ai_m["km"] / ai_m["hours"] / 1.852 if ai_m["hours"] > 0 else ai_m.get("avg_kn", 0.0)
        dados_rota = {
            "origem": origem,
            "destino": destino,
            "dist_comercial": br(nm_c, 0),
            "tempo_comercial": _duracao(comm_m["hours"]),
            "combustivel_comercial": br(fuel_c),
            "co2_comercial": br(fuel_c * ai_agent.CO2_PER_TON_FUEL),
            "custo_comercial": br(fuel_c * ai_agent.FUEL_PRICE_USD, 0),
            "dist_ia": br(nm_ia, 0),
            "diff_dist_ia": ("+" if dnm >= 0 else "−") + br(abs(dnm), 0),
            "tempo_ia": _duracao(ai_m["hours"]),
            "diff_tempo_ia": (("+" if dh >= 0 else "−") + br(abs(dh)) + " horas, cerca de " +
                              br(abs(dh) / 24) + " dias"),
            "combustivel_ia": br(fuel_ia),
            "pct_combustivel_ia": br(100 * economia_t / fuel_c if fuel_c > 0 else 0.0),
            "co2_evitado": br(economia_t * ai_agent.CO2_PER_TON_FUEL),
            "economia_usd": br(economia_t * ai_agent.FUEL_PRICE_USD, 0),
            "vel_ia": br(vel_ia),
            "potencia_ia": br(ai_m.get("load_pct", 100.0), 0),
        }
        return _texto_simples(gerar_analise_gemini(dados_rota))
    return gerar


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
        path = self.path.split("?")[0]
        if path == "/api/status":
            with _lock:
                snap = json.loads(json.dumps(_job))
            return self._json(200, snap)
        if path == "/api/fish-hotspots":
            try:
                return self._json(200, ai_agent.generate_global_fish_hotspots())
            except Exception as e:
                return self._json(500, {"erro": str(e)})
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
            raw_scn = body.get("scenario") or {}
            scenario = {k: bool(raw_scn.get(k)) for k in ("block_panama", "block_suez")}
            a_ll, b_ll = (float(a[0]), float(a[1])), (float(b[0]), float(b[1]))
            parecer = _parecer_rota(_fmt_ponto(body.get("origin_name"), a_ll),
                                    _fmt_ponto(body.get("dest_name"), b_ll))
            result = ai_agent.compute_three_routes(
                a_ll, b_ll, speed_kn, scenario=scenario, rationale_fn=parecer
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
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY")
    if gemini_key:
        print(f"  Copiloto IA: chave GEMINI_API_KEY detectada (...{gemini_key[-4:]}) — usando Gemini.")
    elif openai_key:
        print(f"  Copiloto IA: chave OPENAI_API_KEY detectada (...{openai_key[-4:]}) — usando OpenAI.")
    else:
        print("  Copiloto IA: nenhuma chave (GEMINI_API_KEY/OPENAI_API_KEY) no ambiente nem no .env —")
        print("  usando simulação otimizada offline (rotas e chat funcionam normalmente,")
        print("  com o ganho de eficiência da Rota IA calculado deterministicamente).")
    print("=" * 52)
    if not os.environ.get("SEM_NAVEGADOR"):
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
