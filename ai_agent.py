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


_raw_mask = None
_nav_lock = threading.Lock()


def _raw_nav_mask():
    """Terra/água bruta da grade de 1° (point-in-polygon no world-land.js), cacheada em disco."""
    global _raw_mask
    if _raw_mask is not None:
        return _raw_mask
    with _nav_lock:
        if _raw_mask is not None:
            return _raw_mask
        if LANDMASK_CACHE.exists():
            try:
                data = json.loads(LANDMASK_CACHE.read_text(encoding="utf-8"))
                if data.get("nlon") == NAV_NLON and data.get("nlat") == NAV_NLAT:
                    _raw_mask = bytes(data["mask"])
                    return _raw_mask
            except Exception:
                pass

        mask = bytearray(NAV_NLON * NAV_NLAT)
        for j in range(NAV_NLAT):
            lat = 90.0 - j * NAV_RES
            for i in range(NAV_NLON):
                lon = -180.0 + i * NAV_RES
                mask[j * NAV_NLON + i] = 0 if (abs(lat) > 84 or is_land(lon, lat)) else 1
        try:
            LANDMASK_CACHE.write_text(
                json.dumps({"nlon": NAV_NLON, "nlat": NAV_NLAT, "mask": list(mask)}),
                encoding="utf-8",
            )
        except Exception:
            pass
        _raw_mask = bytes(mask)
        return _raw_mask


# ---------------- cenário de navegação: estreitos, canais, gelo ártico e zonas de risco ----------------
# Na grade de 1° (e no contorno 1:110m) vários estreitos reais somem e isolam mares inteiros.
# Estes corredores de células (lat, lon) são SEMPRE navegáveis — ligam esses mares ao oceano.
STRAITS = {
    "Estreito de Dover": [(51, 2), (51, 1), (50, 1), (50, 0), (50, -1)],
    "Estreito de Juan de Fuca": [(48, -123), (48, -124), (48, -125), (48, -126)],
    "Estreitos dinamarqueses": [(58, 10), (57, 10), (57, 11), (56, 11), (56, 12), (55, 12), (55, 13),
                                (55, 14), (55, 15), (55, 16)],
    "Bósforo e Dardanelos": [(42, 29), (41, 29), (41, 28), (40, 28), (40, 27), (40, 26), (39, 26), (39, 25)],
    "Mar Egeu": [(40, 23), (40, 24), (39, 24), (38, 24), (38, 25), (37, 25), (36, 25), (35, 25)],
    "Bab-el-Mandeb": [(14, 42), (13, 42), (13, 43), (12, 43), (12, 44), (12, 45)],
    "Estuário do São Lourenço": [(49, -68), (49, -67), (49, -66), (50, -66), (50, -65)],
    "Golfo da Finlândia": [(58, 20), (59, 20), (59, 21), (59, 22), (59, 23), (59, 24), (60, 24), (60, 25),
                           (60, 26), (60, 27), (60, 28)],
    "Golfo de Honduras": [(16, -88), (16, -87), (16, -86), (17, -86), (17, -85), (17, -84)],
    "Estreito de Malaca": [(6, 96), (6, 97), (5, 97), (5, 98), (4, 98), (4, 99), (3, 99), (3, 100), (2, 100),
                           (2, 101), (2, 102), (1, 102), (1, 103), (1, 104), (1, 105)],
}
# Istmos que a grade de 1° "vaza" (ex.: a lagoa de Chiriquí em 9°N 82°O deixava o A* cruzar a
# América Central por terra, com ou sem Canal do Panamá). Nestas caixas (lat0, lat1, lon0, lon1),
# toda célula de água encostada em terra vira terra; a passagem volta só pelo corredor do canal.
ISTHMUS_BOXES = [(7.0, 18.5, -95.0, -77.5)]
# Canais artificiais: abertos por padrão, fechados pelo usuário (cenário de bloqueio).
CANALS = {
    # passa pela célula 9°N 79,6°O; as pontas vão até água aberta dos dois lados do istmo
    "panama": [(12, -80), (11, -80), (10, -80), (9, -80), (9, -79), (8, -79), (7, -79), (6, -79)],
    "suez": [(31, 32), (30, 32), (29, 32), (29, 33), (28, 33), (27, 33), (27, 34)],  # inclui 29,9°N 32,5°E
}
# Acima disto o Ártico fica fechado ao tráfego comercial (gelo marinho); sem isso o A* "atalhava"
# pela Passagem do Noroeste / Rota do Mar do Norte, que navios comerciais não usam.
ARCTIC_MAX_LAT = 73.0
# Zonas de alto risco (pirataria/conflito): caixas (lat0, lat1, lon0, lon1) com custo multiplicado.
RISK_ZONES = {
    "redsea": [(12.0, 30.5, 32.0, 44.0), (10.0, 16.0, 42.0, 52.0)],  # Mar Vermelho + Golfo de Áden
}
RISK_PENALTY = 25.0  # "penalização extrema": só entra se não houver alternativa razoável

_nav_masks = {}


def _scenario_key(scenario):
    s = scenario or {}
    return (not s.get("block_panama"), not s.get("block_suez"))


def nav_mask_for(scenario=None):
    """Máscara de navegação do cenário: água bruta + estreitos + canais abertos − Ártico, só com o
    oceano conectado (lagos e mares sem saída saem). Cacheada por combinação de canais."""
    key = _scenario_key(scenario)
    if key in _nav_masks:
        return _nav_masks[key]
    raw = _raw_nav_mask()
    mask = bytearray(raw)
    for la0, la1, lo0, lo1 in ISTHMUS_BOXES:
        for lat in range(int(math.ceil(la0)), int(math.floor(la1)) + 1):
            for lon in range(int(math.ceil(lo0)), int(math.floor(lo1)) + 1):
                a = int(round((90.0 - lat) / NAV_RES))
                o = int(round((lon + 180.0) / NAV_RES)) % NAV_NLON
                if raw[a * NAV_NLON + o] and any(
                    not raw[(a + da) * NAV_NLON + (o + db) % NAV_NLON] for da, db in NB8
                ):
                    mask[a * NAV_NLON + o] = 0

    def open_cells(cells):
        for lat, lon in cells:
            a = int(round((90.0 - lat) / NAV_RES))
            o = int(round((lon + 180.0) / NAV_RES)) % NAV_NLON
            mask[a * NAV_NLON + o] = 1

    for cells in STRAITS.values():
        open_cells(cells)
    if key[0]:
        open_cells(CANALS["panama"])
    if key[1]:
        open_cells(CANALS["suez"])
    for a in range(NAV_NLAT):
        if 90.0 - a * NAV_RES > ARCTIC_MAX_LAT:
            mask[a * NAV_NLON:(a + 1) * NAV_NLON] = bytes(NAV_NLON)
    result = _keep_ocean_only(mask)
    _nav_masks[key] = result
    return result


def _build_nav_mask():
    return nav_mask_for(None)


def risk_boxes(scenario):
    s = scenario or {}
    return RISK_ZONES["redsea"] if s.get("avoid_redsea") else []


def risk_factor(lon, lat, boxes):
    for la0, la1, lo0, lo1 in boxes:
        if la0 <= lat <= la1 and lo0 <= lon <= lo1:
            return RISK_PENALTY
    return 1.0


def _keep_ocean_only(mask):
    """Zera as células de água que não se ligam ao oceano (lagos/mares fechados no
    contorno do mapa): fica só o maior componente conectado, com as MESMAS regras de
    movimento do A* (8 vizinhos, volta no antimeridiano, diagonal só sem cortar quina
    de terra). Assim nenhum porto é "encaixado" num nó que o A* não alcança."""
    mask = bytearray(mask)
    comp = [0] * len(mask)
    best_id, best_size, cid = 0, 0, 0
    for start in range(len(mask)):
        if not mask[start] or comp[start]:
            continue
        cid += 1
        comp[start] = cid
        stack, size = [start], 0
        while stack:
            cur = stack.pop()
            size += 1
            ca, co = divmod(cur, NAV_NLON)
            for da, db in NB8:
                na = ca + da
                if na < 0 or na >= NAV_NLAT:
                    continue
                no = (co + db) % NAV_NLON
                ni = na * NAV_NLON + no
                if not mask[ni] or comp[ni]:
                    continue
                if da and db and not (mask[ca * NAV_NLON + no] and mask[na * NAV_NLON + co]):
                    continue
                comp[ni] = cid
                stack.append(ni)
        if size > best_size:
            best_id, best_size = cid, size
    for i in range(len(mask)):
        if mask[i] and comp[i] != best_id:
            mask[i] = 0
    return bytes(mask)


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
def commercial_route(a_ll, b_ll, ship_kn, scenario=None):
    """Rota comercial tradicional de mercado: o menor caminho NAVEGÁVEL em distância
    (como nas tabelas de distâncias portuárias), a velocidade de serviço constante e
    planejado sem olhar as correntes. O tempo devolvido é o real, com as correntes."""
    r = astar_route(a_ll, b_ll, ship_kn, current_weight=0.0, scenario=scenario)
    if not r:
        return None
    return {"path": r["path"], "hours": path_hours(get_current_grid(), r["path"], ship_kn)}


# ---------------- Rota 2/3: A* determinístico sobre a grade náutica ----------------
NB8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _nav_lon(o):
    return -180.0 + o * NAV_RES


def _nav_lat(a):
    return 90.0 - a * NAV_RES


def find_nearest_water_cell(lat, lon, grid, max_radius=3, fallback_radius=30):
    """Nó de água navegável (ligado ao oceano) mais próximo de (lat, lon) na grade
    náutica `grid` (a máscara de navegação). Se o nó do porto cair em terra, busca em
    espiral — anéis de raio 1 a `max_radius` nós primeiro; portos muito para dentro do
    continente (ex.: Manaus) continuam a busca até `fallback_radius`. Devolve (linha,
    coluna) do nó, que vira o início/fim do A*, ou None."""
    o0 = int(round((lon - (-180.0)) / NAV_RES)) % NAV_NLON
    a0 = max(0, min(NAV_NLAT - 1, int(round((90.0 - lat) / NAV_RES))))
    if grid[a0 * NAV_NLON + o0]:
        return a0, o0
    for r in range(1, max(max_radius, fallback_radius) + 1):
        best, best_d = None, float("inf")  # dentro do anel, o nó mais perto de verdade
        for da in range(-r, r + 1):
            a = a0 + da
            if a < 0 or a >= NAV_NLAT:
                continue
            for db in range(-r, r + 1):
                if max(abs(da), abs(db)) != r:
                    continue
                o = (o0 + db) % NAV_NLON
                if grid[a * NAV_NLON + o]:
                    d = hav_km(lon, lat, _nav_lon(o), _nav_lat(a))
                    if d < best_d:
                        best, best_d = (a, o), d
        if best:
            return best
    return None


def astar_route(a_ll, b_ll, ship_kn, current_weight=1.0, max_nodes=150000, scenario=None):
    """A* de menor tempo: custo da aresta = edge_hours (tempo real com a corrente), multiplicado
    pela penalidade de zona de risco do cenário. `hours` é sempre o tempo real (sem a penalidade)."""
    grid = get_current_grid()
    max_ground = (ship_kn + 6) * KMH_PER_KN
    boxes = risk_boxes(scenario)

    def cost(lo1, la1, lo2, la2):
        dt = edge_hours(grid, lo1, la1, lo2, la2, ship_kn, current_weight)
        return dt * risk_factor((lo1 + lo2) / 2, (la1 + la2) / 2, boxes) if boxes else dt

    r = _grid_search(a_ll, b_ll, cost, lambda km: km / max_ground, max_nodes, nav_mask_for(scenario))
    if not r:
        return None
    hours = r["cost"] if not boxes else sum(
        edge_hours(grid, r["path"][i - 1][0], r["path"][i - 1][1], r["path"][i][0], r["path"][i][1],
                   ship_kn, current_weight) for i in range(1, len(r["path"])))
    return {"path": r["path"], "hours": hours}


# ---------------- Rota 3: Copiloto IA — busca própria focada em combustível ----------------
AI_ADVERSE_WEIGHT = 1.5    # fator acrescido sobre a corrente contrária dentro da lei cúbica
AI_CROSS_PENALTY = 0.8     # peso extra por corrente transversal (motor gasto só p/ manter o rumo)


def _edge_current_kmh(grid, lo1, la1, lo2, la2):
    """Comprimento do trecho (km) e componentes da corrente ao longo (c∥) e através (c⊥) dele, em km/h."""
    lat_m = (la1 + la2) / 2
    dlon = ((lo2 - lo1 + 540) % 360) - 180
    dx = dlon * 111.32 * math.cos(math.radians(lat_m))
    dy = (la2 - la1) * 110.57
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return 0.0, 0.0, 0.0
    ex, ey = dx / length, dy / length
    u_ms, v_ms = grid.sample(lo1 + dlon / 2, lat_m)
    cu, cv = u_ms * 3.6, v_ms * 3.6
    c_par = cu * ex + cv * ey
    c_perp = math.sqrt(max(0.0, cu * cu + cv * cv - c_par * c_par))
    return length, c_par, c_perp


AI_MODE_LABEL = "100% Eco / Slow Steaming"


def ai_astar_route(a_ll, b_ll, ship_kn, max_nodes=150000, scenario=None):
    """Busca A* do Copiloto IA em 100% Eco (slow steaming agressivo + fuga de correntes contrárias):
        Custo(aresta) = Combustível(v³) / consumo_horário_de_serviço
    Combustível = t queimadas no piso de slow steaming (75% da velocidade de serviço; consumo/h ∝ v³),
    com penalidade cúbica na corrente contrária — ((v + k·c)/v)³ — e linear na transversal.
    O divisor só normaliza a escala; o tempo de viagem não entra no custo."""
    grid = get_current_grid()
    v_plan = max(6.0, ship_kn * ECO_ETA_FRAC)
    vs = v_plan * KMH_PER_KN
    rate = fuel_tons_per_hour(v_plan)
    rate_service = fuel_tons_per_hour(ship_kn)
    weight = AI_ADVERSE_WEIGHT
    cross = AI_CROSS_PENALTY
    boxes = risk_boxes(scenario)

    def cost(lo1, la1, lo2, la2):
        length, c_par, c_perp = _edge_current_kmh(grid, lo1, la1, lo2, la2)
        if length == 0.0:
            return 0.0
        avail = vs * vs - c_perp * c_perp
        if avail <= 1:
            return float("inf")
        ground = math.sqrt(avail) + c_par
        if ground < 0.5:
            return float("inf")
        dt = length / ground
        # manter a mesma velocidade de fundo contra uma corrente c exige ~(v + c) na água,
        # e o consumo/h cresce com o cubo disso: ((v + k·c)/v)³ penaliza os nós de mar de proa
        adverse = ((vs + weight * max(0.0, -c_par)) / vs) ** 3
        fuel = rate * dt * adverse * (1.0 + cross * c_perp / vs)
        c = fuel / rate_service
        return c * risk_factor((lo1 + lo2) / 2, (la1 + la2) / 2, boxes) if boxes else c

    max_ground = vs + 6 * KMH_PER_KN
    per_km = (rate / rate_service) / max_ground  # penalidades >= 1: admissível
    r = _grid_search(a_ll, b_ll, cost, lambda km: per_km * km, max_nodes, nav_mask_for(scenario))
    if not r:
        return None
    return {"path": r["path"], "hours": path_hours(grid, r["path"], ship_kn)}


def _grid_search(a_ll, b_ll, edge_cost, heuristic, max_nodes=150000, mask=None):
    """A* genérico na grade náutica (8 vizinhos, sem cortar quina de terra).
    edge_cost(lon1, lat1, lon2, lat2) -> custo >= 0 (inf = intransponível);
    heuristic(km_restantes) -> estimativa otimista do custo até o destino;
    mask: máscara de navegação do cenário (padrão: canais abertos)."""
    if mask is None:
        mask = _build_nav_mask()
    sa = find_nearest_water_cell(a_ll[1], a_ll[0], mask)
    sb = find_nearest_water_cell(b_ll[1], b_ll[0], mask)
    if not sa or not sb:
        return None

    start = sa[0] * NAV_NLON + sa[1]
    goal = sb[0] * NAV_NLON + sb[1]
    goal_lon, goal_lat = _nav_lon(sb[1]), _nav_lat(sb[0])

    g = {start: 0.0}
    came = {}
    closed = set()
    h0 = heuristic(hav_km(_nav_lon(sa[1]), _nav_lat(sa[0]), goal_lon, goal_lat))
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
            dc = edge_cost(clon, clat, _nav_lon(no), _nav_lat(na))
            if not math.isfinite(dc):
                continue
            ng = g[cur] + dc
            if ng < g.get(ni, float("inf")):
                g[ni] = ng
                came[ni] = cur
                pri = ng + heuristic(hav_km(_nav_lon(no), _nav_lat(na), goal_lon, goal_lat))
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
    return {"path": path, "cost": g[goal]}


# ---------------- Rota 3: Copiloto IA — gestão de potência / combustível ----------------
MIN_SPEED_FRAC = 0.60  # piso do motor por trecho (slow steaming profundo): 60% da velocidade de serviço
ECO_ETA_FRAC = 0.75    # ETA-alvo 100% Eco = tempo do trajeto a 75% da velocidade de serviço
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


def _offline_prefix():
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY"):
        return "Análise técnica (LLM indisponível — veja os avisos do Gemini no terminal): "
    return "Análise técnica (Copiloto offline, sem GEMINI_API_KEY/OPENAI_API_KEY): "


def llm_rationale(comm_m, astar_m, ai_m, scenario=None, rationale_fn=None):
    """O LLM não traça rota: recebe os números já calculados (rota comercial, A* e o
    perfil de potência) e redige a análise técnica pra equipe de navegação. Sem LLM
    disponível, gera a mesma análise de forma determinística — sempre com os números reais.

    rationale_fn(comm_m, astar_m, ai_m, scenario) -> str | None: gerador externo do parecer
    (o servidor usa a SDK google.generativeai). Quando informado, substitui a chamada REST
    interna; se devolver None, cai direto no texto determinístico."""
    if rationale_fn is not None:
        try:
            texto = rationale_fn(comm_m, astar_m, ai_m, scenario)
        except Exception as e:
            print(f"[GEMINI INFO] gerador de parecer falhou: {e}")
            texto = None
        if texto and str(texto).strip():
            return str(texto).strip()
        return _offline_prefix() + deterministic_analysis(comm_m, astar_m, ai_m)

    def pick(m, keys):
        return {k: round(m[k], 2) for k in keys if k in m and isinstance(m[k], (int, float)) and math.isfinite(m[k])}

    base_keys = ("km", "hours", "fuel_tons", "co2_tons")
    ai_desc = pick(ai_m, base_keys + ("avg_kn", "min_kn", "max_kn", "load_pct", "service_kn"))
    ai_desc["fracao_da_distancia_com_motor_reduzido"] = round(ai_m.get("eco_share", 0.0), 3)
    contexto = ""
    if scenario_label(scenario):
        contexto += f"Cenário geopolítico ativo: {scenario_label(scenario)}.\n"
    prompt = (
        "Você é o Copiloto IA de um navio, responsável pela gestão de combustível. Três "
        "planos para o mesmo trajeto (todos validados, sem cruzar terra):\n"
        f"1) Rota comercial padrão (menor distância, velocidade constante, ignora correntes): "
        f"{json.dumps(pick(comm_m, base_keys))}\n"
        f"2) A* (menor tempo usando a matriz de correntes, velocidade constante): "
        f"{json.dumps(pick(astar_m, base_keys))}\n"
        "3) Copiloto IA em 100% Eco (slow steaming agressivo; traçado próprio, buscado para minimizar combustível evitando "
        "correntes contrárias e transversais fortes, com a potência do motor ajustada trecho "
        f"a trecho dentro do ETA): {json.dumps(ai_desc)}\n"
        f"{contexto}"
        "Escreva, em português, uma análise técnica de 2 a 3 frases para a equipe de "
        "navegação: por que o traçado do Copiloto difere do A*, onde a potência foi reduzida, "
        "quanto VLSFO e CO2 se economiza em relação à rota comercial e o impacto no ETA"
        f"{' e do cenário geopolítico' if scenario_label(scenario) else ''}. "
        "Use os números fornecidos, sem inventar outros. "
        'Responda SOMENTE com um JSON: {"motivo": "..."}'
    )
    raw = call_llm_text(prompt)
    if raw:
        try:
            motivo = str(json.loads(_extract_json(raw)).get("motivo") or "").strip()
            if motivo:
                return motivo
        except Exception:
            pass

    return _offline_prefix() + deterministic_analysis(comm_m, astar_m, ai_m)


def _br(v, d=1):
    """Número no formato brasileiro: 1.234,5"""
    return f"{v:,.{d}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def deterministic_analysis(comm_m, astar_m, ai_m):
    gain_h = comm_m["hours"] - astar_m["hours"]
    dfuel = max(0.0, comm_m["fuel_tons"] - ai_m["fuel_tons"])
    pct = 100 * dfuel / comm_m["fuel_tons"] if comm_m["fuel_tons"] > 0 else 0.0
    eta_delta = ai_m["hours"] - comm_m["hours"]
    eta_txt = (f"chegando {_br(abs(eta_delta))} h antes da rota comercial" if eta_delta < -0.05 else
               f"com ETA {_br(eta_delta)} h após a rota comercial" if eta_delta > 0.05 else
               "mantendo o mesmo ETA da rota comercial")
    dkm = ai_m["km"] - astar_m["km"]
    rota_txt = (f"traça um desvio próprio {_br(abs(dkm) * 0.539957)} NM "
                f"{'mais longo' if dkm > 0 else 'mais curto'} que o A* para fugir de correntes contrárias e transversais"
                if abs(dkm) > 1 else "segue praticamente o mesmo corredor do A* (correntes fracas nesta travessia)")
    return (
        f"o A* ganha {_br(gain_h)} h sobre a rota comercial explorando as correntes; o Copiloto "
        f"{rota_txt}, variando a velocidade entre {_br(ai_m['min_kn'])} e "
        f"{_br(ai_m['max_kn'])} nós (média {_br(ai_m['avg_kn'])} nós, carga média {_br(ai_m['load_pct'], 0)}% "
        f"da potência de serviço) e reduzindo o motor em {_br(100 * ai_m['eco_share'], 0)}% do trajeto. "
        f"Resultado: −{_br(dfuel)} t de VLSFO (−{_br(pct, 0)}%), −{_br(dfuel * CO2_PER_TON_FUEL)} t de CO₂ "
        f"e US$ {_br(dfuel * FUEL_PRICE_USD, 0)} a menos, {eta_txt}."
    )


def scenario_label(scenario):
    s = scenario or {}
    parts = []
    if s.get("block_panama"):
        parts.append("Canal do Panamá bloqueado")
    if s.get("block_suez"):
        parts.append("Canal de Suez bloqueado")
    if s.get("avoid_redsea"):
        parts.append("evitando Mar Vermelho / Golfo de Áden")
    return "; ".join(parts)


def compute_three_routes(a_ll, b_ll, ship_kn=18.0, scenario=None, rationale_fn=None):
    """3 rotas no cenário dado; o Copiloto IA opera sempre em 100% Eco.
    scenario = {"block_panama", "block_suez"} (booleans)."""
    grid = get_current_grid()

    comm = commercial_route(a_ll, b_ll, ship_kn, scenario)
    astar = astar_route(a_ll, b_ll, ship_kn, current_weight=1.0, scenario=scenario)
    if not comm or not astar:
        return None
    # A* é ótimo em tempo no mesmo grafo; se por arredondamento a rota comercial sair
    # mais rápida, ela passa a ser a resposta do A* (nunca pior que a comercial).
    if comm["hours"] < astar["hours"]:
        astar = {"path": comm["path"], "hours": comm["hours"]}

    comm_m = route_metrics(comm["path"], comm["hours"], ship_kn)
    astar_m = route_metrics(astar["path"], astar["hours"], ship_kn)

    # traçado próprio do Copiloto (100% Eco); sem ele, cai no caminho do A*
    ai_path_res = ai_astar_route(a_ll, b_ll, ship_kn, scenario=scenario) or astar
    # ETA-alvo da gestão de potência (100% Eco): até o piso de slow steaming
    # (75% da velocidade) no trajeto inteiro; por trecho o motor pode ir de 60% a 100%,
    # então o otimizador redistribui a potência conforme as correntes
    eta_budget = ai_path_res["hours"] / ECO_ETA_FRAC
    ai_m = optimize_power(grid, ai_path_res["path"], ship_kn, eta_budget)
    ai_m["mode"] = AI_MODE_LABEL
    rationale = llm_rationale(comm_m, astar_m, ai_m, scenario, rationale_fn)

    result = {
        "baseline": dict(path=comm["path"], service_kn=ship_kn, **comm_m),
        "astar": dict(path=astar["path"], service_kn=ship_kn, **astar_m),
        "llm": dict(path=ai_path_res["path"], rationale=rationale, **ai_m),
    }

    # custo do cenário: o A* de menor tempo com canais abertos e sem zona de risco, para comparar
    label = scenario_label(scenario)
    if label:
        free = astar_route(a_ll, b_ll, ship_kn, current_weight=1.0)
        if free:
            free_m = route_metrics(free["path"], free["hours"], ship_kn)
            extra_fuel = astar_m["fuel_tons"] - free_m["fuel_tons"]
            result["scenario"] = {
                "label": label,
                "extra_nm": round((astar_m["km"] - free_m["km"]) * 0.539957, 1),
                "extra_hours": round(astar_m["hours"] - free_m["hours"], 2),
                "extra_fuel_tons": round(extra_fuel, 1),
                "extra_usd": round(extra_fuel * FUEL_PRICE_USD),
            }
    return result


# ============================================================
# ferramentas do copiloto (tool calling)
# ============================================================
_COMPASS = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"]
_COMPASS_NOME = {"N": "Norte", "NE": "Nordeste", "L": "Leste", "SE": "Sudeste",
                 "S": "Sul", "SO": "Sudoeste", "O": "Oeste", "NO": "Noroeste"}


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

    if compass and drift_km > 0.5:
        explanation = (
            "Resumo do Incidente (IA): As correntes marítimas empurraram o navio e o óleo em direção ao "
            f"{_COMPASS_NOME.get(compass, compass)} a uma velocidade de {_br(drift_km / horas)} km/h. "
            f"Em {horas} horas, a mancha de óleo e o navio foram levados por cerca de "
            f"{round(drift_km)} km longe do ponto inicial do acidente."
        )
    else:
        explanation = (
            "Resumo do Incidente (IA): As correntes estão fracas neste ponto. Em "
            f"{horas} horas, a mancha de óleo e o navio se moveram apenas {_br(drift_km)} km."
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


# ---------------- camada global de cardumes (zonas de ressurgência e pesca) ----------------
# Cada zona: caixa (lat/lon), corrente/sistema, espécie provável, temperatura ótima e tolerância
# da espécie (°C), se é ressurgência costeira (água mais fria que o entorno = nutrientes), peso de
# produtividade (prior da literatura: Humboldt é o sistema mais produtivo do planeta) e escala de
# biomassa ILUSTRATIVA por foco (t) — o modelo não tem dados de estoque pesqueiro.
FISH_ZONES = [
    {"zone": "Costa do Peru / Chile", "system": "Corrente de Humboldt", "lat": (-42, -5), "lon": (-82, -70),
     "species": "Anchoveta-peruana", "t_opt": 17.0, "t_sd": 4.0, "upwelling": True, "prior": 1.0, "biomass": 180000},
    {"zone": "Costa da Namíbia / África do Sul", "system": "Corrente de Benguela", "lat": (-35, -15), "lon": (8, 19),
     "species": "Sardinha-sul-africana", "t_opt": 16.0, "t_sd": 4.0, "upwelling": True, "prior": 0.9, "biomass": 90000},
    {"zone": "Costa Marroquina / Canárias", "system": "Corrente das Canárias", "lat": (15, 36), "lon": (-21, -9),
     "species": "Sardinha-europeia", "t_opt": 18.0, "t_sd": 4.0, "upwelling": True, "prior": 0.85, "biomass": 70000},
    {"zone": "Pacífico Norte / Califórnia", "system": "Corrente da Califórnia", "lat": (25, 48), "lon": (-130, -116),
     "species": "Anchova-do-Pacífico", "t_opt": 15.0, "t_sd": 4.0, "upwelling": True, "prior": 0.8, "biomass": 60000},
    {"zone": "Atlântico Norte / Grand Banks", "system": "Corrente do Labrador", "lat": (40, 52), "lon": (-58, -44),
     "species": "Bacalhau-do-Atlântico", "t_opt": 7.0, "t_sd": 6.0, "upwelling": False, "prior": 0.7, "biomass": 45000},
    {"zone": "Atlântico Norte / Mar do Norte", "system": "Corrente do Atlântico Norte", "lat": (51, 61), "lon": (-3, 9),
     "species": "Arenque-do-Atlântico", "t_opt": 11.0, "t_sd": 5.0, "upwelling": False, "prior": 0.75, "biomass": 55000},
    {"zone": "Índico / Golfo de Bengala", "system": "Monção do Golfo de Bengala", "lat": (5, 22), "lon": (80, 95),
     "species": "Atum-gaiado (bonito-listrado)", "t_opt": 28.0, "t_sd": 3.0, "upwelling": False, "prior": 0.6, "biomass": 30000},
    {"zone": "Índico Equatorial", "system": "Contracorrente Equatorial Sul", "lat": (-10, 8), "lon": (50, 95),
     "species": "Albacora-laje (atum)", "t_opt": 28.0, "t_sd": 3.0, "upwelling": False, "prior": 0.55, "biomass": 25000},
]
FISH_PER_ZONE = 4        # focos por zona
FISH_MIN_SPACING = 3.0   # graus entre focos da mesma zona (evita empilhar no mesmo lugar)
_fish_cache = None


def generate_global_fish_hotspots(grid_data=None):
    """Hotspots globais de cardume a partir da matriz de correntes e temperatura do mar.
    Em cada zona de ressurgência/pesca, pontua as células de água (1°) por:
      - frente térmica: gradiente de SST (°C/grau) — onde águas se encontram e o plâncton concentra;
      - ressurgência: água mais fria que a média da zona (só nas zonas costeiras de ressurgência);
      - adequação térmica: gaussiana em volta da temperatura ótima da espécie provável;
      - corrente desacelerada: fluxo lento favorece agregação (divide pela velocidade).
    Escolhe os melhores focos espaçados de cada zona e normaliza a intensidade 0–1 no globo.
    grid_data: (grade_de_correntes, grade_de_sst) opcional; por padrão, os dados carregados."""
    global _fish_cache
    if grid_data is None and _fish_cache is not None:
        return _fish_cache
    cur, sst = grid_data if grid_data else (get_current_grid(), get_sst_grid())
    mask = _build_nav_mask()

    def water(lon, lat):
        a = int(round((90.0 - lat) / NAV_RES))
        o = int(round((lon + 180.0) / NAV_RES)) % NAV_NLON
        return 0 <= a < NAV_NLAT and bool(mask[a * NAV_NLON + o])

    def temp(lon, lat):
        return sst.sample(lon, lat) if sst else None

    picked = []
    for z in FISH_ZONES:
        cells = []
        for lat in range(int(z["lat"][0]), int(z["lat"][1]) + 1):
            for lon in range(int(z["lon"][0]), int(z["lon"][1]) + 1):
                t0 = temp(lon, lat)
                if t0 is None or not water(lon, lat):
                    continue
                cells.append((lon, lat, t0))
        if not cells:
            continue
        mean_t = sum(c[2] for c in cells) / len(cells)

        scored = []
        for lon, lat, t0 in cells:
            te, tw = temp(lon + 1, lat), temp(lon - 1, lat)
            tn, ts = temp(lon, lat + 1), temp(lon, lat - 1)
            gx = abs((te if te is not None else t0) - (tw if tw is not None else t0)) / 2
            gy = abs((tn if tn is not None else t0) - (ts if ts is not None else t0)) / 2
            front = min(1.0, math.hypot(gx, gy) / 1.5)  # 1,5 °C/grau já é frente forte
            cold = min(1.0, max(0.0, mean_t - t0) / 4.0) if z["upwelling"] else 0.0
            fit = math.exp(-((t0 - z["t_opt"]) ** 2) / (2 * z["t_sd"] ** 2))
            u, v = cur.sample(lon, lat)
            speed_kn = math.hypot(u, v) * 1.94384
            calm = 1.0 / (1.0 + speed_kn)
            score = (0.4 * front + 0.3 * cold + 0.3 * fit) * (0.6 + 0.4 * calm) * z["prior"]
            scored.append({"lon": lon, "lat": lat, "t": t0, "score": score, "front": front,
                           "cold": cold, "fit": fit, "speed_kn": speed_kn})

        scored.sort(key=lambda c: -c["score"])
        chosen = []
        for c in scored:
            if all(math.hypot(c["lon"] - k["lon"], c["lat"] - k["lat"]) >= FISH_MIN_SPACING for k in chosen):
                chosen.append(c)
            if len(chosen) == FISH_PER_ZONE:
                break
        for c in chosen:
            c["z"] = z
        picked.extend(chosen)

    if not picked:
        _fish_cache = {"hotspots": [], "zones": []}
        return _fish_cache

    top = max(c["score"] for c in picked) or 1.0
    hotspots = []
    for c in picked:
        z = c["z"]
        intensity = round(0.25 + 0.75 * c["score"] / top, 3)
        biomass = int(round(intensity * z["biomass"], -2))
        motivos = []
        if c["front"] >= 0.3:
            motivos.append("frente térmica marcada")
        if c["cold"] >= 0.25:
            motivos.append("água fria de ressurgência")
        if c["fit"] >= 0.6:
            motivos.append(f"temperatura ideal para {z['species'].lower()}")
        if c["speed_kn"] < 0.5:
            motivos.append("corrente desacelerada (agregação)")
        motivo_txt = ", ".join(motivos) if motivos else "sinal moderado de produtividade"
        hotspots.append({
            "lat": float(c["lat"]), "lon": float(c["lon"]),
            "intensity": intensity,
            "score": intensity,  # compatível com a camada antiga do mapa
            "species": z["species"],
            "temp_c": round(c["t"], 1),
            "biomass_t": biomass,
            "radius_km": round(70 + 110 * intensity),
            "zone": z["zone"],
            "system": z["system"],
            "current_kn": round(c["speed_kn"], 2),
            "row": [float(c["lat"]), float(c["lon"]), intensity, z["species"], round(c["t"], 1), biomass],
            "title": "ZONA DE ALTA PRODUTIVIDADE BIOLÓGICA",
            "explanation": (
                f"{z['system']} ({z['zone']}): {motivo_txt}. SST {c['t']:.1f}°C, corrente "
                f"~{c['speed_kn']:.1f} nós."
            ),
        })
    hotspots.sort(key=lambda h: -h["intensity"])
    result = {"hotspots": hotspots, "zones": [z["zone"] for z in FISH_ZONES]}
    if grid_data is None:
        _fish_cache = result
    return result


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


# Modelos tentados em ordem (nome exato do endpoint REST v1beta: models/<nome>:generateContent).
# Um modelo que responder 404 é descartado nesta execução e o próximo é tentado.
MODELOS_GEMINI = [
    "gemini-flash-latest",
    "gemini-3.8-flash",
    "gemini-flash-lite-latest",
]
# 404 = modelo inexistente/aposentado, 429 = cota, 5xx = sobrecarga, None = timeout/rede:
# nesses casos vale tentar o próximo modelo. 400/401/403 (chave ou pedido inválido)
# falhariam igual em todos, então paramos na hora.
_GEMINI_RETRY_STATUS = {404, 429, 500, 502, 503, 504, None}
LLM_TIMEOUT_S = 20          # por modelo (evita "read operation timed out" em respostas longas)
LLM_TOTAL_BUDGET_S = 45     # somando todas as tentativas — a interface nunca espera mais que isso
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
        model_id = model_name.strip().removeprefix("models/")
        url = ("https://generativelanguage.googleapis.com/v1beta/models/"
               f"{model_id}:generateContent")
        # chave no cabeçalho (e não na URL), para não vazar em logs/mensagens de erro
        res = _http_post_json(url, {"contents": [{"parts": [{"text": body_text}]}]},
                              headers={"x-goog-api-key": gem_key},
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
            "Simulei o vazamento de %.0ft em (%.2f, %.2f) por %dh. A mancha derivou %.1f NM "
            "(%.1f nós médios) até (%.2f, %.2f), raio final ~%.1f km."
            % (volume, lat, lon, horas, result["drift_nm"], result["drift_speed_kn"],
               last["lat"], last["lon"], last["radius_km"])
        )
        return {"reply": reply, "tool": "simular_vazamento", "data": result}

    if tool == "prever_cardumes" and lat is not None and lon is not None:
        raio = float(args.get("raio_km", 300))
        result = prever_cardumes(lat, lon, raio)
        reply = (
            "Encontrei %d zona(s) de provável concentração de cardumes num raio de %.0f km a "
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
        return {"reply": "(modo sem LLM) Simulação de vazamento de 500t por 24h a partir do ponto atual, "
                          "seguindo as correntes locais.", "tool": "simular_vazamento", "data": result}

    if "cardum" in low or "peixe" in low or "pesca" in low:
        if lat is None or lon is None:
            return {"reply": "Aponte pra um ponto do mapa primeiro (ou informe lat/lon) e peça de novo.",
                    "tool": None, "data": None}
        result = prever_cardumes(lat, lon, 300)
        return {"reply": "(modo sem LLM) Zonas de frente térmica/de corrente identificadas perto do "
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
