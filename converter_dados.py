#!/usr/bin/env python3
"""
Le dados de corrente de superficie (Copernicus Marine, variaveis uo/vo em m/s)
e gera o arquivo  dados-marinhos.js , carregado pelo index.html como
window.MARINE_DATA.

    python converter_dados.py                       # usa o padrao abaixo
    python converter_dados.py caminho/arquivo.nc    # NetCDF (uo, vo)
    python converter_dados.py caminho/arquivo.xlsx  # planilha (time,depth,latitude,longitude,uo,vo)

Saida: uma grade regular lat/lon por dia disponivel na fonte. Celulas de terra
(NaN) viram 0. Nao ha temperatura -> o mapa mantem a SST estilizada (modelo).
"""
import sys, os, io, base64, struct, math
import numpy as np

# fonte padrao: o .nc regional com uo/vo reais (6 dias, costa SP/RJ/ES)
DEFAULT_SRC = os.path.join("teste", "projeto_oceano_ia", "dados_maritimos.nc")
OUT = "dados-marinhos.js"
SCALE = 1000          # m/s -> milesimos de m/s, guardado como int16


# ----------------------------------------------------------------------
# empacotamento / escrita
# ----------------------------------------------------------------------
def pack_i16(vals, scale, lo=-32000, hi=32000):
    buf = io.BytesIO()
    for v in vals:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            v = 0.0
        n = int(round(v * scale))
        n = lo if n < lo else hi if n > hi else n
        buf.write(struct.pack("<h", n))
    return base64.b64encode(buf.getvalue()).decode("ascii")


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


def write_js(lats, lons, tlabels, frames, depth, origin):
    nlat, nlon = len(lats), len(lons)
    dlat = float(np.mean(np.diff(lats)))
    dlon = float(np.mean(np.diff(lons)))
    src = ("Copernicus Marine - %s  |  uo/vo @ %.2f m  |  %s"
           % (origin, depth,
              tlabels[0] if len(tlabels) == 1 else "%s a %s" % (tlabels[0], tlabels[-1])))

    out = []
    out.append("window.MARINE_DATA={")
    out.append("  source:%s," % js_str(src))
    out.append("  grid:{nlon:%d,nlat:%d,lon0:%.6f,lat0:%.6f,dlon:%.6f,dlat:%.6f},"
               % (nlon, nlat, float(lons[0]), float(lats[0]), dlon, dlat))
    out.append("  times:[%s]," % ",".join(js_str(s) for s in tlabels))
    out.append("  frames:[")
    for (u64, v64) in frames:
        out.append('    {u:"%s",\n     v:"%s"},' % (u64, v64))
    out.append("  ]")
    out.append("};")
    js = "\n".join(out) + "\n"
    open(OUT, "w", encoding="ascii").write(js)

    print("ok ->", OUT, "(%.0f KB)" % (len(js) / 1024))
    print("  grade %dx%d  |  %d dia(s): %s" % (nlon, nlat, len(tlabels), ", ".join(tlabels)))
    print("  regiao  lon [%.3f .. %.3f]   lat [%.3f .. %.3f]"
          % (float(lons[0]), float(lons[-1]), float(lats[0]), float(lats[-1])))


# ----------------------------------------------------------------------
# leitura das fontes -> (lats asc, lons asc, tlabels, frames[(u64,v64)], depth)
# ----------------------------------------------------------------------
def _fix_lon(lons, *grids):
    """0..360 -> -180..180 e ordena crescente; aplica a mesma ordem aos grids."""
    lons = np.asarray(lons, dtype="float64")
    if lons.max() > 180.0:
        lons = ((lons + 180.0) % 360.0) - 180.0
    order = np.argsort(lons)
    lons = lons[order]
    grids = [g[..., order] for g in grids]
    return (lons, *grids)


def load_nc(path):
    try:
        import xarray as xr
    except ImportError:
        sys.exit("Instale:  pip install xarray netCDF4")

    d = xr.open_dataset(path, decode_timedelta=True)
    if "uo" not in d or "vo" not in d:
        sys.exit("O arquivo %s nao tem as variaveis uo/vo (corrente do oceano).\n"
                 "Variaveis presentes: %s" % (path, ", ".join(map(str, d.data_vars))))

    uo, vo = d["uo"], d["vo"]
    for dim in ("depth", "elevation"):
        if dim in uo.dims:
            uo = uo.isel({dim: 0})
            vo = vo.isel({dim: 0})

    latn = "latitude" if "latitude" in uo.coords else "lat"
    lonn = "longitude" if "longitude" in uo.coords else "lon"
    lats = np.asarray(uo[latn].values, dtype="float64")
    lons = np.asarray(uo[lonn].values, dtype="float64")

    if "time" in uo.dims:
        times = np.atleast_1d(uo["time"].values)
        U = np.stack([uo.isel(time=i).values for i in range(len(times))]).astype("float64")
        V = np.stack([vo.isel(time=i).values for i in range(len(times))]).astype("float64")
        tlabels = [str(np.datetime64(t, "D")) for t in times]
    else:
        U = uo.values.astype("float64")[None, ...]
        V = vo.values.astype("float64")[None, ...]
        tlabels = ["dado"]

    if lats[0] > lats[-1]:                       # garante sul -> norte
        lats = lats[::-1]
        U = U[:, ::-1, :]
        V = V[:, ::-1, :]
    lons, U, V = _fix_lon(lons, U, V)

    depth = float(np.asarray(d["depth"].values).ravel()[0]) if "depth" in d else 0.0
    frames = [(pack_i16(U[i].ravel(order="C"), SCALE),
               pack_i16(V[i].ravel(order="C"), SCALE)) for i in range(U.shape[0])]
    return lats, lons, tlabels, frames, depth, os.path.basename(path)


def load_xlsx(path):
    import pandas as pd
    df = pd.read_excel(path)
    for c in ("time", "depth", "latitude", "longitude"):
        df[c] = df[c].ffill()
    df["time"] = pd.to_datetime(df["time"])
    df = df[df["depth"] == df["depth"].min()]        # so a camada mais rasa

    lats = np.sort(df["latitude"].unique()).astype("float64")
    lons = np.sort(df["longitude"].unique()).astype("float64")
    lat_i = {v: i for i, v in enumerate(lats)}
    lon_i = {v: i for i, v in enumerate(lons)}
    times = sorted(df["time"].unique())
    tlabels = [pd.Timestamp(t).strftime("%Y-%m-%d") for t in times]

    frames = []
    for t in times:
        sub = df[df["time"] == t]
        u = np.full((len(lats), len(lons)), np.nan)
        v = np.full((len(lats), len(lons)), np.nan)
        for la, lo, uo, vo in zip(sub["latitude"], sub["longitude"], sub["uo"], sub["vo"]):
            u[lat_i[la], lon_i[lo]] = uo
            v[lat_i[la], lon_i[lo]] = vo
        frames.append((pack_i16(u.ravel(order="C"), SCALE),
                       pack_i16(v.ravel(order="C"), SCALE)))
    depth = float(df["depth"].iloc[0])
    return lats, lons, tlabels, frames, depth, os.path.basename(path)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.exists(path):
        sys.exit("nao encontrei: " + path)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".nc", ".nc4", ".cdf"):
        data = load_nc(path)
    elif ext in (".xlsx", ".xls"):
        data = load_xlsx(path)
    else:
        sys.exit("extensao nao suportada: " + ext + "  (use .nc ou .xlsx)")
    write_js(*data)


if __name__ == "__main__":
    main()
