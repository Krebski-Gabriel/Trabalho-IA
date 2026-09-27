#!/usr/bin/env python3
"""
ai_agent.py -- motor de rotas (Padrao / A* / Copiloto IA) e ferramentas do
Copiloto IA Maritimo, usado pelo servidor.py nos endpoints /api/route e /api/chat.

100% stdlib (sem numpy/pandas). Le os MESMOS arquivos que o navegador ja usa
para nao inventar dado que o mapa nao esteja mostrando:
  - correntes: dados-marinhos.js (window.MARINE_DATA, Copernicus regional) ou,
    na falta dele, ocean-data.js (window.OCEAN_DATA, global NOAA CoastWatch).
  - temperatura (p/ prever_cardumes): ocean-data.js -> sst, se existir.
  - terra: world-land.js (GeoJSON) -> mascara de navegacao construida uma vez
    e cacheada em disco (.landmask_cache.json).

Integracao LLM (Gemini, lista MODELOS_GEMINI com fallback, OU OpenAI gpt-4o-mini, via
GEMINI_API_KEY / OPENAI_API_KEY): usa chamadas REST cruas (urllib), sem
depender de nenhum SDK. O "tool calling" e feito por roteamento em JSON: o
prompt de sistema pede pro modelo responder com {"tool": "...", "args": {...}}
quando precisar de uma ferramenta, ou {"tool": null, "reply": "..."} numa
conversa normal -- funciona igual nos dois provedores, sem depender do
formato nativo (diferente) de function-calling de cada um.
"""
import base64
import heapq
import json
import math
import os
import re
import struct
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
R_EARTH_KM = 6371.0
KMH_PER_KN = 1.852

FUEL_REF_TPD = 180.0     # t/dia de referencia a 20 nos (porta-conteineres medio)
FUEL_REF_KN = 20.0
FUEL_PRICE_USD = 600.0   # US$/t de VLSFO -- estimativa de mercado
CO2_PER_TON_FUEL = 3.114 # fator de emissao (IMO) p/ combustivel fossil maritimo

NAV_RES = 1.0
NAV_NLON = 360
NAV_NLAT = 181  # -90..90 inclusive, passo 1 grau
LANDMASK_CACHE = ROOT / ".landmask_cache.json"


# ============================================================
# utilidades de leitura dos arquivos .js (nao sao JSON puro)
# ============================================================
def _read(name):
    p = ROOT / name
    if not p.exists():
        return None
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return None


def _extract_braced_block(text, key):
    """Acha 'key:{ ... }' e devolve o conteudo entre chaves (contagem de
    profundidade -- os valores aqui sao numeros e strings base64, nunca tem
    chave dentro de aspas, entao nao precisa respeitar strings)."""
    m = re.search(re.escape(key) + r"\s*:\s*\{", text)
    if not m:
        return None
    i = m.end()
    depth = 1
    start = i
    n = len(text)
    while depth > 0 and i < n:
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    return text[start:i - 1]


def _num(block, key, cast=float):
    m = re.search(re.escape(key) + r"\s*:\s*([\-0-9.eE]+)", block)
    return cast(m.group(1)) if m else None


def _b64i16(text, key, scale):
    m = re.search(re.escape(key) + r'\s*:\s*"([^"]+)"', text)
    if not m:
        return None
    raw = base64.b64decode(m.group(1))
    count = len(raw) // 2
    return [v / scale for v in struct.unpack("<%dh" % count, raw)]


# ============================================================
# grade de correntes (uo/vo)
# ============================================================
class CurrentGrid:
    def __init__(self, nlon, nlat, lon0, lat0, dlon, dlat, u, v):
        self.nlon, self.nlat = nlon, nlat
        self.lon0, self.lat0, self.dlon, self.dlat = lon0, lat0, dlon, dlat
        self.u, self.v = u, v  # listas planas, row-major (lat x lon), m/s

    def sample(self, lon, lat):
        lon = ((lon + 180.0) % 360.0) - 180.0
        i = int(round((lon - self.lon0) / self.dlon)) % self.nlon
        j = int(round((lat - self.lat0) / self.dlat))
        if j < 0 or j >= self.nlat:
            return (0.0, 0.0)
        idx = j * self.nlon + i
        return (self.u[idx], self.v[idx])


_current_grid = None
_current_grid_lock = threading.Lock()


def get_current_grid():
    global _current_grid
    if _current_grid is not None:
        return _current_grid
    with _current_grid_lock:
        if _current_grid is None:
            _current_grid = _load_current_grid()
        return _current_grid


def _load_current_grid():
    text = _read("dados-marinhos.js")
    if text:
        grid_block = _extract_braced_block(text, "grid")
        frames_m = re.search(r"frames\s*:\s*\[", text)
        if grid_block and frames_m:
            after = text[frames_m.end():]
            u = _b64i16(after, "u", 1000)
            v = _b64i16(after, "v", 1000)
            nlon, nlat = _num(grid_block, "nlon", int), _num(grid_block, "nlat", int)
            lon0, lat0 = _num(grid_block, "lon0"), _num(grid_block, "lat0")
            dlon, dlat = _num(grid_block, "dlon"), _num(grid_block, "dlat")
            if u and v and nlon and nlat:
                return CurrentGrid(nlon, nlat, lon0, lat0, dlon, dlat, u, v)

    text = _read("ocean-data.js")
    if text:
        block = _extract_braced_block(text, "cur")
        if block:
            u = _b64i16(block, "u", 1000)
            v = _b64i16(block, "v", 1000)
            nlon, nlat = _num(block, "nlon", int), _num(block, "nlat", int)
            lon0, lat0 = _num(block, "lon0"), _num(block, "lat0")
            dlon, dlat = _num(block, "dlon"), _num(block, "dlat")
            if u and v and nlon and nlat:
                return CurrentGrid(nlon, nlat, lon0, lat0, dlon, dlat, u, v)

    # sem dado nenhum -> campo zerado (rotas ainda funcionam, so sem empurrao de corrente)
    n = 360 * 181
    zero = [0.0] * n
    return CurrentGrid(360, 181, -180.0, -90.0, 1.0, 1.0, zero, zero)


class ScalarGrid:
    def __init__(self, nlon, nlat, lon0, lat0, dlon, dlat, t):
        self.nlon, self.nlat = nlon, nlat
        self.lon0, self.lat0, self.dlon, self.dlat = lon0, lat0, dlon, dlat
        self.t = t

    def sample(self, lon, lat):
        lon = ((lon + 180.0) % 360.0) - 180.0
        i = int(round((lon - self.lon0) / self.dlon)) % self.nlon
        j = int(round((lat - self.lat0) / self.dlat))
        if j < 0 or j >= self.nlat:
            return None
        return self.t[j * self.nlon + i]


_sst_grid = "unset"


def get_sst_grid():
    global _sst_grid
    if _sst_grid != "unset":
        return _sst_grid
    text = _read("ocean-data.js") or ""
    block = _extract_braced_block(text, "sst")
    if block:
        t = _b64i16(block, "t", 100)
        nlon, nlat = _num(block, "nlon", int), _num(block, "nlat", int)
        lon0, lat0 = _num(block, "lon0"), _num(block, "lat0")
        dlon, dlat = _num(block, "dlon"), _num(block, "dlat")
        if t and nlon and nlat:
            _sst_grid = ScalarGrid(nlon, nlat, lon0, lat0, dlon, dlat, t)
            return _sst_grid
    _sst_grid = None
    return None


# ============================================================
# mascara de terra (GeoJSON world-land.js -> point-in-polygon)
# ============================================================
_land_polys = None


def _load_land_polys():
    global _land_polys
    if _land_polys is not None:
        return _land_polys
    text = _read("world-land.js")
    if not text:
        _land_polys = []
        return _land_polys
    raw = text[text.index("=") + 1:].strip()
    if raw.endswith(";"):
        raw = raw[:-1]
    try:
        gj = json.loads(raw)
    except Exception:
        _land_polys = []
        return _land_polys

    polys = []
    for feat in gj.get("features", []):
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates")
        if not coords:
            continue
        polygons = coords if geom.get("type") == "MultiPolygon" else [coords]
        for poly in polygons:
            if not poly:
                continue
            rings = [[(float(pt[0]), float(pt[1])) for pt in ring] for ring in poly]
            if not rings or len(rings[0]) < 3:
                continue
            lons = [p[0] for p in rings[0]]
            lats = [p[1] for p in rings[0]]
            polys.append(((min(lons), min(lats), max(lons), max(lats)), rings))
    _land_polys = polys
    return polys


def _point_in_ring(x, y, ring):
    inside = False
    x1, y1 = ring[-1]
    for x2, y2 in ring:
        if (y1 > y) != (y2 > y):
            x_int = (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1
            if x < x_int:
                inside = not inside
        x1, y1 = x2, y2
    return inside


def is_land(lon, lat):
    lon = ((lon + 180.0) % 360.0) - 180.0
    for bbox, rings in _load_land_polys():
        if lon < bbox[0] or lon > bbox[2] or lat < bbox[1] or lat > bbox[3]:
            continue
        if _point_in_ring(lon, lat, rings[0]) and not any(
            _point_in_ring(lon, lat, hole) for hole in rings[1:]
        ):
            return True
    return False


_nav_mask = None
_nav_lock = threading.Lock()


def _build_nav_mask():
    global _nav_mask
    if _nav_mask is not None:
        return _nav_mask
    with _nav_lock:
        if _nav_mask is not None:
            return _nav_mask
        if LANDMASK_CACHE.exists():
            try:
                data = json.loads(LANDMASK_CACHE.read_text(encoding="utf-8"))
                if data.get("nlon") == NAV_NLON and data.get("nlat") == NAV_NLAT:
                    _nav_mask = bytes(data["mask"])
                    return _nav_mask
            except Exception:
                pass

        mask = bytearray(NAV_NLON * NAV_NLAT)
        for j in range(NAV_NLAT):
            lat = 90.0 - j * NAV_RES
            for i in range(NAV_NLON):
                lon = -180.0 + i * NAV_RES
                mask[j * NAV_NLON + i] = 0 if (abs(lat) > 84 or is_land(lon, lat)) else 1
        _nav_mask = bytes(mask)
        try:
            LANDMASK_CACHE.write_text(
                json.dumps({"nlon": NAV_NLON, "nlat": NAV_NLAT, "mask": list(_nav_mask)}),
                encoding="utf-8",
            )
        except Exception:
            pass
        return _nav_mask


def warmup():
    """Chamado numa thread em background pelo servidor.py, pra ja deixar a
    grade de correntes e a mascara de terra prontas antes do primeiro pedido."""
    try:
        get_current_grid()
        _build_nav_mask()
    except Exception:
        pass


# ============================================================
# geometria / fisica de rota
# ============================================================
def hav_km(lo1, la1, lo2, la2):
    p1, p2 = math.radians(la1), math.radians(la2)
    dphi = math.radians(la2 - la1)
    dlmb = math.radians(((lo2 - lo1 + 540) % 360) - 180)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def edge_hours(grid, lo1, la1, lo2, la2, ship_kn, current_weight=1.0):
    """Custo de uma aresta = tempo real do trecho: Tempo = Distância / |v⃗_navio + v⃗_corrente|.
    O navio aproa pra compensar a componente transversal da corrente (c⊥) e avança com
    velocidade de fundo sqrt(v² − c⊥²) + c∥: corrente a favor encurta o tempo, contrária
    alonga, e se a corrente vence o navio o trecho é intransponível (inf).
    current_weight=0 → corrente ignorada (planejamento tradicional)."""
    lat_m = (la1 + la2) / 2
    dlon = ((lo2 - lo1 + 540) % 360) - 180
    dx = dlon * 111.32 * math.cos(math.radians(lat_m))
    dy = (la2 - la1) * 110.57
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return 0.0
    ex, ey = dx / length, dy / length

    u_ms, v_ms = grid.sample(lo1 + dlon / 2, lat_m)
    cu = u_ms * 3.6 * current_weight  # m/s -> km/h
    cv = v_ms * 3.6 * current_weight
    c_par = cu * ex + cv * ey
    c_perp2 = max(0.0, cu * cu + cv * cv - c_par * c_par)

    vs = ship_kn * KMH_PER_KN
    avail = vs * vs - c_perp2
    if avail <= 1:
        return float("inf")
    ground = math.sqrt(avail) + c_par
    if ground < 0.5:
        return float("inf")
    return length / ground


def fuel_tons_per_hour(kn):
    return (FUEL_REF_TPD / 24.0) * (kn / FUEL_REF_KN) ** 3


def path_km(path):
    km = 0.0
    for i in range(1, len(path)):
        km += hav_km(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1])
    return km


def route_metrics(path, hours, ship_kn):
    km = path_km(path)
    rate = fuel_tons_per_hour(ship_kn)
    fuel = rate * hours if math.isfinite(hours) else float("inf")
    co2 = fuel * CO2_PER_TON_FUEL
    return {"km": km, "hours": hours, "fuel_tons": fuel, "co2_tons": co2}


def segment_hours(grid, lo1, la1, lo2, la2, ship_kn):
    """Tempo REAL de um trecho já traçado (a corrente age mesmo que o planejamento a
    ignore). Se a corrente contrária vencer o navio, assume avanço mínimo de 25% da
    velocidade de serviço em vez de infinito."""
    dt = edge_hours(grid, lo1, la1, lo2, la2, ship_kn, 1.0)
    if math.isfinite(dt):
        return dt
    return hav_km(lo1, la1, lo2, la2) / (0.25 * ship_kn * KMH_PER_KN)


def path_hours(grid, path, ship_kn):
    return sum(segment_hours(grid, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1], ship_kn)
               for i in range(1, len(path)))


# ---------------- Rota 1: Comercial padrão ----------------
def commercial_route(a_ll, b_ll, ship_kn):
    """Rota comercial tradicional de mercado: o menor caminho NAVEGÁVEL em distância
    (como nas tabelas de distâncias portuárias), a velocidade de serviço constante e
    planejado sem olhar as correntes. O tempo devolvido é o real, com as correntes."""
    r = astar_route(a_ll, b_ll, ship_kn, current_weight=0.0)
    if not r:
        return None
    return {"path": r["path"], "hours": path_hours(get_current_grid(), r["path"], ship_kn)}


# ---------------- Rota 2/3: A* determinístico sobre a grade náutica ----------------
NB8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _nav_lon(o):
    return -180.0 + o * NAV_RES


def _nav_lat(a):
    return 90.0 - a * NAV_RES


def _nav_snap(mask, lon, lat):
    o0 = int(round((lon - (-180.0)) / NAV_RES)) % NAV_NLON
    a0 = max(0, min(NAV_NLAT - 1, int(round((90.0 - lat) / NAV_RES))))
    if mask[a0 * NAV_NLON + o0]:
        return a0, o0
    for r in range(1, 30):
        for da in range(-r, r + 1):
            a = a0 + da
            if a < 0 or a >= NAV_NLAT:
                continue
            for db in range(-r, r + 1):
                if max(abs(da), abs(db)) != r:
                    continue
                o = (o0 + db) % NAV_NLON
                if mask[a * NAV_NLON + o]:
                    return a, o
    return None


def astar_route(a_ll, b_ll, ship_kn, current_weight=1.0, max_nodes=150000):
    grid = get_current_grid()
    mask = _build_nav_mask()
    sa = _nav_snap(mask, a_ll[0], a_ll[1])
    sb = _nav_snap(mask, b_ll[0], b_ll[1])
    if not sa or not sb:
        return None

    start = sa[0] * NAV_NLON + sa[1]
    goal = sb[0] * NAV_NLON + sb[1]
    goal_lon, goal_lat = _nav_lon(sb[1]), _nav_lat(sb[0])
    max_ground = (ship_kn + 6) * KMH_PER_KN

    g = {start: 0.0}
    came = {}
    closed = set()
    h0 = hav_km(_nav_lon(sa[1]), _nav_lat(sa[0]), goal_lon, goal_lat) / max_ground
    heap = [(h0, start)]
    nodes = 0

    while heap:
        _, cur = heapq.heappop(heap)
        if cur in closed:
            continue
        closed.add(cur)
        if cur == goal:
            break
        nodes += 1
        if nodes > max_nodes:
            break
        ca, co = divmod(cur, NAV_NLON)
        clon, clat = _nav_lon(co), _nav_lat(ca)
        for da, db in NB8:
            na = ca + da
            if na < 0 or na >= NAV_NLAT:
                continue
            no = (co + db) % NAV_NLON
            ni = na * NAV_NLON + no
            if not mask[ni] or ni in closed:
                continue
            if da != 0 and db != 0:
                if not mask[ca * NAV_NLON + no] or not mask[na * NAV_NLON + co]:
                    continue
            dt = edge_hours(grid, clon, clat, _nav_lon(no), _nav_lat(na), ship_kn, current_weight)
            if not math.isfinite(dt):
                continue
            ng = g[cur] + dt
            if ng < g.get(ni, float("inf")):
                g[ni] = ng
                came[ni] = cur
                pri = ng + hav_km(_nav_lon(no), _nav_lat(na), goal_lon, goal_lat) / max_ground
                heapq.heappush(heap, (pri, ni))

    if goal not in came and goal != start:
        return None
    path = []
    c = goal
    while True:
        ca, co = divmod(c, NAV_NLON)
        path.append([_nav_lon(co), _nav_lat(ca)])
        if c == start:
            break
        c = came[c]
    path.reverse()
    return {"path": path, "hours": g[goal]}


# ---------------- Rota 3: Copiloto IA — gestão de potência / combustível ----------------
ETA_SLACK = 0.03      # janela de atracação: pode chegar até 3% depois do A* (ou no ETA da rota comercial)
MIN_SPEED_FRAC = 0.75  # piso de slow steaming: abaixo de ~75% da velocidade de serviço o motor opera mal
SPEED_STEP_KN = 0.25


def optimize_power(grid, path, ship_kn, eta_budget_h):
    """Escolhe a velocidade na água (= potência do motor) de cada trecho da rota A* pra
    gastar o mínimo de VLSFO sem estourar o ETA-alvo. Consumo por hora ∝ v³ (lei do
    hélice), então uma hora "comprada" onde a corrente empurra custa bem menos
    combustível do que onde ela freia: o otimizador reduz o motor nos trechos a favor
    e mantém potência nos contrários. Resolvido por relaxação lagrangiana — λ é o
    "preço" de cada hora, ajustado por bisseção até o tempo total caber no ETA."""
    vmin = max(6.0, ship_kn * MIN_SPEED_FRAC)
    speeds = []
    v = ship_kn
    while v >= vmin - 1e-9:
        speeds.append(round(v, 2))
        v -= SPEED_STEP_KN

    segs = []  # por trecho: [(v, horas, toneladas)]
    for i in range(1, len(path)):
        lo1, la1 = path[i - 1]
        lo2, la2 = path[i]
        opts = []
        for v in speeds:
            t = edge_hours(grid, lo1, la1, lo2, la2, v, 1.0)
            if math.isfinite(t):
                opts.append((v, t, fuel_tons_per_hour(v) * t))
        if not opts:  # corrente mais forte que o navio: segue a toda força com avanço mínimo
            t = segment_hours(grid, lo1, la1, lo2, la2, ship_kn)
            opts = [(ship_kn, t, fuel_tons_per_hour(ship_kn) * t)]
        segs.append(opts)

    def solve(lam):
        pick = [min(o, key=lambda x: x[2] + lam * x[1]) for o in segs]
        return pick, sum(p[1] for p in pick)

    pick, total_h = solve(0.0)  # λ=0: tempo não importa -> o mais econômico possível
    if total_h > eta_budget_h:
        lo, hi = 0.0, 1.0
        while solve(hi)[1] > eta_budget_h and hi < 1e6:
            hi *= 2
        for _ in range(45):
            mid = (lo + hi) / 2
            if solve(mid)[1] > eta_budget_h:
                lo = mid
            else:
                hi = mid
        pick, total_h = solve(hi)

    fuel = sum(p[2] for p in pick)
    seg_v = [p[0] for p in pick]
    seg_km = [hav_km(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]) for i in range(1, len(path))]
    km = sum(seg_km) or 1.0
    avg_kn = sum(p[0] * p[1] for p in pick) / total_h if total_h > 0 else ship_kn
    return {
        "km": sum(seg_km),
        "hours": total_h,
        "fuel_tons": fuel,
        "co2_tons": fuel * CO2_PER_TON_FUEL,
        "speeds": [round(v, 2) for v in seg_v],
        "avg_kn": round(avg_kn, 2),
        "min_kn": min(seg_v) if seg_v else ship_kn,
        "max_kn": max(seg_v) if seg_v else ship_kn,
        # carga média do motor (% da potência de serviço), ponderada pelo tempo — potência ∝ v³
        "load_pct": round(100 * fuel / (fuel_tons_per_hour(ship_kn) * total_h), 1) if total_h > 0 else 100.0,
        "eco_share": round(sum(k for k, v in zip(seg_km, seg_v) if v < ship_kn - 0.01) / km, 3),
        "eta_budget_h": eta_budget_h,
        "service_kn": ship_kn,
    }


def llm_rationale(comm_m, astar_m, ai_m):
    """O LLM não traça rota: recebe os números já calculados (rota comercial, A* e o
    perfil de potência) e redige a análise técnica pra equipe de navegação. Sem LLM
    disponível, gera a mesma análise de forma determinística — sempre com os números reais."""
    def pick(m, keys):
        return {k: round(m[k], 2) for k in keys if k in m and isinstance(m[k], (int, float)) and math.isfinite(m[k])}

    base_keys = ("km", "hours", "fuel_tons", "co2_tons")
    ai_desc = pick(ai_m, base_keys + ("avg_kn", "min_kn", "max_kn", "load_pct", "service_kn"))
    ai_desc["fracao_da_distancia_com_motor_reduzido"] = round(ai_m.get("eco_share", 0.0), 3)
    prompt = (
        "Você é o Copiloto IA de um navio, responsável pela gestão de combustível. Três "
        "planos para o mesmo trajeto (todos validados, sem cruzar terra):\n"
        "1) Rota comercial padrão (menor distância, velocidade constante, ignora correntes): %s\n"
        "2) A* (menor tempo usando a matriz de correntes, velocidade constante): %s\n"
        "3) Copiloto IA (mesmo caminho do A*, potência do motor ajustada trecho a trecho "
        "para minimizar VLSFO dentro do ETA): %s\n"
        "Escreva, em português, uma análise técnica de 2 a 3 frases para a equipe de "
        "navegação: onde e por que a potência foi reduzida, quanto VLSFO e CO2 se economiza "
        "em relação à rota comercial e o impacto no ETA. Use os números fornecidos, sem inventar outros. "
        'Responda SOMENTE com um JSON: {"motivo": "..."}'
        % (
            json.dumps(pick(comm_m, base_keys)),
            json.dumps(pick(astar_m, base_keys)),
            json.dumps(ai_desc),
        )
    )
    raw = call_llm_text(prompt)
    if raw:
        try:
            motivo = str(json.loads(_extract_json(raw)).get("motivo") or "").strip()
            if motivo:
                return motivo
        except Exception:
            pass

    if os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY"):
        prefix = "Análise técnica (LLM indisponível — veja [ERRO GEMINI DETALHADO] no terminal): "
    else:
        prefix = "Análise técnica (Copiloto offline, sem GEMINI_API_KEY/OPENAI_API_KEY): "
    return prefix + deterministic_analysis(comm_m, astar_m, ai_m)


def _br(v, d=1):
    """Número no formato brasileiro: 1.234,5"""
    return f"{v:,.{d}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def deterministic_analysis(comm_m, astar_m, ai_m):
    gain_h = comm_m["hours"] - astar_m["hours"]
    dfuel = max(0.0, comm_m["fuel_tons"] - ai_m["fuel_tons"])
    pct = 100 * dfuel / comm_m["fuel_tons"] if comm_m["fuel_tons"] > 0 else 0.0
    eta_delta = ai_m["hours"] - comm_m["hours"]
    eta_txt = (f"chegando {_br(abs(eta_delta))} h antes da rota comercial" if eta_delta < -0.05 else
               f"com ETA {_br(eta_delta)} h após a rota comercial (dentro da janela de atracação)" if eta_delta > 0.05 else
               "mantendo o mesmo ETA da rota comercial")
    return (
        f"o A* ganha {_br(gain_h)} h sobre a rota comercial explorando as correntes; o Copiloto "
        f"converte esse ganho em economia, variando a velocidade entre {_br(ai_m['min_kn'])} e "
        f"{_br(ai_m['max_kn'])} nós (média {_br(ai_m['avg_kn'])} nós, carga média {_br(ai_m['load_pct'], 0)}% "
        f"da potência de serviço) e reduzindo o motor em {_br(100 * ai_m['eco_share'], 0)}% do trajeto. "
        f"Resultado: −{_br(dfuel)} t de VLSFO (−{_br(pct, 0)}%), −{_br(dfuel * CO2_PER_TON_FUEL)} t de CO₂ "
        f"e US$ {_br(dfuel * FUEL_PRICE_USD, 0)} a menos, {eta_txt}."
    )


def compute_three_routes(a_ll, b_ll, ship_kn=18.0):
    grid = get_current_grid()

    comm = commercial_route(a_ll, b_ll, ship_kn)
    astar = astar_route(a_ll, b_ll, ship_kn, current_weight=1.0)
    if not comm or not astar:
        return None
    # A* é ótimo em tempo no mesmo grafo; se por arredondamento a rota comercial sair
    # mais rápida, ela passa a ser a resposta do A* (nunca pior que a comercial).
    if comm["hours"] < astar["hours"]:
        astar = {"path": comm["path"], "hours": comm["hours"]}

    comm_m = route_metrics(comm["path"], comm["hours"], ship_kn)
    astar_m = route_metrics(astar["path"], astar["hours"], ship_kn)

    eta_budget = max(comm["hours"], astar["hours"] * (1 + ETA_SLACK))
    ai_m = optimize_power(grid, astar["path"], ship_kn, eta_budget)
    rationale = llm_rationale(comm_m, astar_m, ai_m)

    return {
        "baseline": dict(path=comm["path"], service_kn=ship_kn, **comm_m),
        "astar": dict(path=astar["path"], service_kn=ship_kn, **astar_m),
        "llm": dict(path=astar["path"], rationale=rationale, **ai_m),
    }


# ============================================================
# ferramentas do copiloto (tool calling)
# ============================================================
_COMPASS = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"]


def bearing_deg(lo1, la1, lo2, la2):
    phi1, phi2 = math.radians(la1), math.radians(la2)
    dlmb = math.radians(lo2 - lo1)
    y = math.sin(dlmb) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlmb)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def compass_dir(deg):
    return _COMPASS[int(((deg + 22.5) % 360) / 45)]


def simular_vazamento(lat, lon, volume_ton=500.0, horas=24):
    grid = get_current_grid()
    horas = max(1, min(72, int(horas)))
    lat, lon = float(lat), float(lon)
    clat, clon = lat, lon
    radius_km = 0.15 * math.sqrt(max(1.0, volume_ton))
    frames = []
    drift_km = 0.0
    prev_lat, prev_lon = lat, lon
    for h in range(1, horas + 1):
        u, v = grid.sample(clon, clat)
        dx_km = u * 3.6
        dy_km = v * 3.6
        clat += dy_km / 110.57
        clon = ((clon + dx_km / (111.32 * math.cos(math.radians(clat)) + 1e-9) + 180) % 360) - 180
        radius_km += 0.35 * math.sqrt(h)  # difusao turbulenta simplificada (~sqrt(t))
        drift_km += hav_km(prev_lon, prev_lat, clon, clat)
        prev_lat, prev_lon = clat, clon
        frames.append({"hour": h, "lat": round(clat, 4), "lon": round(clon, 4),
                        "radius_km": round(radius_km, 2)})

    drift_nm = drift_km * 0.539957
    drift_speed_kn = drift_nm / horas if horas else 0.0
    brg = bearing_deg(lon, lat, clon, clat) if drift_km > 0.05 else None
    compass = compass_dir(brg) if brg is not None else None

    if compass:
        explanation = (
            "Conclusão da IA: Modelo de advecção-difusão calculado com base nos vetores de "
            f"superfície atuais (direção {compass} a {drift_speed_kn:.1f} nós). O navio/mancha "
            f"derivou {drift_nm:.1f} NM ao longo de {horas} horas."
        )
    else:
        explanation = (
            "Conclusão da IA: Modelo de advecção-difusão calculado com base nos vetores de "
            f"superfície atuais — correntes fracas no ponto, deriva de apenas {drift_nm:.1f} NM "
            f"em {horas} horas."
        )

    return {
        "origin": {"lat": lat, "lon": lon},
        "volume_ton": volume_ton,
        "frames": frames,
        "title": "SIMULAÇÃO DE VAZAMENTO & DERIVA",
        "explanation": explanation,
        "drift_hours": horas,
        "drift_days": round(horas / 24.0, 1),
        "drift_km": round(drift_km, 2),
        "drift_nm": round(drift_nm, 2),
        "drift_speed_kn": round(drift_speed_kn, 2),
        "drift_bearing_deg": round(brg, 1) if brg is not None else None,
        "drift_compass": compass,
    }


def prever_cardumes(lat, lon, raio_km=300.0):
    grid = get_current_grid()
    sst = get_sst_grid()
    lat, lon = float(lat), float(lon)
    step = 1.0
    n = max(1, int(raio_km / 111.0))
    candidates = []
    for dj in range(-n, n + 1):
        for di in range(-n, n + 1):
            plat = lat + dj * step
            plon = lon + di * step
            if abs(plat) > 89 or hav_km(lon, lat, plon, plat) > raio_km:
                continue
            t0 = sst.sample(plon, plat) if sst else None
            if sst and t0 is not None:
                t1, t2 = sst.sample(plon + step, plat), sst.sample(plon, plat + step)
                if t1 is None or t2 is None:
                    continue
                score = abs(t1 - t0) + abs(t2 - t0)
                front_kind = "térmica"
            else:
                u0, v0 = grid.sample(plon, plat)
                u1, v1 = grid.sample(plon + step, plat)
                u2, v2 = grid.sample(plon, plat + step)
                score = abs(u1 - u0) + abs(v2 - v0)
                front_kind = "de correntes"
            if score > 0:
                cu, cv = grid.sample(plon, plat)
                candidates.append({
                    "lat": round(plat, 3), "lon": round(plon, 3), "score": score,
                    "sst_c": round(t0, 1) if (sst and t0 is not None) else None,
                    "current_kn": round(math.hypot(cu, cv) * 1.94384, 2),
                    "front_kind": front_kind,
                })
    candidates.sort(key=lambda c: -c["score"])
    top = candidates[:8]
    if top:
        mx = top[0]["score"] or 1.0
        for c in top:
            c["score"] = round(c["score"] / mx, 3)
            speed_desc = ("desacelerados" if c["current_kn"] < 0.5 else
                          "moderados" if c["current_kn"] < 1.2 else "intensos")
            sst_txt = (" (SST %.1f°C)" % c["sst_c"]) if c["sst_c"] is not None else ""
            c["title"] = "ZONA DE ALTA PRODUTIVIDADE BIOLÓGICA"
            c["explanation"] = (
                f"Conclusão da IA: Frente de convergência {c['front_kind']} detectada{sst_txt} com "
                f"vetores de corrente {speed_desc} (~{c['current_kn']:.1f} nós), favorecendo o "
                "acúmulo de fitoplâncton e agregação de pelágicos."
            )
            del c["front_kind"]
    return {"origin": {"lat": lat, "lon": lon}, "raio_km": raio_km, "hotspots": top}


# ============================================================
# LLM (Gemini / OpenAI) via REST cru + roteamento de ferramentas em JSON
# ============================================================
def _http_post_json(url, payload, headers=None, timeout=25):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return {"_error": e.read().decode("utf-8"), "_status": e.code}
        except Exception:
            return {"_error": str(e), "_status": e.code}
    except Exception as e:  # timeout, sem rede, DNS...
        return {"_error": str(e), "_status": None}


def _extract_json(text):
    m = re.search(r"\{.*\}", text, re.S)
    return m.group(0) if m else text


# Modelos tentados em ordem. "gemini-3.6-flash" vem primeiro porque foi o que a própria
# API do Google indicou (no erro 404 do 2.5-flash) e o único que já respondeu com sucesso
# com esta chave; os demais ficam como fallback.
MODELOS_GEMINI = ["gemini-3.6-flash", "gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash-exp"]
# 404 = modelo inexistente/aposentado, 429 = cota, 5xx = sobrecarga, None = timeout/rede:
# nesses casos vale tentar o próximo modelo. 400/401/403 (chave ou pedido inválido)
# falhariam igual em todos, então paramos na hora.
_GEMINI_RETRY_STATUS = {404, 429, 500, 502, 503, 504, None}
LLM_TIMEOUT_S = 10          # por modelo
LLM_TOTAL_BUDGET_S = 20     # somando todas as tentativas — a interface nunca espera mais que isso
_gemini_dead = set()        # modelos que deram 404: não insiste neles de novo nesta execução
_gemini_last_ok = None      # último que funcionou: tentado primeiro na próxima chamada


def _call_gemini(body_text, gem_key):
    global _gemini_last_ok
    ordem = [m for m in MODELOS_GEMINI if m not in _gemini_dead]
    if _gemini_last_ok in ordem:
        ordem.remove(_gemini_last_ok)
        ordem.insert(0, _gemini_last_ok)

    inicio = time.monotonic()
    for model_name in ordem:
        restante = LLM_TOTAL_BUDGET_S - (time.monotonic() - inicio)
        if restante < 2:
            print("[GEMINI] tempo total esgotado — usando a simulação otimizada.")
            return None
        url = ("https://generativelanguage.googleapis.com/v1beta/models/"
               f"{model_name}:generateContent?key={gem_key}")
        res = _http_post_json(url, {"contents": [{"parts": [{"text": body_text}]}]},
                              timeout=min(LLM_TIMEOUT_S, restante))
        if "_error" in res:
            status = res.get("_status")
            print(f"[ERRO GEMINI DETALHADO] ({model_name}, status {status}): {res['_error']}")
            if status == 404:
                _gemini_dead.add(model_name)
            if status in _GEMINI_RETRY_STATUS:
                continue
            return None
        try:
            texto = res["candidates"][0]["content"]["parts"][0]["text"]
        except Exception as e:
            print(f"[ERRO GEMINI DETALHADO] ({model_name}): resposta sem texto — {e}")
            continue
        if _gemini_last_ok != model_name:
            print(f"[GEMINI] respondendo com o modelo {model_name}")
        _gemini_last_ok = model_name
        return texto

    print("[GEMINI] nenhum modelo respondeu — usando a simulação otimizada.")
    return None


def call_llm_text(prompt, system=None):
    gem_key = os.environ.get("GEMINI_API_KEY")
    oai_key = os.environ.get("OPENAI_API_KEY")

    if gem_key:
        body_text = (system + "\n\n" + prompt) if system else prompt
        return _call_gemini(body_text, gem_key)

    if oai_key:
        msgs = ([{"role": "system", "content": system}] if system else []) + \
               [{"role": "user", "content": prompt}]
        res = _http_post_json(
            "https://api.openai.com/v1/chat/completions",
            {"model": "gpt-4o-mini", "messages": msgs},
            headers={"Authorization": "Bearer " + oai_key},
            timeout=LLM_TIMEOUT_S,
        )
        try:
            return res["choices"][0]["message"]["content"]
        except Exception:
            return None

    return None


TOOL_SYSTEM_PROMPT = """Voce e o Copiloto IA Maritimo, assistente de um mapa de correntes oceanicas e rotas de navios.
Voce tem duas ferramentas:
  - simular_vazamento(lat, lon, volume_ton, horas): simula a dispersao de uma mancha de oleo a partir de um ponto.
  - prever_cardumes(lat, lon, raio_km): aponta zonas com maior probabilidade de cardumes perto de um ponto.
Se o pedido do usuario exigir uma dessas ferramentas, responda SOMENTE com um JSON, sem nenhum texto ao redor:
  {"tool": "simular_vazamento", "args": {"lat": <num>, "lon": <num>, "volume_ton": <num>, "horas": <num>}}
  {"tool": "prever_cardumes", "args": {"lat": <num>, "lon": <num>, "raio_km": <num>}}
Se nao precisar de nenhuma ferramenta, responda SOMENTE com:
  {"tool": null, "reply": "sua resposta em portugues, curta e objetiva"}
Use o "ponto atual" informado no contexto quando o usuario disser 'aqui'/'ponto atual' e nao der coordenadas.
Nao invente coordenadas de rota nautica -- isso e calculado por outro sistema; seu papel aqui e conversar e
decidir quando chamar as ferramentas acima.
"""


def llm_chat(message, context=None, history=None):
    context = context or {}
    ctx_txt = ""
    if context.get("lat") is not None and context.get("lon") is not None:
        ctx_txt = "\nPonto atual do mapa: lat=%.3f, lon=%.3f." % (context["lat"], context["lon"])

    hist_txt = ""
    for h in (history or [])[-6:]:
        who = "Usuario" if h.get("role") == "user" else "Copiloto"
        hist_txt += "\n%s: %s" % (who, h.get("text", ""))

    prompt = "%s\nUsuario: %s%s" % (hist_txt, message, ctx_txt)
    raw = call_llm_text(prompt, system=TOOL_SYSTEM_PROMPT)

    if raw is None:
        return _fallback_chat(message, context)

    try:
        data = json.loads(_extract_json(raw))
    except Exception:
        return {"reply": raw.strip(), "tool": None, "data": None}

    tool = data.get("tool")
    args = data.get("args") or {}
    lat = args.get("lat", context.get("lat"))
    lon = args.get("lon", context.get("lon"))

    if tool == "simular_vazamento" and lat is not None and lon is not None:
        volume = float(args.get("volume_ton", 500))
        horas = int(args.get("horas", 24))
        result = simular_vazamento(lat, lon, volume, horas)
        last = result["frames"][-1]
        reply = (
            "🚨 Simulei o vazamento de %.0ft em (%.2f, %.2f) por %dh. A mancha derivou %.1f NM "
            "(%.1f nós médios) até (%.2f, %.2f), raio final ~%.1f km."
            % (volume, lat, lon, horas, result["drift_nm"], result["drift_speed_kn"],
               last["lat"], last["lon"], last["radius_km"])
        )
        return {"reply": reply, "tool": "simular_vazamento", "data": result}

    if tool == "prever_cardumes" and lat is not None and lon is not None:
        raio = float(args.get("raio_km", 300))
        result = prever_cardumes(lat, lon, raio)
        reply = (
            "🐟 Encontrei %d zona(s) de provável concentração de cardumes num raio de %.0f km a "
            "partir de (%.2f, %.2f) — frentes de convergência/divergência térmica das correntes."
            % (len(result["hotspots"]), raio, lat, lon)
        )
        return {"reply": reply, "tool": "prever_cardumes", "data": result}

    return {"reply": data.get("reply", raw.strip()), "tool": None, "data": None}


def _fallback_chat(message, context):
    """Sem GEMINI_API_KEY / OPENAI_API_KEY -- roteamento local por palavra-chave,
    pro copiloto continuar funcional (com as ferramentas de verdade) mesmo sem LLM."""
    low = message.lower()
    lat, lon = context.get("lat"), context.get("lon")

    if "vazamento" in low or "óleo" in low or "oleo" in low or "derrame" in low:
        if lat is None or lon is None:
            return {"reply": "Aponte pra um ponto do mapa primeiro (ou informe lat/lon) e peça de novo.",
                    "tool": None, "data": None}
        result = simular_vazamento(lat, lon, 500, 24)
        return {"reply": "🚨 (modo sem LLM) Simulação de vazamento de 500t por 24h a partir do ponto atual, "
                          "seguindo as correntes locais.", "tool": "simular_vazamento", "data": result}

    if "cardum" in low or "peixe" in low or "pesca" in low:
        if lat is None or lon is None:
            return {"reply": "Aponte pra um ponto do mapa primeiro (ou informe lat/lon) e peça de novo.",
                    "tool": None, "data": None}
        result = prever_cardumes(lat, lon, 300)
        return {"reply": "🐟 (modo sem LLM) Zonas de frente térmica/de corrente identificadas perto do "
                          "ponto atual.", "tool": "prever_cardumes", "data": result}

    return {"reply": "Copiloto em modo offline — defina GEMINI_API_KEY ou OPENAI_API_KEY no ambiente pra "
                      "respostas geradas por IA. Mesmo assim eu simulo vazamentos de óleo e aponto zonas de "
                      "cardumes a partir de um ponto do mapa, e ajudo a comparar rotas — é só pedir.",
            "tool": None, "data": None}


if __name__ == "__main__":
    # smoke test rapido, sem servidor: roda so se o modulo for chamado direto
    print("aquecendo (mascara de terra + grade de correntes)...")
    warmup()
    a, b = (-46.33, -23.96), (4.15, 51.95)  # Santos -> Roterda
    print("calculando as 3 rotas Santos -> Roterda...")
    res = compute_three_routes(a, b, 18.0)
    if not res:
        print("nao achei rota (confira se world-land.js existe).")
    else:
        for k in ("baseline", "astar", "llm"):
            m = res[k]
            print(f"  {k:9s}  {m['km']:8.0f} km   {m['hours']:6.1f} h   {m['fuel_tons']:6.1f} t")
        print("  motivo LLM:", res["llm"].get("rationale"))
