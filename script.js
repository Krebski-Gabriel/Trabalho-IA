'use strict';

/* ============================================================
   Correntes Oceânicas — mapa de fluxo estilo "earth"
   Fundo  = temperatura da superfície do mar (modelo)
   Fluxo  = campo de correntes reconstruído a partir de correntes
            nomeadas, cada uma com VELOCIDADE e LARGURA próprias
   Biblioteca: D3 (projeção / desenho geográfico)
   ============================================================ */

/* ---------- DOM ---------- */
const baseCanvas = document.getElementById('base');
const flowCanvas = document.getElementById('flow');
const routeCanvas = document.getElementById('route');
const bctx = baseCanvas.getContext('2d');
const fctx = flowCanvas.getContext('2d');
const rctx = routeCanvas.getContext('2d');
const warnEl = document.getElementById('warn');
const readoutEl = document.getElementById('readout');
let routeInfoEl = null;

/* ---------- configuração ---------- */
const CFG = { fade: 0.042, speed: 0.16, stepCap: 0.9, density: 360, minP: 1400, maxP: 8800 };

/* ---------- paleta cartográfica (tons suaves, estilo atlas) ---------- */
const MAP = {
  ocean:    '#d4e6ee',            // mar — azul-acinzentado claro
  land:     '#bdd2a4',            // terra — verde suave de mapa
  landLine: 'rgba(96,120,78,0.55)',
  landShadow: 'rgba(38,58,46,0.32)',   // sombra da terra sobre o mar
  grat:     'rgba(66,92,108,0.11)',      // grade fininha
  flow:     '20,66,116',
  route:    '#123f7d',
  ice:      '#f5f7f7',            // calota de gelo (Antártida)
  iceLine:  'rgba(150,170,182,0.6)',
};
const TW = 512, TH = 256;   // grade de temperatura
const MW = 1024, MH = 512;  // máscara de terra
const FW = 360, FH = 180;   // grade do campo de correntes (1°)

/* ---------- estado ---------- */
let W = 0, H = 0, DPR = 1;
let proj = null, geoPath = null;
let scaleK = 0, originX = 0, originY = 0, baseK = 1, Z = 1; // vista: zoom (Z) e deslocamento (originX/Y)
let land = null;
let landData = null;
let iceCaps = null;   // GeoJSON só com a Antártida (desenhada como gelo)
const tempGrid = new Float32Array(TW * TH);
const FIELD = new Float32Array(FW * FH * 2);   // (u,v) das correntes nomeadas
const SPD = new Float32Array(FW * FH);         // |velocidade| estruturada
const sstCanvas = document.createElement('canvas');
const sctx = sstCanvas.getContext('2d');
let sstReady = false;
let particles = [];
let showSST = false, showCurr = true, showGrat = true;
let phase = 0, lastT = performance.now(), rafId = 0;
let graticule = d3.geoGraticule10();

/* ---------- estado da rota ---------- */
const SHIP = { kn: 18 };            // velocidade do navio em águas paradas (nós)
let routeA = null, routeB = null;   // [lon, lat]
let routePath = null;               // [[lon,lat], ...]
let routeMode = null;               // null | 'A' | 'B'
let lastRouteClick = 0;
let NAV = null;                     // grade de navegabilidade (1 = oceano)
let NRES = 1;                       // graus por célula da grade de navegação
let NLON = Math.round(360 / NRES);
let NLAT = Math.round(180 / NRES) + 1;
let N_LON0 = -180, N_LAT0 = 90;     // coordenada geográfica do índice 0 da grade
let N_WRAP = true;                  // true = longitude dá a volta ao mundo (mapa global)
const KMH_PER_KN = 1.852;

/* ---------- dados oceânicos reais (NOAA CoastWatch), se ocean-data.js existir ----------
   OD.U/OD.V = corrente de superfície em m/s ; OD.T = SST em °C
   grades regulares lat/lon:  c = correntes, s = SST  (nlon,nlat,lon0,lat0,dlon,dlat) */
let OD = null;                       // dados de corrente ativos (m/s)
let ODB = null;                      // {lon0,lon1,lat0,lat1} — limites da região com dados reais (só regional)
let MD = null;                       // window.MARINE_DATA bruto (vários dias)
let curDay = 0;                      // índice do dia selecionado nos dados regionais
const SST_MIN = -2, SST_MAX = 32;   // faixa (°C) para a paleta de cores

function b64ToI16(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// dados globais (ocean-data.js, formato antigo): corrente + SST reais
function decodeOceanData() {
  const src = window.OCEAN_DATA;
  if (!src) return null;
  const cu = b64ToI16(src.cur.u), cv = b64ToI16(src.cur.v);
  const U = new Float32Array(cu.length), V = new Float32Array(cv.length);
  for (let i = 0; i < cu.length; i++) { U[i] = cu[i] / 1000; V[i] = cv[i] / 1000; }
  let T = null;
  if (src.sst && src.sst.t) {                       // SST real é opcional
    const st = b64ToI16(src.sst.t);
    T = new Float32Array(st.length);
    for (let i = 0; i < st.length; i++) T[i] = st[i] / 100;
  }
  return { U, V, T, c: src.cur, s: src.sst || null, source: src.source, regional: false };
}

// dados regionais reais (dados-marinhos.js -> converter_dados.py): só corrente, um ou mais dias
function decodeMarine(day) {
  const src = window.MARINE_DATA;
  if (!src || !src.frames || !src.frames.length) return null;
  const d = Math.max(0, Math.min(src.frames.length - 1, day | 0));
  const cu = b64ToI16(src.frames[d].u), cv = b64ToI16(src.frames[d].v);
  const U = new Float32Array(cu.length), V = new Float32Array(cv.length);
  for (let i = 0; i < cu.length; i++) { U[i] = cu[i] / 1000; V[i] = cv[i] / 1000; }
  return { U, V, T: null, c: src.grid, s: null, source: src.source, regional: true };
}

// limites geográficos cobertos por uma grade regular
function regionBounds(g) {
  return {
    lon0: g.lon0, lon1: g.lon0 + (g.nlon - 1) * g.dlon,
    lat0: g.lat0, lat1: g.lat0 + (g.nlat - 1) * g.dlat,
  };
}

// amostra bilinear de uma grade regular (lon com wrap, lat com clamp)
function sampleGrid(arr, g, lon, lat) {
  let x = (lon - g.lon0) / g.dlon;
  x = ((x % g.nlon) + g.nlon) % g.nlon;
  let y = (lat - g.lat0) / g.dlat;
  if (y < 0) y = 0; else if (y > g.nlat - 1) y = g.nlat - 1;
  const xf = Math.floor(x), yf = Math.floor(y);
  const tx = x - xf, ty = y - yf;
  const x0 = xf % g.nlon, x1 = (xf + 1) % g.nlon;
  const y0 = yf, y1 = y0 + 1 < g.nlat ? y0 + 1 : y0;
  const w = g.nlon;
  return (arr[y0 * w + x0] * (1 - tx) + arr[y0 * w + x1] * tx) * (1 - ty) +
         (arr[y1 * w + x0] * (1 - tx) + arr[y1 * w + x1] * tx) * ty;
}

/* ============================================================
   CORRENTES OCEÂNICAS
   speed: velocidade relativa (rápido ~3.0, lento ~0.45)
   width: meia-largura de influência em graus
   pts:   [lon, lat] NA ORDEM DO FLUXO (longitudes podem passar
          de ±180 para atravessar o Pacífico de forma contínua)
   ============================================================ */
const CURRENTS = [
  /* ----- Atlântico ----- */
  { name: 'Corrente do Golfo',            type: 'warm', speed: 3.2, width: 2.4,
    pts: [[-80,26],[-79,31],[-74,35],[-67,38],[-57,40],[-46,42]] },
  { name: 'Deriva do Atlântico Norte',    type: 'warm', speed: 1.1, width: 4.5,
    pts: [[-46,42],[-32,47],[-18,52],[-5,57],[6,61]] },
  { name: 'Corrente das Canárias',        type: 'cold', speed: 0.45, width: 4.5,
    pts: [[-10,34],[-14,28],[-18,21],[-21,14]] },
  { name: 'Corrente Norte-Equatorial (Atlântico)', type: 'warm', speed: 1.1, width: 4,
    pts: [[-20,11],[-35,10],[-48,11],[-58,12]] },
  { name: 'Corrente das Antilhas / Caribe', type: 'warm', speed: 1.7, width: 3,
    pts: [[-58,12],[-66,15],[-75,19],[-81,24]] },
  { name: 'Corrente das Guianas',         type: 'warm', speed: 1.2, width: 3,
    pts: [[-46,2],[-52,5],[-57,8],[-60,10]] },
  { name: 'Corrente do Labrador',         type: 'cold', speed: 0.9, width: 3,
    pts: [[-58,62],[-56,56],[-53,50],[-50,44]] },
  { name: 'Corrente do Brasil',           type: 'warm', speed: 1.6, width: 2.6,
    pts: [[-38,-8],[-43,-18],[-49,-27],[-52,-34]] },
  { name: 'Corrente das Malvinas',        type: 'cold', speed: 0.9, width: 3,
    pts: [[-61,-52],[-58,-45],[-55,-39],[-53,-34]] },
  { name: 'Corrente Sul-Equatorial (Atlântico)', type: 'warm', speed: 1.2, width: 5,
    pts: [[10,-2],[-8,-3],[-22,-4],[-32,-3]] },
  { name: 'Corrente de Benguela',         type: 'cold', speed: 0.45, width: 5,
    pts: [[17,-34],[13,-24],[11,-14],[10,-4]] },

  /* ----- Índico ----- */
  { name: 'Corrente das Agulhas',         type: 'warm', speed: 2.7, width: 2.2,
    pts: [[40,-13],[36,-21],[31,-29],[27,-35],[23,-39]] },
  { name: 'Corrente de Retorno das Agulhas', type: 'warm', speed: 1.1, width: 3,
    pts: [[23,-39],[38,-41],[55,-42],[72,-43],[90,-43]] },
  { name: 'Corrente Sul-Equatorial (Índico)', type: 'warm', speed: 1.2, width: 5,
    pts: [[102,-13],[80,-14],[60,-15],[45,-13],[42,-12]] },
  { name: 'Corrente da Somália',          type: 'warm', speed: 1.9, width: 2.4,
    pts: [[46,-3],[49,3],[52,8],[54,11]] },
  { name: 'Corrente da Austrália Ocidental', type: 'cold', speed: 0.45, width: 4,
    pts: [[113,-35],[110,-25],[107,-16],[105,-10]] },
  { name: 'Deriva das Monções',           type: 'warm', speed: 0.7, width: 4,
    pts: [[52,7],[65,6],[80,6],[92,5]] },

  /* ----- Pacífico ----- */
  { name: 'Corrente de Kuroshio',         type: 'warm', speed: 3.0, width: 2.4,
    pts: [[122,18],[126,25],[131,30],[140,35],[147,37]] },
  { name: 'Corrente do Pacífico Norte',   type: 'warm', speed: 1.1, width: 5,
    pts: [[147,37],[165,39],[182,41],[200,43],[218,44],[233,45]] },
  { name: 'Corrente da Califórnia',       type: 'cold', speed: 0.45, width: 4.5,
    pts: [[-127,46],[-125,38],[-121,31],[-116,23],[-111,19]] },
  { name: 'Corrente do Alasca',           type: 'warm', speed: 0.9, width: 4,
    pts: [[-135,49],[-146,54],[-156,57],[-163,56]] },
  { name: 'Corrente de Oyashio',          type: 'cold', speed: 0.8, width: 3,
    pts: [[160,55],[156,49],[150,43],[147,39]] },
  { name: 'Corrente Norte-Equatorial (Pacífico)', type: 'warm', speed: 1.2, width: 5,
    pts: [[-100,12],[-130,11],[-160,11],[-190,11],[-220,13],[-234,15]] },
  { name: 'Contracorrente Equatorial (Pacífico)', type: 'warm', speed: 1.0, width: 2.6,
    pts: [[130,6],[160,6],[190,6],[220,7],[250,8],[266,9]] },
  { name: 'Corrente Sul-Equatorial (Pacífico)', type: 'warm', speed: 1.3, width: 5,
    pts: [[-82,-3],[-120,-5],[-150,-6],[-182,-6],[-212,-8],[-236,-12]] },
  { name: 'Corrente da Austrália Oriental', type: 'warm', speed: 1.8, width: 2.6,
    pts: [[149,-12],[153,-22],[153,-31],[151,-37],[149,-42]] },
  { name: 'Corrente de Humboldt (Peru)',  type: 'cold', speed: 0.6, width: 4,
    pts: [[-76,-42],[-73,-33],[-72,-22],[-78,-12],[-83,-6]] },

  /* ----- Oceano Austral ----- */
  { name: 'Corrente Circumpolar Antártica', type: 'cold', speed: 1.5, width: 7,
    pts: [[-200,-56],[-175,-57],[-150,-58],[-125,-56],[-100,-55],[-75,-57],[-50,-58],
          [-25,-57],[0,-56],[25,-55],[50,-56],[75,-58],[100,-57],[125,-56],[150,-55],
          [175,-56],[200,-57]] },
];

/* ---------- circulação de fundo: giros das bacias (lenta, preenche o oceano)
   dir: -1 = horário (giros subtropicais do Hemisfério Norte)
        +1 = anti-horário (subtropicais do Sul; subpolares do Norte)          */
const BG_GYRES = [
  { lon: -45,  lat: 30,  rx: 34, ry: 17, dir: -1, s: 1.15 }, // Atlântico Norte
  { lon: -175, lat: 30,  rx: 52, ry: 19, dir: -1, s: 1.15 }, // Pacífico Norte
  { lon: -16,  lat: -25, rx: 24, ry: 17, dir:  1, s: 1.10 }, // Atlântico Sul
  { lon: -125, lat: -27, rx: 55, ry: 19, dir:  1, s: 1.10 }, // Pacífico Sul
  { lon: 75,   lat: -28, rx: 34, ry: 17, dir:  1, s: 1.10 }, // Índico Sul
  { lon: -35,  lat: 56,  rx: 20, ry: 11, dir:  1, s: 0.75 }, // Atlântico Norte subpolar
  { lon: -165, lat: 53,  rx: 26, ry: 12, dir:  1, s: 0.70 }, // giro do Alasca / Bering
  { lon: 66,   lat: 12,  rx: 16, ry: 9,  dir: -1, s: 0.55 }, // monção (Índico Norte)
];

/* ---------- turbulência de meso-escala (leve, some nas zonas calmas) ---------- */
const TT = [
  { a: 1.0,  fx: 1.1, fy: 1.5, p: 0.0, dr: 0.005 },
  { a: 0.6,  fx: 2.3, fy: 1.2, p: 1.7, dr: 0.009 },
  { a: 0.35, fx: 4.0, fy: 3.1, p: 3.1, dr: 0.015 },
];
function streamTurb(lon, lat, ph) {
  const X = lon / 24, Y = lat / 24;
  let dpl = 0, dpa = 0;
  for (let s = 0; s < TT.length; s++) {
    const T = TT[s];
    const c = Math.cos(T.fx * X + T.fy * Y + T.p + ph * T.dr);
    dpl += T.a * T.fx * c / 24;
    dpa += T.a * T.fy * c / 24;
  }
  return [7 * dpa, -7 * dpl];
}

/* ---------- paleta de temperatura (LUT de 256 cores) ----------
   ramp claro azul(frio) -> neutro -> vermelho(quente), no mesmo
   registro visual do mapa (fundo claro, tons suaves) */
const LUT = new Uint8Array(256 * 3);
(function buildLUT() {
  const stops = [0,        0.14,      0.3,       0.46,      0.54,      0.68,      0.83,      1];
  const cols  = ['#4a7fbb', '#6ba7d4', '#a3cbe2', '#dde9ec', '#f3e6c4', '#f0c159', '#e0873c', '#bf3b25'];
  const sc = d3.scaleLinear().domain(stops).range(cols)
    .interpolate(d3.interpolateRgb).clamp(true);
  for (let k = 0; k < 256; k++) {
    const c = d3.rgb(sc(k / 255));
    LUT[k * 3] = c.r; LUT[k * 3 + 1] = c.g; LUT[k * 3 + 2] = c.b;
  }
})();

/* ---------- projeção (equiretangular linear) + vista (zoom/pan) ---------- */
function project(lon, lat) { return [originX + (lon + 180) * scaleK, originY + (90 - lat) * scaleK]; }
function invert(x, y) { return [(x - originX) / scaleK - 180, 90 - (y - originY) / scaleK]; }

function clampView() {
  const worldW = 360 * scaleK, worldH = 180 * scaleK;
  originX = worldW <= W ? (W - worldW) / 2 : Math.min(0, Math.max(W - worldW, originX));
  originY = worldH <= H ? (H - worldH) / 2 : Math.min(0, Math.max(H - worldH, originY));
}

function updateProj() {
  proj = d3.geoEquirectangular()
    .scale(scaleK * 180 / Math.PI)
    .translate([originX + 180 * scaleK, originY + 90 * scaleK]);
  geoPath = d3.geoPath(proj, bctx);
}

function viewBounds() {
  const a = invert(0, 0), c = invert(W, H);
  let lon0 = a[0], lon1 = c[0], lat0 = c[1], lat1 = a[1];
  const px = (lon1 - lon0) * 0.1, py = (lat1 - lat0) * 0.1;
  lon0 -= px; lon1 += px; lat0 -= py; lat1 += py;
  if (lat0 < -85) lat0 = -85;
  if (lat1 > 85) lat1 = 85;
  return { lon0, lon1, lat0, lat1 };
}

function setZoom(nz, px, py) {
  const zmax = (OD && OD.regional) ? 120 : 16;
  const zmin = (OD && OD.regional) ? 1 : Math.min(1, (W / 360) / baseK);   // deixa dar zoom-out até ver o mundo todo
  nz = Math.max(zmin, Math.min(zmax, nz));
  const f = (nz * baseK) / scaleK;
  scaleK = nz * baseK;
  originX = px - (px - originX) * f;
  originY = py - (py - originY) * f;
  Z = nz;
  clampView();
  updateProj();
  fctx.clearRect(0, 0, W, H);
  requestBase();
}

function resetView() {
  if (OD && OD.regional && ODB) {          // "ver tudo" = reenquadra a região com dados reais
    fitRegion(ODB);
    fctx.clearRect(0, 0, W, H);
    drawBase();
    drawRoute();
    return;
  }
  scaleK = W / 360; Z = scaleK / baseK;          // "ver tudo" = mundo inteiro visível
  originX = 0;
  originY = (H - 180 * scaleK) / 2;
  clampView();
  updateProj();
  fctx.clearRect(0, 0, W, H);
  drawBase();
  drawRoute();
}

// enquadra a vista nos limites b = {lon0,lon1,lat0,lat1}
function fitRegion(b) {
  const lonSpan = Math.max(0.5, b.lon1 - b.lon0);
  const latSpan = Math.max(0.5, b.lat1 - b.lat0);
  const pad = 1.25;
  const k = Math.min(W / (lonSpan * pad), H / (latSpan * pad));
  Z = Math.max(1, Math.min(120, k / baseK));
  scaleK = Z * baseK;
  const cx = (b.lon0 + b.lon1) / 2, cy = (b.lat0 + b.lat1) / 2;
  originX = W / 2 - (cx + 180) * scaleK;
  originY = H / 2 - (90 - cy) * scaleK;
  clampView();
  updateProj();
}

// seletor de dia (só aparece quando os dados regionais têm mais de um dia)
function setupDaySelector() {
  const wrap = document.getElementById('day-wrap');
  const sel = document.getElementById('t-day');
  if (!wrap || !sel || !MD || !MD.times || MD.times.length < 2) return;
  sel.innerHTML = '';
  MD.times.forEach((t, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = t;
    sel.appendChild(o);
  });
  sel.value = String(curDay);
  wrap.hidden = false;
  sel.addEventListener('change', () => {
    curDay = (+sel.value) | 0;
    const nd = decodeMarine(curDay);
    if (!nd) return;
    OD.U = nd.U; OD.V = nd.V;
    fctx.clearRect(0, 0, W, H);
    if (routeA && routeB && !routeMode) computeRoute();
    if (readoutEl) {
      readoutEl.textContent = 'dia dos dados: ' + MD.times[curDay];
      setTimeout(() => { readoutEl.textContent = ''; }, 1400);
    }
  });
}

let baseDirty = false;
function requestBase() {
  if (baseDirty) return;
  baseDirty = true;
  requestAnimationFrame(() => { baseDirty = false; drawBase(); drawRoute(); });
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function hash2(i, j) {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = ((n ^ (n >> 13)) * 1274126177) | 0;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

/* ---------- máscara de terra ---------- */
function isLandLL(lon, lat) {
  if (!landData) return false;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  if (lat > 90 || lat < -90) return false;
  const x = ((lon + 180) / 360 * MW) | 0;
  const y = ((90 - lat) / 180 * MH) | 0;
  if (x < 0 || x >= MW || y < 0 || y >= MH) return false;
  return landData[(y * MW + x) * 4] > 128;
}

function buildLandMask() {
  const mc = document.createElement('canvas');
  mc.width = MW; mc.height = MH;
  const m = mc.getContext('2d');
  m.fillStyle = '#000';
  m.fillRect(0, 0, MW, MH);
  if (land) {
    const mp = d3.geoEquirectangular().translate([MW / 2, MH / 2]).scale(MW / (2 * Math.PI));
    const mpath = d3.geoPath(mp, m);
    m.fillStyle = '#fff';
    m.beginPath();
    mpath(land);
    m.fill();
  }
  landData = m.getImageData(0, 0, MW, MH).data;
}

/* ---------- campo de correntes ---------- */
function prepCurrents() {
  for (const c of CURRENTS) {
    // longitudes contínuas (sem saltos > 180 entre vértices vizinhos)
    for (let i = 1; i < c.pts.length; i++) {
      const d = c.pts[i][0] - c.pts[i - 1][0];
      if (d > 180) c.pts[i][0] -= 360;
      else if (d < -180) c.pts[i][0] += 360;
    }
    let s = 0;
    for (const p of c.pts) s += p[0];
    c.meanLon = s / c.pts.length;
  }
}

function buildField() {
  for (let j = 0; j < FH; j++) {
    const lat = 90 - (j + 0.5) * (180 / FH);
    for (let i = 0; i < FW; i++) {
      const baseLon = i - 180 + 0.5;
      let u = 0, v = 0;

      for (let ci = 0; ci < CURRENTS.length; ci++) {
        const c = CURRENTS[ci];
        // aproxima a longitude da consulta ao intervalo desta corrente
        let lon = baseLon;
        const dm = c.meanLon - lon;
        if (dm > 180) lon += 360;
        else if (dm < -180) lon -= 360;

        let best = Infinity, tu = 0, tv = 0;
        for (let k = 0; k < c.pts.length - 1; k++) {
          const ax = c.pts[k][0], ay = c.pts[k][1];
          const dx = c.pts[k + 1][0] - ax, dy = c.pts[k + 1][1] - ay;
          const L2 = dx * dx + dy * dy || 1e-9;
          let t = ((lon - ax) * dx + (lat - ay) * dy) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = lon - (ax + t * dx);
          const ey = lat - (ay + t * dy);
          const d2 = ex * ex + ey * ey;
          if (d2 < best) {
            best = d2;
            const inv = 1 / Math.sqrt(L2);
            tu = dx * inv; tv = dy * inv;
          }
        }
        const w = Math.exp(-best / (c.width * c.width));
        if (w > 0.01) { u += tu * c.speed * w; v += tv * c.speed * w; }
      }

      // circulação de fundo dos giros
      for (let gi = 0; gi < BG_GYRES.length; gi++) {
        const G = BG_GYRES[gi];
        let dlon = baseLon - G.lon;
        if (dlon > 180) dlon -= 360;
        else if (dlon < -180) dlon += 360;
        const nx = dlon / G.rx, ny = (lat - G.lat) / G.ry;
        const env = Math.exp(-(nx * nx + ny * ny));
        if (env > 0.02) {
          u += -G.dir * G.s * ny * env;
          v += G.dir * G.s * nx * env;
        }
      }

      if (isLandLL(baseLon, lat)) { u *= 0.12; v *= 0.12; }

      const o = j * FW + i;
      FIELD[o * 2] = u;
      FIELD[o * 2 + 1] = v;
      SPD[o] = Math.hypot(u, v);
    }
  }
}

function sampleField(lon, lat) {
  if (OD) {
    if (ODB && (lon < ODB.lon0 || lon > ODB.lon1 || lat < ODB.lat0 || lat > ODB.lat1))
      return [0, 0];                                    // fora da região coberta pelos dados reais
    return [sampleGrid(OD.U, OD.c, lon, lat), sampleGrid(OD.V, OD.c, lon, lat)]; // m/s (dados reais)
  }
  let x = ((((lon + 180) % 360) + 360) % 360);
  let y = (90 - lat) * (FH / 180);
  if (y < 0) y = 0; else if (y > FH - 1) y = FH - 1;
  const xf = Math.floor(x), yf = Math.floor(y);
  const tx = x - xf, ty = y - yf;
  const x0 = xf % FW, x1 = (xf + 1) % FW;
  const y0 = yf, y1 = y0 + 1 < FH ? y0 + 1 : y0;
  const i00 = (y0 * FW + x0) * 2, i10 = (y0 * FW + x1) * 2;
  const i01 = (y1 * FW + x0) * 2, i11 = (y1 * FW + x1) * 2;
  const u = (FIELD[i00] * (1 - tx) + FIELD[i10] * tx) * (1 - ty) +
            (FIELD[i01] * (1 - tx) + FIELD[i11] * tx) * ty;
  const v = (FIELD[i00 + 1] * (1 - tx) + FIELD[i10 + 1] * tx) * (1 - ty) +
            (FIELD[i01 + 1] * (1 - tx) + FIELD[i11 + 1] * tx) * ty;
  return [u, v];
}

function sampleSPD(lon, lat) {
  if (OD) { const f = sampleField(lon, lat); return Math.hypot(f[0], f[1]); }
  let x = (((((lon + 180) % 360) + 360) % 360)) | 0;
  if (x >= FW) x = FW - 1;
  let y = ((90 - lat) * (FH / 180)) | 0;
  if (y < 0) y = 0; else if (y >= FH) y = FH - 1;
  return SPD[y * FW + x];
}

// vetor de corrente total (campo + turbulência) — usado no movimento e na leitura
function currentAt(lon, lat, ph) {
  const f = sampleField(lon, lat);
  const tb = streamTurb(lon, lat, ph);
  const g = 0.22 + 0.85 * Math.min(sampleSPD(lon, lat) / 2.4, 1);
  return [f[0] + tb[0] * g, f[1] + tb[1] * g];
}

/* ---------- grade de temperatura ---------- */
function buildTempGrid() {
  if (OD && OD.T) {                          // SST real -> normaliza p/ a paleta
    for (let j = 0; j < TH; j++) {
      const lat = 90 - (j + 0.5) / TH * 180;
      for (let i = 0; i < TW; i++) {
        const lon = (i + 0.5) / TW * 360 - 180;
        const c = sampleGrid(OD.T, OD.s, lon, lat);
        const t = (c - SST_MIN) / (SST_MAX - SST_MIN);
        tempGrid[j * TW + i] = t < 0 ? 0 : t > 1 ? 1 : t;
      }
    }
    return;
  }
  const DIRS = 8;
  for (let j = 0; j < TH; j++) {
    const lat = 90 - (j + 0.5) / TH * 180;
    for (let i = 0; i < TW; i++) {
      const lon = (i + 0.5) / TW * 360 - 180;

      const s1 = Math.sin(lon / 50 + 1.0) * Math.cos(lat / 40 - 0.5);
      const s2 = Math.sin(lon / 23 - lat / 30 + 2.0);
      const wlon = lon + 9 * s1 + 4 * s2;
      const wlat = lat + 7 * Math.cos(lon / 38 + 0.7) + 3 * s2;

      let base = Math.cos(Math.max(-89, Math.min(89, wlat)) * Math.PI / 180);
      base = Math.pow(Math.max(0, base), 1.5);

      const L = ((wlon % 360) + 360) % 360;
      const poolLon = smoothstep(20, 80, L) * (1 - smoothstep(190, 250, L));
      const pool = 0.16 * Math.exp(-Math.pow(wlat / 15, 2)) * poolLon;

      const cold = wlat < -42 ? Math.min(0.24, (-42 - wlat) / 55) : 0;

      let t = base + pool - cold;

      if (landData && !isLandLL(lon, lat)) {
        let lr = 0;
        for (let d = 0; d < DIRS; d++) {
          const a = d / DIRS * Math.PI * 2;
          if (isLandLL(lon + 3 * Math.cos(a), lat + 3 * Math.sin(a))) lr += 0.6;
          if (isLandLL(lon + 7 * Math.cos(a), lat + 7 * Math.sin(a))) lr += 0.4;
        }
        lr /= DIRS;
        t += 0.30 * lr * lr * smoothstep(0.06, 0.30, base);
      }

      t += (hash2(i, j) - 0.5) * 0.05;
      tempGrid[j * TW + i] = Math.max(0, Math.min(1, t));
    }
  }
}

function buildSST() {
  sstCanvas.width = TW;
  sstCanvas.height = TH;
  const img = sctx.createImageData(TW, TH);
  const d = img.data;
  for (let p = 0; p < TW * TH; p++) {
    const k = (tempGrid[p] * 255) | 0;
    d[p * 4] = LUT[k * 3];
    d[p * 4 + 1] = LUT[k * 3 + 1];
    d[p * 4 + 2] = LUT[k * 3 + 2];
    d[p * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  sstReady = true;
}

function sampleTemp(lon, lat) {
  let x = ((lon + 180) / 360 * TW) | 0;
  let y = ((90 - lat) / 180 * TH) | 0;
  if (x < 0) x = 0; else if (x >= TW) x = TW - 1;
  if (y < 0) y = 0; else if (y >= TH) y = TH - 1;
  return tempGrid[y * TW + x];
}

/* ---------- partículas ---------- */
function resetParticle(p) {
  if (CURRENTS.length && !(OD && OD.regional) && Math.random() < 0.4) {
    // nasce sobre uma corrente (mais densidade onde há fluxo)
    const c = CURRENTS[(Math.random() * CURRENTS.length) | 0];
    const k = (Math.random() * (c.pts.length - 1)) | 0;
    const tt = Math.random();
    let lon = c.pts[k][0] + (c.pts[k + 1][0] - c.pts[k][0]) * tt + (Math.random() - 0.5) * 2 * c.width;
    let lat = c.pts[k][1] + (c.pts[k + 1][1] - c.pts[k][1]) * tt + (Math.random() - 0.5) * 2 * c.width;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    p.lon = lon;
    p.lat = lat > 84 ? 84 : lat < -84 ? -84 : lat;
  } else {
    // nasce dentro da área visível (mantém densidade ao dar zoom)
    const b = viewBounds();
    for (let k = 0; k < 25; k++) {
      let lon = b.lon0 + Math.random() * (b.lon1 - b.lon0);
      const lat = b.lat0 + Math.random() * (b.lat1 - b.lat0);
      lon = ((lon + 180) % 360 + 360) % 360 - 180;
      if (!isLandLL(lon, lat) || k === 24) { p.lon = lon; p.lat = lat; break; }
    }
  }
  p.age = 0;
  p.maxAge = 14 + Math.random() * 70;
}

function seedParticles() {
  let n = Math.round(W * H / CFG.density);
  n = Math.max(CFG.minP, Math.min(CFG.maxP, n));
  particles = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = {};
    resetParticle(p);
    p.age = Math.random() * p.maxAge;
    particles[i] = p;
  }
  fctx.clearRect(0, 0, W, H);
}

// 3 faixas de velocidade x 3 de temperatura (buckets p/ desenhar)
const SEGS = [[], [], [], [], [], [], [], [], []];
// no modo MAPA, a cor da corrente = temperatura da água (quente laranja / morno âmbar / frio azul)
const TEMPCOL = ['232,104,44', '226,158,46', '20,86,170'];   // [quente, morno, frio]
// no modo CALOR, o fundo já mostra a temperatura -> corrente num tom escuro único
const DARKFLOW = '10,26,54';
// OPACIDADE e ESPESSURA = velocidade: lento = fino/apagado, rápido = grosso/forte
const S_ALPHA = [0.32, 0.62, 0.98];
const S_WIDTH = [0.8, 1.5, 2.5];
const FLOW_CORE = 'rgba(255,252,244,0.55)';   // brilho no miolo das correntes rápidas

function frame(now) {
  rafId = requestAnimationFrame(frame);
  let dt = (now - lastT) / 16.67;
  lastT = now;
  if (dt > 2.5) dt = 2.5; else if (dt < 0.4) dt = 0.4;
  phase += dt;

  fctx.globalCompositeOperation = 'destination-out';
  fctx.fillStyle = 'rgba(0,0,0,' + CFG.fade + ')';
  fctx.fillRect(0, 0, W, H);
  fctx.globalCompositeOperation = 'source-over';

  if (!showCurr) return;

  for (let s = 0; s < 9; s++) SEGS[s].length = 0;

  const cap = CFG.stepCap * dt;
  const gamma = OD ? 1.0 : 1.12;                       // dados reais já em m/s
  const calm = OD ? 0.03 : 0.05;
  const sFast = OD ? 0.85 : 1.7, sMid = OD ? 0.28 : 0.7; // limiares das faixas de velocidade

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];

    const f = sampleField(p.lon, p.lat);
    // fora da região com dados reais não há corrente nem turbulência: a partícula recicla
    const inReg = !ODB || (p.lon >= ODB.lon0 && p.lon <= ODB.lon1 &&
                           p.lat >= ODB.lat0 && p.lat <= ODB.lat1);
    const tb = inReg ? streamTurb(p.lon, p.lat, phase) : [0, 0];
    const ls = Math.hypot(f[0], f[1]);
    const g = OD ? (0.05 + 0.12 * Math.max(0, 1 - ls / 0.4))
                 : (0.30 + 0.8 * Math.min(ls / 2.2, 1));
    const u = f[0] + tb[0] * g;
    const v = f[1] + tb[1] * g;
    const sp = Math.hypot(u, v);

    // só o "olho" do giro (praticamente parado) recicla rápido
    p.age += dt * (ls < calm ? 2.2 : 1);

    if (sp < 1e-4 || p.age > p.maxAge) { resetParticle(p); continue; }

    let step = Math.pow(sp, gamma) * CFG.speed * dt;
    if (step > cap) step = cap;

    const nlon = p.lon + (u / sp) * step;
    const nlat = p.lat + (v / sp) * step;

    if (nlon > 180 || nlon < -180 || nlat > 87 || nlat < -87 || isLandLL(nlon, nlat)) {
      resetParticle(p);
      continue;
    }

    const a = project(p.lon, p.lat);
    const b = project(nlon, nlat);
    const t = sampleTemp(nlon, nlat);
    const tcls = t > 0.55 ? 0 : (t < 0.37 ? 2 : 1);     // quente / morno / frio
    const scls = sp > sFast ? 2 : (sp > sMid ? 1 : 0);
    SEGS[scls * 3 + tcls].push(a[0], a[1], b[0], b[1]);

    p.lon = nlon; p.lat = nlat;
  }

  fctx.lineCap = 'round';
  fctx.lineJoin = 'round';
  for (let sc = 0; sc < 3; sc++) {
    fctx.lineWidth = S_WIDTH[sc];
    for (let tc = 0; tc < 3; tc++) {          // cor pela temperatura (modo mapa), opacidade pela velocidade
      const s = SEGS[sc * 3 + tc];
      if (!s.length) continue;
      fctx.strokeStyle = 'rgba(' + (showSST ? DARKFLOW : TEMPCOL[tc]) + ',' + S_ALPHA[sc] + ')';
      fctx.beginPath();
      for (let k = 0; k < s.length; k += 4) {
        fctx.moveTo(s[k], s[k + 1]);
        fctx.lineTo(s[k + 2], s[k + 3]);
      }
      fctx.stroke();
    }
    if (sc === 2) {                           // miolo claro nas correntes rápidas -> "veio" de água
      fctx.lineWidth = Math.max(0.5, S_WIDTH[sc] - 1.4);
      fctx.strokeStyle = FLOW_CORE;
      fctx.beginPath();
      for (let tc = 0; tc < 3; tc++) {
        const s = SEGS[sc * 3 + tc];
        for (let k = 0; k < s.length; k += 4) {
          fctx.moveTo(s[k], s[k + 1]);
          fctx.lineTo(s[k + 2], s[k + 3]);
        }
      }
      fctx.stroke();
    }
  }
}

/* ---------- camada base (SST + grade + terra) ---------- */
function drawBase() {
  bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bctx.fillStyle = showSST ? '#e9eef2' : MAP.ocean;   // fundo cobre a tela toda (sem tarja)
  bctx.fillRect(0, 0, W, H);

  if (showSST && sstReady) {
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(sstCanvas, 0, 0, TW, TH,
      originX, originY, 360 * scaleK, 180 * scaleK);
  }

  if (showGrat) {
    bctx.beginPath();
    geoPath(graticule);
    bctx.strokeStyle = MAP.grat;
    bctx.lineWidth = 0.75;
    bctx.stroke();
  }

  if (land) {
    // sombra da terra sobre o mar (dá relevo), depois o preenchimento nítido
    bctx.save();
    bctx.beginPath();
    geoPath(land);
    bctx.shadowColor = MAP.landShadow;
    bctx.shadowBlur = 9;
    bctx.shadowOffsetX = 1.5;
    bctx.shadowOffsetY = 2.5;
    bctx.fillStyle = MAP.land;
    bctx.fill();
    bctx.restore();
    bctx.beginPath();
    geoPath(land);
    bctx.fillStyle = MAP.land;
    bctx.fill();
    bctx.strokeStyle = MAP.landLine;
    bctx.lineWidth = 0.7;
    bctx.stroke();
  }

  if (iceCaps) {                    // Antártida = calota de gelo, não terra
    bctx.beginPath();
    geoPath(iceCaps);
    bctx.fillStyle = MAP.ice;
    bctx.fill();
    bctx.strokeStyle = MAP.iceLine;
    bctx.lineWidth = 0.7;
    bctx.stroke();
  }
}

/* ---------- dimensionamento ---------- */
function resize() {
  const hadView = scaleK > 0;
  let cLon = 0, cLat = 0;
  if (hadView) { const c = invert(W / 2, H / 2); cLon = c[0]; cLat = c[1]; }

  const r = baseCanvas.getBoundingClientRect();
  W = Math.max(320, Math.round(r.width));
  H = Math.max(240, Math.round(r.height));
  DPR = Math.min(window.devicePixelRatio || 1, 2);

  for (const cv of [baseCanvas, flowCanvas, routeCanvas]) {
    cv.width = W * DPR;
    cv.height = H * DPR;
  }
  fctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  rctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  baseK = Math.max(W / 360, H / 180);            // "cover": o mapa preenche a tela toda (sem tarja)
  if (!hadView) {
    scaleK = baseK; Z = 1;
    originX = (W - 360 * scaleK) / 2;
    originY = (H - 180 * scaleK) / 2;
  } else {
    scaleK = baseK * Z;
    originX = W / 2 - (cLon + 180) * scaleK;
    originY = H / 2 - (90 - cLat) * scaleK;
  }
  clampView();
  updateProj();
  drawBase();
  drawRoute();
}

/* ---------- carregamento dos continentes ----------
   GeoJSON embutido em world-land.js (window.WORLD_LAND) -> funciona
   abrindo o arquivo direto (file://), sem servidor e sem fetch.       */
async function loadLand() {
  if (window.WORLD_LAND && window.WORLD_LAND.features) return window.WORLD_LAND;
  const urls = [
    'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson',
    'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json',
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { mode: 'cors' });
      if (res.ok) return await res.json();
    } catch (e) { /* tenta o próximo */ }
  }
  return null;
}

// separa as feições cujo ponto mais ao norte fica abaixo de maxLat (ex.: Antártida)
function extractPolar(fc, maxLat) {
  if (!fc || !fc.features) return null;
  const north = (coords) => {
    let m = -Infinity;
    const walk = (o) => {
      if (typeof o[0] === 'number') { if (o[1] > m) m = o[1]; }
      else for (const c of o) walk(c);
    };
    walk(coords);
    return m;
  };
  const feats = fc.features.filter((f) => f.geometry && north(f.geometry.coordinates) < maxLat);
  return feats.length ? { type: 'FeatureCollection', features: feats } : null;
}

/* ============================================================
   ROTEAMENTO — melhor rota entre A e B aproveitando as correntes
   Busca A* numa grade oceânica. O custo de cada trecho é o TEMPO
   de navegação: a corrente a favor acelera, contra/cruzada freia.
   Como a potência do motor é ~constante, menos tempo ≈ menos
   combustível.
   ============================================================ */
const R_EARTH = 6371;

function navLon(o) { return N_LON0 + o * NRES; }
function navLat(a) { return N_LAT0 - a * NRES; }
function navIdx(a, o) { return a * NLON + o; }

function buildNav() {
  if (OD && OD.regional && ODB) {          // grade de navegação alinhada aos dados reais
    NRES = OD.c.dlon;
    N_LON0 = OD.c.lon0;
    N_LAT0 = ODB.lat1;
    N_WRAP = false;
    NLON = OD.c.nlon;
    NLAT = OD.c.nlat;
  }
  NAV = new Uint8Array(NLON * NLAT);
  for (let a = 0; a < NLAT; a++) {
    const lat = navLat(a);
    for (let o = 0; o < NLON; o++) {
      NAV[navIdx(a, o)] = (Math.abs(lat) <= 84 && !isLandLL(navLon(o), lat)) ? 1 : 0;
    }
  }
}

function navSnap(lon, lat) {
  let o0 = Math.round((lon - N_LON0) / NRES);
  o0 = N_WRAP ? ((o0 % NLON) + NLON) % NLON : Math.max(0, Math.min(NLON - 1, o0));
  let a0 = Math.max(0, Math.min(NLAT - 1, Math.round((N_LAT0 - lat) / NRES)));
  if (NAV[navIdx(a0, o0)]) return [a0, o0];
  for (let r = 1; r < 30; r++) {
    for (let da = -r; da <= r; da++) {
      for (let db = -r; db <= r; db++) {
        if (Math.max(Math.abs(da), Math.abs(db)) !== r) continue;
        const a = a0 + da;
        if (a < 0 || a >= NLAT) continue;
        let o = o0 + db;
        if (N_WRAP) o = ((o % NLON) + NLON) % NLON;
        else if (o < 0 || o >= NLON) continue;
        if (NAV[navIdx(a, o)]) return [a, o];
      }
    }
  }
  return null;
}

function havKm(lo1, la1, lo2, la2) {
  const p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180;
  const dp = (la2 - la1) * Math.PI / 180;
  let dl = ((lo2 - lo1 + 540) % 360 - 180) * Math.PI / 180;
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

// tempo (horas) para ir de (lo1,la1) a (lo2,la2) considerando a corrente
function edgeHours(lo1, la1, lo2, la2) {
  const latM = (la1 + la2) / 2;
  let dLon = ((lo2 - lo1 + 540) % 360) - 180;
  const dx = dLon * 111.32 * Math.cos(latM * Math.PI / 180);
  const dy = (la2 - la1) * 110.57;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  const ex = dx / len, ey = dy / len;

  const f = sampleField(lo1 + dLon / 2, latM);            // corrente (m/s) — leste, norte
  const S = OD ? 3.6 : 2.0;                               // m/s -> km/h  (fallback: "unidade" ~2 km/h)
  const cu = f[0] * S;
  const cv = f[1] * S;
  const cPar = cu * ex + cv * ey;                          // componente a favor/contra
  const cPerp2 = Math.max(0, cu * cu + cv * cv - cPar * cPar);

  const Vs = SHIP.kn * KMH_PER_KN;
  const avail = Vs * Vs - cPerp2;                          // sobra p/ avançar após vencer a corrente cruzada
  if (avail <= 1) return Infinity;
  const ground = Math.sqrt(avail) + cPar;                  // velocidade efetiva sobre o fundo
  if (ground < 0.5) return Infinity;                       // não consegue avançar contra a corrente
  return len / ground;
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    this.k.push(key); this.p.push(pri);
    let i = this.k.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.p[par] <= this.p[i]) break;
      this._sw(i, par); i = par;
    }
  }
  pop() {
    const top = this.k[0];
    const lk = this.k.pop(), lp = this.p.pop();
    if (this.k.length) {
      this.k[0] = lk; this.p[0] = lp;
      let i = 0;
      for (;;) {
        let s = i; const l = 2 * i + 1, r = 2 * i + 2;
        if (l < this.k.length && this.p[l] < this.p[s]) s = l;
        if (r < this.k.length && this.p[r] < this.p[s]) s = r;
        if (s === i) break;
        this._sw(i, s); i = s;
      }
    }
    return top;
  }
  _sw(a, b) {
    const tk = this.k[a]; this.k[a] = this.k[b]; this.k[b] = tk;
    const tp = this.p[a]; this.p[a] = this.p[b]; this.p[b] = tp;
  }
}

const NB8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function aStar(aS, oS, aG, oG) {
  const N = NLON * NLAT;
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const startI = navIdx(aS, oS), goalI = navIdx(aG, oG);
  const goalLon = navLon(oG), goalLat = navLat(aG);
  const maxGround = (SHIP.kn + 6) * KMH_PER_KN;
  g[startI] = 0;
  const heap = new MinHeap();
  heap.push(startI, havKm(navLon(oS), navLat(aS), goalLon, goalLat) / maxGround);

  let guard = 0;
  while (heap.size) {
    if (++guard > 800000) break;
    const cur = heap.pop();
    if (cur === goalI) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ca = (cur / NLON) | 0, co = cur % NLON;
    const clon = navLon(co), clat = navLat(ca);
    for (let n = 0; n < 8; n++) {
      const na = ca + NB8[n][0];
      if (na < 0 || na >= NLAT) continue;
      let no = co + NB8[n][1];
      if (N_WRAP) no = ((no % NLON) + NLON) % NLON;
      else if (no < 0 || no >= NLON) continue;
      const ni = na * NLON + no;
      if (!NAV[ni] || closed[ni]) continue;
      if (NB8[n][0] !== 0 && NB8[n][1] !== 0) {
        if (!NAV[ca * NLON + no] || !NAV[na * NLON + co]) continue; // não corta canto de terra
      }
      const dt = edgeHours(clon, clat, navLon(no), navLat(na));
      if (!isFinite(dt)) continue;
      const ng = g[cur] + dt;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        heap.push(ni, ng + havKm(navLon(no), navLat(na), goalLon, goalLat) / maxGround);
      }
    }
  }
  if (goalI !== startI && came[goalI] === -1) return null;
  const path = [];
  let c = goalI;
  while (c !== -1) {
    path.push([navLon(c % NLON), navLat((c / NLON) | 0)]);
    if (c === startI) break;
    c = came[c];
  }
  path.reverse();
  return { path, hours: g[goalI] };
}

// tempo da rota reta A->B (mesma física); null se cruzar terra
function straightHours(A, B) {
  let dLon = ((B[0] - A[0] + 540) % 360) - 180;
  const M = 160;
  let total = 0;
  for (let i = 0; i < M; i++) {
    const lo1 = A[0] + dLon * (i / M), la1 = A[1] + (B[1] - A[1]) * (i / M);
    const lo2 = A[0] + dLon * ((i + 1) / M), la2 = A[1] + (B[1] - A[1]) * ((i + 1) / M);
    if (isLandLL(lo1, la1) || isLandLL(lo2, la2)) return null;
    const dt = edgeHours(lo1, la1, lo2, la2);
    if (!isFinite(dt)) return null;
    total += dt;
  }
  return total;
}

function pathKm(p) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += havKm(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
  return s;
}

// suaviza a rota (Chaikin) tratando o antimeridiano
function smoothPath(p) {
  if (p.length < 3) return p;
  const u = [p[0].slice()];
  for (let i = 1; i < p.length; i++) {
    let d = ((p[i][0] - u[i - 1][0] + 540) % 360) - 180;
    u.push([u[i - 1][0] + d, p[i][1]]);
  }
  let cur = u;
  for (let it = 0; it < 2; it++) {
    const out = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const A = cur[i], B = cur[i + 1];
      const q = [A[0] * 0.75 + B[0] * 0.25, A[1] * 0.75 + B[1] * 0.25];
      const r = [A[0] * 0.25 + B[0] * 0.75, A[1] * 0.25 + B[1] * 0.75];
      out.push(isLandLL(((q[0] + 180) % 360 + 360) % 360 - 180, q[1]) ? A : q);
      out.push(isLandLL(((r[0] + 180) % 360 + 360) % 360 - 180, r[1]) ? B : r);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur.map((pt) => [((pt[0] + 180) % 360 + 360) % 360 - 180, pt[1]]);
}

function fmtKm(k) { return k >= 1000 ? (k / 1000).toFixed(2) + ' mil km' : k.toFixed(0) + ' km'; }
function fmtDur(h) {
  if (!isFinite(h)) return '—';
  const d = Math.floor(h / 24), hh = Math.round(h - d * 24);
  return d > 0 ? d + ' d ' + hh + ' h' : hh + ' h';
}
function fmtL(l) {
  return l >= 1e6 ? (l / 1e6).toFixed(2) + ' milhões L' : (l / 1000).toFixed(0) + ' mil L';
}

function computeRoute() {
  if (!routeA || !routeB || !NAV) return;
  routeInfoEl.textContent = 'calculando rota…';
  const s = navSnap(routeA[0], routeA[1]);
  const gg = navSnap(routeB[0], routeB[1]);
  if (!s || !gg) { routePath = null; routeInfoEl.textContent = 'ponto fora do oceano navegável.'; drawRoute(); return; }

  const A = [navLon(s[1]), navLat(s[0])];
  const B = [navLon(gg[1]), navLat(gg[0])];
  const res = aStar(s[0], s[1], gg[0], gg[1]);
  if (!res || res.path.length < 2) {
    routePath = null;
    routeInfoEl.textContent = 'não achei rota — os pontos estão separados por terra?';
    drawRoute();
    return;
  }

  routePath = smoothPath(res.path);
  const km = pathKm(routePath);
  const hOpt = res.hours;
  const ref = straightHours(A, B);
  const refKm = havKm(A[0], A[1], B[0], B[1]);
  const L_PER_H = 2200;              // consumo do motor (estimativa) em litros/hora

  let txt = 'Rota otimizada\n  ' + fmtKm(km) + '  ·  ' + fmtDur(hOpt) + '  ·  ~' + fmtL(hOpt * L_PER_H) + '\n';
  if (ref != null) {
    const dT = (1 - hOpt / ref) * 100;
    txt += 'Rota direta\n  ' + fmtKm(refKm) + '  ·  ' + fmtDur(ref) + '  ·  ~' + fmtL(ref * L_PER_H) + '\n';
    if (dT >= 0.5) txt += '➜ ~' + dT.toFixed(0) + '% menos tempo e combustível (a favor das correntes)';
    else if (dT <= -0.5) txt += '➜ a reta seria ~' + (-dT).toFixed(0) + '% mais curta em tempo, mas enfrenta correntes';
    else txt += '➜ praticamente igual à rota direta aqui';
  } else {
    txt += 'A rota direta cruzaria terra — sem comparação.';
  }
  routeInfoEl.textContent = txt;
  drawRoute();
}

function handleMapClick(px, py) {
  if (!routeMode) return;
  const ll = invert(px, py);
  if (ll[1] > 89 || ll[1] < -89) return;
  const lon = ((ll[0] + 180) % 360 + 360) % 360 - 180;
  lastRouteClick = performance.now();
  if (routeMode === 'A') {
    routeA = [lon, ll[1]]; routeB = null; routePath = null;
    routeMode = 'B';
    routeInfoEl.textContent = 'agora clique no destino (ponto B).';
    drawRoute();
  } else {
    routeB = [lon, ll[1]];
    routeMode = null;
    flowCanvas.classList.remove('picking');
    computeRoute();
  }
}

/* ---------- desenho da rota (canvas próprio, por cima do fluxo) ---------- */
function strokeRoute(p) {
  rctx.beginPath();
  let prev = null;
  for (let i = 0; i < p.length; i++) {
    const s = project(p[i][0], p[i][1]);
    if (i === 0 || (prev && Math.abs(s[0] - prev[0]) > W * 0.5)) rctx.moveTo(s[0], s[1]);
    else rctx.lineTo(s[0], s[1]);
    prev = s;
  }
  rctx.stroke();
}

function drawRouteArrows(p) {
  rctx.fillStyle = MAP.route;
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = project(p[i - 1][0], p[i - 1][1]);
    const b = project(p[i][0], p[i][1]);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len > W * 0.5 || len < 1e-3) continue;
    acc += len;
    if (acc < 95) continue;
    acc = 0;
    const ang = Math.atan2(dy, dx);
    rctx.save();
    rctx.translate(b[0], b[1]);
    rctx.rotate(ang);
    rctx.beginPath();
    rctx.moveTo(0, 0); rctx.lineTo(-9, 4.5); rctx.lineTo(-9, -4.5); rctx.closePath();
    rctx.fill();
    rctx.restore();
  }
}

function drawPin(ll, color, label) {
  const s = project(ll[0], ll[1]);
  rctx.beginPath();
  rctx.arc(s[0], s[1], 8, 0, Math.PI * 2);
  rctx.fillStyle = color;
  rctx.strokeStyle = 'rgba(0,0,0,0.65)';
  rctx.lineWidth = 2;
  rctx.fill();
  rctx.stroke();
  rctx.fillStyle = '#04121a';
  rctx.font = 'bold 10px "Segoe UI", sans-serif';
  rctx.textAlign = 'center';
  rctx.textBaseline = 'middle';
  rctx.fillText(label, s[0], s[1]);
}

function drawRoute() {
  rctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  rctx.clearRect(0, 0, W, H);
  if (routePath && routePath.length > 1) {
    rctx.lineJoin = 'round';
    rctx.lineCap = 'round';
    rctx.strokeStyle = 'rgba(255,255,255,0.75)';
    rctx.lineWidth = 6;
    strokeRoute(routePath);
    rctx.strokeStyle = MAP.route;
    rctx.lineWidth = 2.5;
    strokeRoute(routePath);
    drawRouteArrows(routePath);
  }
  if (routeA) drawPin(routeA, '#4ade80', 'A');
  if (routeB) drawPin(routeB, '#f87171', 'B');
}

/* ---------- legenda ---------- */
function buildLegend() {
  const idxByKey = { cold: 2, mild: 1, warm: 0 };   // posição em TEMPCOL
  document.querySelectorAll('#lg-currents .lg-swatches span').forEach((el) => {
    const i = idxByKey[el.dataset.c];
    if (i != null) el.style.background = 'rgb(' + TEMPCOL[i] + ')';
  });
  const cv = document.getElementById('lg-sst-bar');
  if (cv) {
    const g = cv.getContext('2d'), w = cv.width, h = cv.height;
    for (let x = 0; x < w; x++) {
      const k = Math.round((x / (w - 1)) * 255);
      g.fillStyle = 'rgb(' + LUT[k * 3] + ',' + LUT[k * 3 + 1] + ',' + LUT[k * 3 + 2] + ')';
      g.fillRect(x, 0, 1, h);
    }
  }
}
function updateLegend() {
  const sw = document.querySelector('#lg-currents .lg-swatches');
  const sst = document.getElementById('lg-sst');
  if (sw) sw.hidden = showSST;          // no modo calor as correntes são linhas escuras
  if (sst) sst.hidden = !showSST;
}

/* ---------- botão "Atualizar correntes" (precisa do servidor local) ---------- */
function bindUpdateButton() {
  const btn = document.getElementById('d-update');
  const st = document.getElementById('d-status');
  if (!btn || !st) return;

  if (location.protocol === 'file:') {
    btn.disabled = true;
    st.textContent = 'Para atualizar pelo site, abra assim:\n  python servidor.py';
    return;
  }

  const poll = async () => {
    try {
      const j = await (await fetch('/api/status', { cache: 'no-store' })).json();
      const last = j.log && j.log.length ? j.log[j.log.length - 1] : '';
      if (j.state === 'running') {
        st.textContent = 'atualizando…\n' + last;
        setTimeout(poll, 2000);
      } else if (j.state === 'done') {
        st.textContent = 'pronto — recarregando…';
        setTimeout(() => location.reload(), 900);
      } else if (j.state === 'error') {
        st.textContent = 'erro:\n' + last;
        btn.disabled = false;
      } else {
        btn.disabled = false;
      }
    } catch (e) {
      st.textContent = 'perdi contato com o servidor.';
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    st.textContent = 'iniciando…';
    try {
      const r = await fetch('/api/atualizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (r.status === 202) { poll(); return; }
      const j = await r.json().catch(() => ({}));
      st.textContent = j.erro || ('erro ' + r.status);
      btn.disabled = false;
    } catch (e) {
      st.textContent = 'sem servidor. Abra com:\n  python servidor.py';
      btn.disabled = false;
    }
  });

  // se recarregou no meio de uma atualização, retoma o acompanhamento
  fetch('/api/status', { cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => { if (j.state === 'running') { btn.disabled = true; poll(); } })
    .catch(() => {});
}

/* ---------- controles ---------- */
function bindControls() {
  // estado inicial = o que estiver marcado no HTML
  showSST = document.getElementById('t-sst').checked;
  showCurr = document.getElementById('t-curr').checked;
  showGrat = document.getElementById('t-grat').checked;

  document.getElementById('t-sst').addEventListener('change', (e) => { showSST = e.target.checked; updateLegend(); drawBase(); drawRoute(); });
  document.getElementById('t-grat').addEventListener('change', (e) => { showGrat = e.target.checked; drawBase(); });
  document.getElementById('t-curr').addEventListener('change', (e) => { showCurr = e.target.checked; });
  document.getElementById('t-speed').addEventListener('input', (e) => { CFG.speed = (+e.target.value) / 100; });
  document.getElementById('t-reseed').addEventListener('click', seedParticles);
  document.getElementById('z-in').addEventListener('click', () => setZoom(Z * 1.5, W / 2, H / 2));
  document.getElementById('z-out').addEventListener('click', () => setZoom(Z / 1.5, W / 2, H / 2));
  document.getElementById('z-reset').addEventListener('click', resetView);

  routeInfoEl = document.getElementById('r-info');
  document.getElementById('r-pick').addEventListener('click', () => {
    routeMode = 'A'; routeA = routeB = routePath = null;
    routeInfoEl.textContent = 'clique no ponto de partida (ponto A).';
    flowCanvas.classList.add('picking');
    drawRoute();
  });
  document.getElementById('r-clear').addEventListener('click', () => {
    routeMode = null; routeA = routeB = routePath = null;
    routeInfoEl.textContent = '';
    flowCanvas.classList.remove('picking');
    drawRoute();
  });
  document.getElementById('r-speed').addEventListener('input', (e) => {
    SHIP.kn = +e.target.value;
    document.getElementById('r-kn').textContent = e.target.value;
    if (routeA && routeB && !routeMode) computeRoute();
  });

  bindUpdateButton();

  let drag = null, touch = null;

  flowCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = flowCanvas.getBoundingClientRect();
    setZoom(Z * Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  flowCanvas.addEventListener('dblclick', (e) => {
    if (routeMode || performance.now() - lastRouteClick < 400) return;
    const r = flowCanvas.getBoundingClientRect();
    setZoom(Z * 1.8, e.clientX - r.left, e.clientY - r.top);
  });

  flowCanvas.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    flowCanvas.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
    originX += e.clientX - drag.x;
    originY += e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    clampView();
    updateProj();
    fctx.clearRect(0, 0, W, H);
    requestBase();
  });
  window.addEventListener('mouseup', (e) => {
    if (drag && drag.moved < 5) {
      const r = flowCanvas.getBoundingClientRect();
      handleMapClick(e.clientX - r.left, e.clientY - r.top);
    }
    drag = null;
    flowCanvas.classList.remove('grabbing');
  });

  flowCanvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touch = { mode: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY, moved: 0 };
    } else if (e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1];
      touch = {
        mode: 'pinch',
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2,
      };
    }
  }, { passive: false });
  flowCanvas.addEventListener('touchmove', (e) => {
    if (!touch) return;
    e.preventDefault();
    const r = flowCanvas.getBoundingClientRect();
    if (touch.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      touch.moved += Math.abs(t.clientX - touch.x) + Math.abs(t.clientY - touch.y);
      originX += t.clientX - touch.x;
      originY += t.clientY - touch.y;
      touch.x = t.clientX; touch.y = t.clientY;
      clampView();
      updateProj();
      fctx.clearRect(0, 0, W, H);
      requestBase();
    } else if (touch.mode === 'pinch' && e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1];
      const nd = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setZoom(Z * (nd / touch.d), touch.cx - r.left, touch.cy - r.top);
      touch.d = nd;
    }
  }, { passive: false });
  flowCanvas.addEventListener('touchend', (e) => {
    if (touch && touch.mode === 'pan' && touch.moved < 8 && !e.touches.length) {
      const r = flowCanvas.getBoundingClientRect();
      handleMapClick(touch.x - r.left, touch.y - r.top);
    }
    if (!e.touches.length) touch = null;
  });

  flowCanvas.addEventListener('mousemove', (ev) => {
    if (drag || touch) return;
    const r = flowCanvas.getBoundingClientRect();
    const ll = invert(ev.clientX - r.left, ev.clientY - r.top);
    if (ll[1] > 90 || ll[1] < -90) { readoutEl.textContent = ''; return; }
    const lon = ((ll[0] + 180) % 360 + 360) % 360 - 180;
    const cv = sampleField(lon, ll[1]);
    const sp = Math.hypot(cv[0], cv[1]);
    const NS = ll[1] >= 0 ? 'N' : 'S';
    const EW = lon >= 0 ? 'E' : 'O';
    let extra;
    if (ODB && (lon < ODB.lon0 || lon > ODB.lon1 || ll[1] < ODB.lat0 || ll[1] > ODB.lat1)) {
      extra = 'fora da área com dados';
    } else if (OD) {
      const lab = sp < 0.08 ? 'quase parado' : sp < 0.25 ? 'lento'
                : sp < 0.6 ? 'moderado' : sp < 1.0 ? 'rápido' : 'muito rápido';
      extra = sp.toFixed(2) + ' m/s (' + lab + ')';
    } else {
      extra = 'fluxo ' + (sp < 0.35 ? 'muito lento' : sp < 0.9 ? 'lento'
                        : sp < 1.7 ? 'moderado' : sp < 2.5 ? 'rápido' : 'muito rápido');
    }
    readoutEl.textContent =
      Math.abs(ll[1]).toFixed(1) + '°' + NS + '  ' +
      Math.abs(lon).toFixed(1) + '°' + EW + '   ·   ' + extra;
  });
  flowCanvas.addEventListener('mouseleave', () => { readoutEl.textContent = ''; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      lastT = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 180); });
}

/* ---------- inicialização ---------- */
async function init() {
  resize();
  bindControls();

  MD = window.MARINE_DATA || null;
  OD = decodeMarine(curDay) || decodeOceanData();   // dados regionais (xlsx) têm prioridade
  if (OD) {
    const regional = OD.regional;
    CFG.speed = regional ? 0.30 : 0.22;
    const sl = document.getElementById('t-speed');
    if (sl) sl.value = regional ? 30 : 22;
    const bs = document.querySelector('#brand span');
    if (bs) bs.textContent = regional
      ? 'dados reais · Copernicus Marine · correntes de superfície (SST: modelo)'
      : 'dados reais · ' + (OD.source || 'Copernicus / NOAA');
    if (regional) {
      ODB = regionBounds(OD.c);
      graticule = d3.geoGraticule().step([2, 2])();
      fitRegion(ODB);
      setupDaySelector();
    }
  }

  readoutEl.textContent = 'preparando o mapa…';
  land = await loadLand();
  if (!land) warnEl.hidden = false;
  iceCaps = extractPolar(land, -60);   // Antártida -> desenhada como gelo

  await new Promise((r) => setTimeout(r, 16)); // deixa a mensagem aparecer

  prepCurrents();
  buildLandMask();
  buildNav();
  if (!OD) buildField();          // campo analítico só quando não há dados reais
  buildTempGrid();
  buildSST();
  buildLegend();
  updateLegend();
  drawBase();
  drawRoute();
  seedParticles();

  readoutEl.textContent = '';
  lastT = performance.now();
  rafId = requestAnimationFrame(frame);
}

init();
