#!/usr/bin/env python3
"""
Gera o arquivo ocean-data.js (corrente de superfície u/v em m/s + SST em °C)
que o mapa carrega.

Duas fontes:

  python fetch_ocean.py                 # NOAA CoastWatch (ERDDAP, sem login)
  python fetch_ocean.py --source copernicus

--source copernicus  usa o Copernicus Marine (o mesmo que você abre no site).
   Antes, uma vez só:
       pip install copernicusmarine
       copernicusmarine login          # conta gratuita em marine.copernicus.eu
   Produto usado: cmems_mod_glo_phy_anfc_0.083deg_P1D-m  (uo, vo, thetao).

O formato de saída é sempre o mesmo, então o site não muda.
"""
import argparse, base64, io, os, struct, sys, urllib.request, urllib.parse, csv, datetime

OUT = "ocean-data.js"
CUR_STEP = 0.5      # grau, resolução final das correntes
SST_STEP = 1.0      # grau, resolução final da SST
LAT_LIM = 79.5      # corta perto dos polos

# opcoes preenchidas em __main__ (usadas por from_copernicus)
OPT_DATE = None       # "YYYY-MM-DD" ou None = hoje
OPT_NO_SST = False    # nao baixar temperatura
OPT_KEEP_NC = False   # manter os .nc baixados em vez de apagar

CUR_DATASET = "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m"
SST_DATASET = "cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m"


# ----------------------------------------------------------------------
# empacotamento comum
# ----------------------------------------------------------------------
def pack_i16(vals, scale, lo=-32000, hi=32000):
    buf = io.BytesIO()
    for v in vals:
        n = int(round(v * scale))
        n = lo if n < lo else hi if n > hi else n
        buf.write(struct.pack("<h", n))
    return base64.b64encode(buf.getvalue()).decode("ascii")


def blur(g, nlat, nlon):
    out = [[0.0] * nlon for _ in range(nlat)]
    for j in range(nlat):
        for i in range(nlon):
            acc = wsum = 0.0
            for dj, wj in ((-1, 1), (0, 2), (1, 1)):
                jj = j + dj
                if 0 <= jj < nlat:
                    for di, wi in ((-1, 1), (0, 2), (1, 1)):
                        w = wj * wi
                        acc += g[jj][(i + di) % nlon] * w
                        wsum += w
            out[j][i] = acc / wsum
    return out


def fill_nan(g, nlat, nlon, rounds=80):
    for _ in range(rounds):
        holes = 0
        for j in range(nlat):
            for i in range(nlon):
                if g[j][i] is not None:
                    continue
                acc = n = 0
                for dj in (-1, 0, 1):
                    jj = j + dj
                    if 0 <= jj < nlat:
                        for di in (-1, 0, 1):
                            w = g[jj][(i + di) % nlon]
                            if w is not None:
                                acc += w
                                n += 1
                if n:
                    g[j][i] = acc / n
                else:
                    holes += 1
        if not holes:
            break
    for j in range(nlat):
        for i in range(nlon):
            if g[j][i] is None:
                g[j][i] = 0.0


def write_js(source, cur, sst):
    cg, u_flat, v_flat = cur
    parts = [
        "window.OCEAN_DATA={\n",
        f'  source:{js_str(source)},\n',
        f'  cur:{{nlon:{cg["nlon"]},nlat:{cg["nlat"]},lon0:{cg["lon0"]},lat0:{cg["lat0"]},'
        f'dlon:{cg["dlon"]},dlat:{cg["dlat"]},\n',
        f'    u:"{pack_i16(u_flat, 1000)}",\n',
        f'    v:"{pack_i16(v_flat, 1000)}"}}',
    ]
    if sst is not None:
        sg, t_flat = sst
        parts.append(
            ",\n"
            f'  sst:{{nlon:{sg["nlon"]},nlat:{sg["nlat"]},lon0:{sg["lon0"]},lat0:{sg["lat0"]},'
            f'dlon:{sg["dlon"]},dlat:{sg["dlat"]},\n'
            f'    t:"{pack_i16(t_flat, 100, -30000, 32000)}"}}'
        )
    parts.append("\n};\n")
    js = "".join(parts)
    open(OUT, "w", encoding="ascii").write(js)
    print(f"ok -> {OUT}  ({len(js)/1024:.0f} KB)")
    if sst is not None:
        print(f"  correntes {cg['nlon']}x{cg['nlat']}  SST {sst[0]['nlon']}x{sst[0]['nlat']}")
    else:
        print(f"  correntes {cg['nlon']}x{cg['nlat']}  (sem SST — mapa usa a temperatura estilizada)")


def js_str(s):
    out = ['"']
    for ch in s:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif 32 <= ord(ch) < 127:
            out.append(ch)
        else:
            out.append("\\u%04x" % ord(ch))
    out.append('"')
    return "".join(out)


# ----------------------------------------------------------------------
# fonte 1: NOAA CoastWatch (ERDDAP)
# ----------------------------------------------------------------------
def erddap_csv(dataset, var, stride, latlim):
    base = f"https://coastwatch.noaa.gov/erddap/griddap/{dataset}.csv"
    q = f"{var}[(last)][(-{latlim}):{stride}:({latlim})][(-179.9):{stride}:(179.9)]"
    url = base + "?" + urllib.parse.quote(q, safe="")
    print("  GET", dataset, var)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (ocean-map fetch_ocean.py)"})
    with urllib.request.urlopen(req, timeout=300) as r:
        text = r.read().decode("utf-8", "replace")
    lat_s, lon_s, rows = set(), set(), []
    rd = csv.reader(io.StringIO(text))
    next(rd); next(rd)
    for row in rd:
        if not row:
            continue
        la, lo = float(row[1]), float(row[2])
        raw = row[3].strip()
        rows.append((la, lo, None if raw in ("NaN", "nan", "") else float(raw)))
        lat_s.add(la); lon_s.add(lo)
    lats, lons = sorted(lat_s), sorted(lon_s)
    li = {v: i for i, v in enumerate(lats)}
    oi = {v: i for i, v in enumerate(lons)}
    g = [[None] * len(lons) for _ in lats]
    for la, lo, v in rows:
        g[li[la]][oi[lo]] = v
    geom = dict(nlon=len(lons), nlat=len(lats), lon0=round(lons[0], 4),
                lat0=round(lats[0], 4), dlon=round(lons[1] - lons[0], 4),
                dlat=round(lats[1] - lats[0], 4))
    return geom, g


def from_noaa():
    cstride = max(1, round(CUR_STEP / 0.25))
    sstride = max(1, round(SST_STEP / 0.05))
    cg, ug = erddap_csv("noaacwBLENDEDNRTcurrentsDaily", "u_current", cstride, LAT_LIM)
    _,  vg = erddap_csv("noaacwBLENDEDNRTcurrentsDaily", "v_current", cstride, LAT_LIM)
    for g in (ug, vg):
        for j in range(cg["nlat"]):
            for i in range(cg["nlon"]):
                if g[j][i] is None:
                    g[j][i] = 0.0
    ug, vg = blur(ug, cg["nlat"], cg["nlon"]), blur(vg, cg["nlat"], cg["nlon"])
    u_flat = [ug[j][i] for j in range(cg["nlat"]) for i in range(cg["nlon"])]
    v_flat = [vg[j][i] for j in range(cg["nlat"]) for i in range(cg["nlon"])]

    sg, tg = erddap_csv("noaacrwsstDaily", "analysed_sst", sstride, LAT_LIM)
    fill_nan(tg, sg["nlat"], sg["nlon"])
    t_flat = [tg[j][i] for j in range(sg["nlat"]) for i in range(sg["nlon"])]

    today = datetime.date.today().isoformat()
    src = f"NOAA CoastWatch — corrente geostrofica NRT + SST CoralTemp ({today})"
    write_js(src, (cg, u_flat, v_flat), (sg, t_flat))


# ----------------------------------------------------------------------
# reduz uma grade global lat/lon (pega 1 a cada N pontos) -> (geom, arr 2D)
# ----------------------------------------------------------------------
def coarsen(da, step):
    import numpy as np
    if "time" in da.dims:
        da = da.isel(time=-1)
    if "depth" in da.dims:
        da = da.isel(depth=0)
    st = max(1, round(step / 0.0833))
    da = da.isel(latitude=slice(None, None, st), longitude=slice(None, None, st))
    lat = np.asarray(da["latitude"].values, dtype="float64")
    lon = np.asarray(da["longitude"].values, dtype="float64")
    arr = np.nan_to_num(np.asarray(da.values, dtype="float64"), nan=0.0)
    if lat[0] > lat[-1]:                       # garante sul -> norte
        lat = lat[::-1]; arr = arr[::-1, :]
    if lon.max() > 180:                        # 0..360 -> -180..180
        lon = ((lon + 180.0) % 360.0) - 180.0
        order = np.argsort(lon)
        lon = lon[order]; arr = arr[:, order]
    geom = dict(nlon=len(lon), nlat=len(lat),
                lon0=round(float(lon[0]), 4), lat0=round(float(lat[0]), 4),
                dlon=round(float(lon[1] - lon[0]), 4),
                dlat=round(float(lat[1] - lat[0]), 4))
    return geom, arr


# ----------------------------------------------------------------------
# fonte 2: Copernicus Marine — TUDO num comando
#   baixa o(s) .nc global(is) do dia e ja gera o ocean-data.js
# ----------------------------------------------------------------------
def _ensure_login(cm):
    from pathlib import Path
    cfg = Path.home() / ".copernicusmarine" / ".copernicusmarine-credentials"
    if cfg.exists() or os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME"):
        return
    print("\nPrimeiro uso: e preciso logar no Copernicus Marine")
    print("(conta gratuita em https://marine.copernicus.eu — botao Register)\n")
    cm.login()   # pergunta usuario/senha e salva; nao pede de novo


def _recent_dates(start):
    d0 = datetime.date.fromisoformat(start)
    return [(d0 - datetime.timedelta(days=k)).isoformat() for k in range(0, 6)]


def from_copernicus():
    try:
        import copernicusmarine as cm
    except ImportError:
        sys.exit("Instale:  python -m pip install copernicusmarine")

    _ensure_login(cm)

    def download(dsid, variables, fname, dates):
        last = None
        for d in dates:
            try:
                os.remove(fname)
            except OSError:
                pass
            try:
                print(f"  baixando {'+'.join(variables)}  ({d})  ...")
                kw = dict(dataset_id=dsid, variables=list(variables),
                          minimum_depth=0, maximum_depth=1,
                          start_datetime=d, end_datetime=d,
                          output_directory=".", output_filename=fname)
                try:
                    cm.subset(**kw, overwrite=True)
                except TypeError:
                    cm.subset(**kw)
                if os.path.exists(fname):
                    return d
                last = "arquivo nao apareceu"
            except Exception as e:  # noqa: BLE001
                last = e
        raise SystemExit(f"nao consegui baixar {dsid}\n  detalhe: {last}")

    dates = _recent_dates(OPT_DATE or datetime.date.today().isoformat())
    used = download(CUR_DATASET, ("uo", "vo"), "correntes_global.nc", dates)

    if not OPT_NO_SST:
        try:
            download(SST_DATASET, ("thetao",), "temperatura_global.nc", [used])
        except SystemExit as e:
            print("  (SST falhou, seguindo sem ela)", e)

    from_localnc()     # coarsen + escreve ocean-data.js

    if not OPT_KEEP_NC:
        for f in ("correntes_global.nc", "temperatura_global.nc"):
            try:
                os.remove(f)
            except OSError:
                pass
        print("  .nc temporarios removidos (use --keep-nc para manter)")


# ----------------------------------------------------------------------
# fonte 3: arquivos .nc locais (baixados com  copernicusmarine subset)
#   correntes_global.nc   -> uo, vo         (obrigatorio)
#   temperatura_global.nc -> thetao         (opcional; sem ele, SST estilizada)
# ----------------------------------------------------------------------
def from_localnc(cur_file="correntes_global.nc", sst_file="temperatura_global.nc"):
    try:
        import numpy as np
        import xarray as xr
    except ImportError:
        sys.exit("Instale:  pip install xarray netCDF4 numpy")

    if not os.path.exists(cur_file):
        sys.exit(f"nao encontrei {cur_file}\n"
                 f"baixe antes:  copernicusmarine subset --dataset-id "
                 f"cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m --variable uo --variable vo ...")
    ds_c = xr.open_dataset(cur_file)
    if "uo" not in ds_c or "vo" not in ds_c:
        sys.exit(f"{cur_file} nao tem uo/vo. variaveis: {list(ds_c.data_vars)}")

    print(f"  lendo {cur_file}")
    cg, u = coarsen(ds_c["uo"], CUR_STEP)
    _,  v = coarsen(ds_c["vo"], CUR_STEP)

    sst = None
    if os.path.exists(sst_file):
        ds_t = xr.open_dataset(sst_file)
        tvar = "thetao" if "thetao" in ds_t else next(iter(ds_t.data_vars))
        print(f"  lendo {sst_file} ({tvar})")
        sg, t = coarsen(ds_t[tvar], SST_STEP)
        sst = (sg, t.ravel().tolist())

    src = "Copernicus Marine (arquivos locais) — uo,vo" + (",thetao" if sst else "")
    write_js(src, (cg, u.ravel().tolist(), v.ravel().tolist()), sst)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Gera ocean-data.js (correntes de superficie + SST) para o mapa.")
    ap.add_argument("--source", choices=["noaa", "copernicus", "localnc"], default="noaa",
                    help="noaa (padrao) | copernicus (baixa e gera tudo) | localnc (usa .nc ja baixados)")
    ap.add_argument("--date", metavar="YYYY-MM-DD",
                    help="dia desejado (padrao: hoje; volta ate 5 dias se nao houver dado)")
    ap.add_argument("--no-sst", action="store_true", help="nao baixar a temperatura")
    ap.add_argument("--keep-nc", action="store_true", help="manter os .nc baixados")
    a = ap.parse_args()
    OPT_DATE = a.date
    OPT_NO_SST = a.no_sst
    OPT_KEEP_NC = a.keep_nc
    {"copernicus": from_copernicus, "localnc": from_localnc}.get(a.source, from_noaa)()
