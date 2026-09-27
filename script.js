'use strict';

/* ============================================================
   Correntes Oceânicas — mapa de fluxo estilo "earth"
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
const portTooltipEl = document.getElementById('port-tooltip');
let routeInfoEl = null;

/* ---------- configuração ---------- */
const CFG = { fade: 0.042, speed: 0.16, stepCap: 0.9, density: 360, minP: 1400, maxP: 8800 };

/* ---------- níveis de densidade de partículas (para celulares mais fracos) ---------- */
const DENSITY_LEVELS = {
  alta:  { density: 360,  minP: 1400, maxP: 8800 },
  media: { density: 650,  minP: 700,  maxP: 4200 },
  baixa: { density: 1200, minP: 300,  maxP: 1600 },
};

/* ---------- paleta cartográfica (estilo satélite / Blue Marble) ----------
   oceano e continentes vêm das texturas de buildSatelliteTextures(); estas cores
   são o fallback (antes das texturas ficarem prontas) e os elementos por cima. */
const MAP_LIGHT = {
  ocean:    '#0b2a4f',
  land:     '#4d6b35',
  landLine: 'rgba(255,255,255,0.14)',
  landDim:  null,
  oceanDim: null,
  grat:     'rgba(205,228,245,0.17)',
  route:    '#35a7ff',
  ice:      '#e8ecef',
  iceShade: '#d0dfe5',
  iceLine:  'rgba(255,255,255,0.5)',
  border:   'rgba(255,246,215,0.5)',
  label:    '#fbf8ef',
  labelHalo: 'rgba(12,22,16,0.62)',
  navRoute: 'rgba(255,208,140,0.6)',
  navLabel: '#ffd9a3',
  oceanLabel: 'rgba(196,224,246,0.72)',
  oceanLabelHalo: 'rgba(4,16,36,0.55)',
  port: '#e8b23a',
  portRing: '#7a4f10',
  portGlow: 'rgba(232,178,58,0.65)',
};
const MAP_DARK = {
  ocean:    '#061a33',
  land:     '#34482a',
  landLine: 'rgba(255,255,255,0.1)',
  landDim:  'rgba(0,0,0,0.24)',
  oceanDim: 'rgba(0,6,18,0.3)',
  grat:     'rgba(180,210,235,0.13)',
  route:    '#6fb8ff',
  ice:      '#cdd6dc',
  iceShade: '#b2c0c9',
  iceLine:  'rgba(255,255,255,0.35)',
  border:   'rgba(230,225,200,0.4)',
  label:    '#e9eee8',
  labelHalo: 'rgba(0,0,0,0.7)',
  navRoute: 'rgba(240,190,120,0.55)',
  navLabel: '#e8c08a',
  oceanLabel: 'rgba(160,195,225,0.6)',
  oceanLabelHalo: 'rgba(0,8,20,0.6)',
  port: '#ffd166',
  portRing: '#4a3005',
  portGlow: 'rgba(255,209,102,0.75)',
};
const MAP = Object.assign({}, MAP_LIGHT);
const TW = 512, TH = 256;
const MW = 1024, MH = 512;
const FW = 360, FH = 180;

/* ---------- estado ---------- */
let W = 0, H = 0, DPR = 1;
let proj = null, geoPath = null;
let scaleK = 0, originX = 0, originY = 0, baseK = 1, Z = 1;
let land = null;
let landData = null;
let countries = null;
let majorCountries = []; // lista fixa dos países exibidos — calculada uma única vez
/* gelo/neve polar: territórios específicos (por nome) + faixas de latitude */
const POLAR_TERRITORY_NAMES = new Set(['Greenland', 'Antarctica']);
const POLAR_HARD_LAT = 65; // a partir daqui é 100% gelo
const POLAR_SOFT_LAT = 55; // abaixo daqui é 100% cor normal de terra — entre os dois, degradê
let polarTerritories = null;
let panning = false;
let labelRects = [];
const tempGrid = new Float32Array(TW * TH);
const FIELD = new Float32Array(FW * FH * 2);
const SPD = new Float32Array(FW * FH);
const sstCanvas = document.createElement('canvas');
const sctx = sstCanvas.getContext('2d');
let sstReady = false;
const BW = 2048, BH = 1024;
const bordersCanvas = document.createElement('canvas');
const brctx = bordersCanvas.getContext('2d');
let bordersReady = false;
let particles = [];
let showSST = false, showCurr = true, showGrat = true, showNavRoutes = true, showPorts = false;
const PORTS = (window.GLOBAL_PORTS_DATA || []);
const PORT_BY_ID = new Map(PORTS.map((p) => [p.id, p]));
/* LOD (Level of Detail): quanto maior minZ, mais perto é preciso dar zoom
   pra o porto aparecer — Z=1 é o mundo inteiro na tela. */
const PORT_SIZE_META = {
  'Grande Hub':           { minZ: 0,   r: 5.5, glow: 12 },
  'Porto Regional':       { minZ: 2.2, r: 4,   glow: 8  },
  'Ancoradouro/Terminal': { minZ: 5,   r: 2.8, glow: 5  },
};
function portMeta(p) { return PORT_SIZE_META[p.size] || PORT_SIZE_META['Ancoradouro/Terminal']; }
let portScreenPos = []; // recalculado a cada drawPorts(): [{x,y,port}]
let hoveredPort = null;
let phase = 0, lastT = performance.now(), rafId = 0;
let graticule = d3.geoGraticule10();

/* ---------- estado da rota ---------- */
const SHIP = { kn: 18 };
let routeA = null, routeB = null;
let routeAPort = null, routeBPort = null;
let routePath = null;
let routeMode = null;
let routeIsEmergency = false;
let emergencyMode = false;
let lastRouteClick = 0;

/* ---------- Copiloto IA: 3 motores de rota (Padrão / A* Python / LLM) ---------- */
let routeVariants = null;     // {key, baseline:{path,km,hours,...}, astar:{...}, llm:{...,rationale}}
let routeDisplayMode = 'astar'; // 'astar' | 'llm' | 'both' -- controla o que aparece no mapa
let pulsePhase = 0;
let lastHoverLL = null;       // [lon,lat] sob o cursor — "ponto atual" das Previsões IA
let oilSpill = null;          // {origin, volume_ton, frames:[{hour,lat,lon,radius_km}], title, explanation, drift_*}
let fishHotspots = null;      // {origin, raio_km, hotspots:[{lat,lon,score,title,explanation,...}]}

let NAV = null;
let NRES = 1;
let NLON = Math.round(360 / NRES);
let NLAT = Math.round(180 / NRES) + 1;
let N_LON0 = -180, N_LAT0 = 90;
let N_WRAP = true;
const KMH_PER_KN = 1.852;

/* ---------- dados oceânicos reais (NOAA CoastWatch), se ocean-data.js existir ---------- */
let OD = null;
let ODB = null;
let MD = null;
let curDay = 0;
const SST_MIN = -2, SST_MAX = 32;

function b64ToI16(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function decodeOceanData() {
  const src = window.OCEAN_DATA;
  if (!src) return null;
  const cu = b64ToI16(src.cur.u), cv = b64ToI16(src.cur.v);
  const U = new Float32Array(cu.length), V = new Float32Array(cv.length);
  for (let i = 0; i < cu.length; i++) { U[i] = cu[i] / 1000; V[i] = cv[i] / 1000; }
  let T = null;
  if (src.sst && src.sst.t) {
    const st = b64ToI16(src.sst.t);
    T = new Float32Array(st.length);
    for (let i = 0; i < st.length; i++) T[i] = st[i] / 100;
  }
  return { U, V, T, c: src.cur, s: src.sst || null, source: src.source, regional: false };
}

function decodeMarine(day) {
  const src = window.MARINE_DATA;
  if (!src || !src.frames || !src.frames.length) return null;
  const d = Math.max(0, Math.min(src.frames.length - 1, day | 0));
  const cu = b64ToI16(src.frames[d].u), cv = b64ToI16(src.frames[d].v);
  const U = new Float32Array(cu.length), V = new Float32Array(cv.length);
  for (let i = 0; i < cu.length; i++) { U[i] = cu[i] / 1000; V[i] = cv[i] / 1000; }
  return { U, V, T: null, c: src.grid, s: null, source: src.source, regional: true };
}

function regionBounds(g) {
  return {
    lon0: g.lon0, lon1: g.lon0 + (g.nlon - 1) * g.dlon,
    lat0: g.lat0, lat1: g.lat0 + (g.nlat - 1) * g.dlat,
  };
}

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

/* ---------- rotas de navegação (comerciais e estratégicas) ----------
   os pontos abaixo são só os portos/passagens-chave; o traçado real entre
   eles é calculado pelo mesmo A* náutico usado em "Traçar rota", então a
   linha sempre segue por água. */
const NAV_ROUTES = [
  { name: 'Transpacífico (Ásia–EUA)', via: [[121.8,31.2],[175,48],[-118.2,33.7]] },
  { name: 'Transatlântico Norte', via: [[4.5,51.9],[-30,45],[-74.0,40.6]] },
  { name: 'Ásia–Europa (Canal de Suez)',
    via: [[103.8,1.3],[80,6],[43.3,12.6],[32.4,30.6],[4.5,51.9]] },
  { name: 'Ásia–Europa (Cabo da Boa Esperança)',
    via: [[103.8,1.3],[57,-22],[18.4,-34.4],[4.5,51.9]] },
  { name: 'Canal do Panamá',
    via: [[-118.2,33.7],[-84.9,9.1],[-79.7,9.1],[-74.0,40.6]] },
  { name: 'Estreito de Malaca', via: [[72.8,18.9],[80,6],[100.3,5.4],[121.8,31.2]] },
  { name: 'Rota do Ártico (Passagem do Nordeste)',
    via: [[33.1,69.0],[90,76],[170,69],[-168.9,65.8]] },
];

/* ---------- nomes dos oceanos ---------- */
const OCEAN_LABELS = [
  { name: 'Oceano Atlântico', lon: -30, lat: 10 },
  { name: 'Oceano Pacífico', lon: -150, lat: -25 },
  { name: 'Oceano Pacífico', lon: 172, lat: -20 },
  { name: 'Oceano Índico', lon: 75, lat: -18 },
  { name: 'Oceano Ártico', lon: 0, lat: 84 },
  { name: 'Oceano Antártico', lon: 0, lat: -65 },
];

/* ---------- circulação de fundo: giros das bacias ---------- */
const BG_GYRES = [
  { lon: -45,  lat: 30,  rx: 34, ry: 17, dir: -1, s: 1.15 },
  { lon: -175, lat: 30,  rx: 52, ry: 19, dir: -1, s: 1.15 },
  { lon: -16,  lat: -25, rx: 24, ry: 17, dir:  1, s: 1.10 },
  { lon: -125, lat: -27, rx: 55, ry: 19, dir:  1, s: 1.10 },
  { lon: 75,   lat: -28, rx: 34, ry: 17, dir:  1, s: 1.10 },
  { lon: -35,  lat: 56,  rx: 20, ry: 11, dir:  1, s: 0.75 },
  { lon: -165, lat: 53,  rx: 26, ry: 12, dir:  1, s: 0.70 },
  { lon: 66,   lat: 12,  rx: 16, ry: 9,  dir: -1, s: 0.55 },
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

/* ---------- paleta de temperatura (LUT de 256 cores) ---------- */
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
  const zmin = (OD && OD.regional) ? 1 : Math.min(1, (W / 360) / baseK);
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
  if (OD && OD.regional && ODB) {
    fitRegion(ODB);
    fctx.clearRect(0, 0, W, H);
    drawBase();
    drawRoute();
    return;
  }
  scaleK = W / 360; Z = scaleK / baseK;
  originX = 0;
  originY = (H - 180 * scaleK) / 2;
  clampView();
  updateProj();
  fctx.clearRect(0, 0, W, H);
  drawBase();
  drawRoute();
}

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

/* ---------- texturas estilo satélite (Natural Earth / Blue Marble) ----------
   geradas UMA vez, equiretangulares cobrindo o globo inteiro; a cada redesenho
   o drawBase só estica a imagem pro zoom/pan atual (mesmo truque das fronteiras). */
const SAT_W = 2048, SAT_H = 1024;
const satOceanCanvas = document.createElement('canvas');
const satLandCanvas = document.createElement('canvas');
let satReady = false;

// [lon, lat, raio em lon, raio em lat, intensidade]
const SAT_DESERTS = [
  [8, 23, 30, 10, 1],        // Saara
  [-9, 23, 9, 7, 1],         // Saara ocidental / Mauritânia
  [26, 25, 11, 8, 1],        // deserto da Líbia / Egito
  [0, 15, 20, 4, 0.45],      // Sahel (transição)
  [47, 23, 12, 9, 1],        // Península Arábica
  [58, 30, 11, 6, 0.85],     // Irã / Paquistão
  [71, 27, 4, 3, 0.7],       // Thar
  [60, 41, 8, 4, 0.75],      // Karakum / Kyzylkum
  [84, 39, 9, 3.5, 0.9],     // Taklamakan
  [104, 43, 13, 4.5, 0.8],   // Gobi
  [88, 33, 10, 4, 0.45],     // planalto tibetano (estepe fria)
  [133, -25, 16, 8, 0.9],    // interior australiano
  [19, -24, 7, 6, 0.8],      // Kalahari / Namíbia
  [45, 7, 6, 5, 0.6],        // Chifre da África
  [-70, -23, 2.5, 7, 0.95],  // Atacama
  [-68, -44, 4, 6, 0.55],    // Patagônia
  [-113, 33, 8, 6, 0.75],    // sudoeste dos EUA / Sonora
  [-104, 27, 4, 4, 0.5],     // Chihuahua
  [-40, -8, 4, 3, 0.35],     // sertão nordestino
];
const SAT_MOUNTAINS = [
  [84, 30, 14, 3.5, 1],      // Himalaia
  [88, 34, 14, 4, 0.7],      // Tibete
  [76, 37, 6, 3, 0.85],      // Karakoram / Pamir
  [80, 42, 8, 2, 0.7],       // Tian Shan
  [-78, -4, 3, 9, 0.9],      // Andes norte
  [-69, -20, 3, 10, 1],      // Andes centrais
  [-70, -36, 2, 9, 0.9],     // Andes sul
  [-113, 45, 7, 12, 0.75],   // Rochosas
  [-124, 56, 5, 8, 0.6],     // Costeiras do Canadá
  [10, 46, 5, 1.6, 0.8],     // Alpes
  [44, 42, 4, 1.5, 0.7],     // Cáucaso
  [50, 32, 5, 4, 0.55],      // Zagros
  [39, 9, 4, 4, 0.6],        // planalto etíope
  [148, -30, 2.2, 10, 0.4],  // Grande Cordilheira Divisória
  [-2, 32, 6, 2, 0.5],       // Atlas
  [100, 50, 12, 4, 0.45],    // Altai / Sayan
  [-150, 63, 12, 4, 0.55],   // Alasca
];
// cor da vegetação por |latitude|: floresta tropical -> savana -> temperado -> taiga -> tundra
const SAT_VEG = [
  [0, 22, 58, 24],
  [9, 30, 70, 28],
  [17, 104, 112, 56],
  [26, 82, 104, 50],
  [36, 88, 100, 54],
  [46, 56, 90, 40],
  [56, 36, 64, 36],
  [64, 92, 90, 70],
  [74, 138, 134, 116],
];

function blobField(list, lon, lat) {
  let v = 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const dx = (((lon - b[0] + 540) % 360) - 180) / b[2];
    const dy = (lat - b[1]) / b[3];
    const d = dx * dx + dy * dy;
    if (d < 1) {
      const w = (1 - smoothstep(0.3, 1, d)) * b[4];
      if (w > v) v = w;
    }
  }
  return v;
}

function vnoise(x, y, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
  const a = hash2(x0, yi), b = hash2(x1, yi), c = hash2(x0, yi + 1), d = hash2(x1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// fBm periódico na longitude (u, v em [0,1]) — sem emenda no antimeridiano
function fbm(u, v, octaves) {
  let sum = 0, amp = 0.5, norm = 0, f = 24;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(u * f, v * f * 0.5 + o * 17.3, f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function vegColor(alat, out) {
  const s = SAT_VEG;
  for (let k = 1; k < s.length; k++) {
    if (alat <= s[k][0]) {
      const t = Math.max(0, (alat - s[k - 1][0]) / (s[k][0] - s[k - 1][0]));
      for (let c = 0; c < 3; c++) out[c] = s[k - 1][c + 1] + (s[k][c + 1] - s[k - 1][c + 1]) * t;
      return;
    }
  }
  const last = s[s.length - 1];
  out[0] = last[1]; out[1] = last[2]; out[2] = last[3];
}

function nearLand(mx, my) {
  for (let dy = -1; dy <= 1; dy++) {
    const yy = my + dy;
    if (yy < 0 || yy >= MH) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = (mx + dx + MW) % MW;
      if (landData[(yy * MW + xx) * 4] > 128) return true;
    }
  }
  return false;
}

function buildOceanTexture() {
  satOceanCanvas.width = SAT_W;
  satOceanCanvas.height = SAT_H;
  const oc = satOceanCanvas.getContext('2d');

  // azul profundo, um pouco mais escuro e acinzentado nas altas latitudes
  const g = oc.createLinearGradient(0, 0, 0, SAT_H);
  g.addColorStop(0, '#0a2140');
  g.addColorStop(0.3, '#0d3161');
  g.addColorStop(0.5, '#0f3a70');
  g.addColorStop(0.7, '#0d3161');
  g.addColorStop(1, '#081c38');
  oc.fillStyle = g;
  oc.fillRect(0, 0, SAT_W, SAT_H);

  // variação suave de tom (correntes/fitoplâncton vistos do espaço), em baixa resolução
  const nw = 512, nh = 256;
  const nc = document.createElement('canvas');
  nc.width = nw; nc.height = nh;
  const nctx = nc.getContext('2d');
  const nimg = nctx.createImageData(nw, nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const n = fbm(x / nw, y / nh + 3.1, 3);
      const o = (y * nw + x) * 4;
      nimg.data[o] = 0; nimg.data[o + 1] = 10; nimg.data[o + 2] = 30;
      nimg.data[o + 3] = Math.round(Math.max(0, n - 0.35) * 150);
    }
  }
  nctx.putImageData(nimg, 0, 0);
  oc.imageSmoothingEnabled = true;
  oc.drawImage(nc, 0, 0, SAT_W, SAT_H);

  // plataforma continental: halos claros em volta da costa (água rasa) -> gradiente de profundidade
  const sp = d3.geoEquirectangular().translate([SAT_W / 2, SAT_H / 2]).scale(SAT_W / (2 * Math.PI));
  const spath = d3.geoPath(sp, oc);
  if (typeof oc.filter === 'string') {
    const layers = [
      ['blur(16px)', 'rgba(30,96,150,0.55)'],
      ['blur(6px)', 'rgba(52,138,180,0.55)'],
      ['blur(1.8px)', 'rgba(90,176,200,0.5)'],
    ];
    for (const [f, c] of layers) {
      oc.filter = f;
      oc.fillStyle = c;
      oc.beginPath();
      spath(land);
      oc.fill();
    }
    oc.filter = 'none';
  } else {
    oc.lineJoin = 'round';
    for (const [w, c] of [[12, 'rgba(30,96,150,0.3)'], [6, 'rgba(52,138,180,0.35)'], [2, 'rgba(90,176,200,0.4)']]) {
      oc.lineWidth = w;
      oc.strokeStyle = c;
      oc.beginPath();
      spath(land);
      oc.stroke();
    }
  }
}

function buildLandTexture() {
  satLandCanvas.width = SAT_W;
  satLandCanvas.height = SAT_H;
  const lc = satLandCanvas.getContext('2d');
  const img = lc.createImageData(SAT_W, SAT_H);
  const px = img.data;
  const hgt = new Float32Array(SAT_W * SAT_H);
  const need = new Uint8Array(SAT_W * SAT_H);

  // campos de aridez/montanha numa grade grossa de 0,5° (interpolados depois), com
  // "domain warping": cada ponto consulta as elipses num lugar deslocado por ruído,
  // o que deixa os contornos dos desertos e cordilheiras orgânicos em vez de ovais.
  const CW = 720, CH = 360;
  const ARID = new Float32Array(CW * CH), MNT = new Float32Array(CW * CH);
  for (let cy = 0; cy < CH; cy++) {
    const lat = 90 - (cy + 0.5) * 0.5;
    const v = (cy + 0.5) / CH;
    for (let cx = 0; cx < CW; cx++) {
      const lon = -180 + (cx + 0.5) * 0.5;
      const u = (cx + 0.5) / CW;
      const wx = (fbm(u, v + 5.3, 4) - 0.5) * 26;
      const wy = (fbm(u, v + 11.1, 4) - 0.5) * 14;
      const patch = 0.55 + 0.9 * fbm(u, v + 23.7, 3); // falhas/manchas internas
      ARID[cy * CW + cx] = Math.min(1, blobField(SAT_DESERTS, lon + wx, lat + wy) * patch);
      MNT[cy * CW + cx] = blobField(SAT_MOUNTAINS, lon + wx * 0.35, lat + wy * 0.35);
    }
  }
  const coarse = (arr, x, y) => {
    let fx = (x + 0.5) / SAT_W * CW - 0.5, fy = (y + 0.5) / SAT_H * CH - 0.5;
    if (fy < 0) fy = 0; else if (fy > CH - 1) fy = CH - 1;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const xa = (x0 + CW) % CW, xb = (x0 + 1) % CW, yb = Math.min(CH - 1, y0 + 1);
    const a = arr[y0 * CW + xa], b = arr[y0 * CW + xb], c = arr[yb * CW + xa], d = arr[yb * CW + xb];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };

  // passo 1: só pixels de terra (+ margem); acima de 84° a Antártida/Groenlândia já vêm pintadas
  for (let y = 0; y < SAT_H; y++) {
    const lat = 90 - (y + 0.5) / SAT_H * 180;
    if (Math.abs(lat) > 84) continue;
    const my = Math.min(MH - 1, (y * MH / SAT_H) | 0);
    const v = (y + 0.5) / SAT_H;
    for (let x = 0; x < SAT_W; x++) {
      if (!nearLand((x * MW / SAT_W) | 0, my)) continue;
      const i = y * SAT_W + x;
      need[i] = 1;
      hgt[i] = fbm((x + 0.5) / SAT_W, v, 6);
    }
  }

  // passo 2: cor do bioma + deserto + rocha/neve de montanha + relevo sombreado (luz de NO)
  const veg = [0, 0, 0];
  for (let y = 0; y < SAT_H; y++) {
    const lat = 90 - (y + 0.5) / SAT_H * 180;
    const alat = Math.abs(lat);
    vegColor(alat, veg);
    for (let x = 0; x < SAT_W; x++) {
      const i = y * SAT_W + x;
      if (!need[i]) continue;
      const h = hgt[i];
      const A0 = coarse(ARID, x, y), M = coarse(MNT, x, y);
      let r = veg[0], g = veg[1], b = veg[2];

      // aridez em degradê natural: verde -> estepe -> areia, com bordas irregulares pelo ruído
      if (A0 > 0) {
        const steppeW = smoothstep(0, 0.5, A0 + (h - 0.5) * 0.9) * 0.8;
        r += (150 - r) * steppeW; g += (136 - g) * steppeW; b += (86 - b) * steppeW;
        const sandW = smoothstep(0.38, 0.85, A0 + (h - 0.5) * 1.3);
        const sandT = smoothstep(0.3, 0.7, h); // areia clara x avermelhada
        r += ((224 + (198 - 224) * sandT) - r) * sandW;
        g += ((190 + (142 - 190) * sandT) - g) * sandW;
        b += ((132 + (84 - 132) * sandT) - b) * sandW;
      }

      const rockW = M * smoothstep(0.35, 0.75, h) * 0.85;
      r += (124 - r) * rockW; g += (108 - g) * rockW; b += (90 - b) * rockW;
      const peakW = M * smoothstep(0.58, 0.76, h) * (M > 0.5 ? 1 : 0.4) * (alat > 40 ? 1.25 : 1);
      // calotas polares: linha de neve irregular (ruído) em vez de uma faixa reta de latitude
      const polarW = alat > 50 ? smoothstep(60, 71, alat + (h - 0.5) * 18) : 0;
      const snowW = Math.min(1, Math.max(peakW, polarW));
      r += (234 - r) * snowW; g += (239 - g) * snowW; b += (243 - b) * snowW;

      const xl = x > 0 ? i - 1 : i + SAT_W - 1;
      const xr = x < SAT_W - 1 ? i + 1 : i - SAT_W + 1;
      const up = y > 0 ? i - SAT_W : i, dn = y < SAT_H - 1 ? i + SAT_W : i;
      const hl = need[xl] ? hgt[xl] : h, hr = need[xr] ? hgt[xr] : h;
      const hu = need[up] ? hgt[up] : h, hd = need[dn] ? hgt[dn] : h;
      let shade = 1 + ((hl + hu) - (hr + hd)) * (5 + 16 * M);
      if (shade < 0.62) shade = 0.62; else if (shade > 1.38) shade = 1.38;
      const k = shade * (0.8 + 0.4 * h) * (0.95 + 0.1 * hash2(x, y));

      const o = i * 4;
      px[o] = Math.min(255, r * k);
      px[o + 1] = Math.min(255, g * k);
      px[o + 2] = Math.min(255, b * k);
      px[o + 3] = 255;
    }
  }
  lc.putImageData(img, 0, 0);
}

function buildSatelliteTextures() {
  if (!land || !landData) return;
  buildOceanTexture();
  buildLandTexture();
  satReady = true;
}

/* ---------- campo de correntes ---------- */
function prepCurrents() {
  for (const c of CURRENTS) {
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
      return [0, 0];
    return [sampleGrid(OD.U, OD.c, lon, lat), sampleGrid(OD.V, OD.c, lon, lat)];
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

function currentAt(lon, lat, ph) {
  const f = sampleField(lon, lat);
  const tb = streamTurb(lon, lat, ph);
  const g = 0.22 + 0.85 * Math.min(sampleSPD(lon, lat) / 2.4, 1);
  return [f[0] + tb[0] * g, f[1] + tb[1] * g];
}

/* ---------- grade de temperatura ---------- */
function buildTempGrid() {
  if (OD && OD.T) {
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
    const c = CURRENTS[(Math.random() * CURRENTS.length) | 0];
    const k = (Math.random() * (c.pts.length - 1)) | 0;
    const tt = Math.random();
    let lon = c.pts[k][0] + (c.pts[k + 1][0] - c.pts[k][0]) * tt + (Math.random() - 0.5) * 2 * c.width;
    let lat = c.pts[k][1] + (c.pts[k + 1][1] - c.pts[k][1]) * tt + (Math.random() - 0.5) * 2 * c.width;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    p.lon = lon;
    p.lat = lat > 84 ? 84 : lat < -84 ? -84 : lat;
  } else {
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

const SEGS = [[], [], [], [], [], [], [], [], []];
// quentes / amenas / frias — tons claros pra ler bem sobre o oceano azul-escuro do satélite
const TEMPCOL = ['255,138,76', '255,222,128', '130,210,255'];
const DARKFLOW = '10,26,54';
const S_ALPHA = [0.32, 0.62, 0.98];
const S_WIDTH = [0.8, 1.5, 2.5];
const FLOW_CORE = 'rgba(255,252,244,0.55)';

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
  const gamma = OD ? 1.0 : 1.12;
  const calm = OD ? 0.03 : 0.05;
  const sFast = OD ? 0.85 : 1.7, sMid = OD ? 0.28 : 0.7;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];

    const f = sampleField(p.lon, p.lat);
    const inReg = !ODB || (p.lon >= ODB.lon0 && p.lon <= ODB.lon1 &&
                           p.lat >= ODB.lat0 && p.lat <= ODB.lat1);
    const tb = inReg ? streamTurb(p.lon, p.lat, phase) : [0, 0];
    const ls = Math.hypot(f[0], f[1]);
    const g = OD ? (0.05 + 0.12 * Math.max(0, 1 - ls / 0.4))
                 : (0.30 + 0.8 * Math.min(ls / 2.2, 1));
    const u = f[0] + tb[0] * g;
    const v = f[1] + tb[1] * g;
    const sp = Math.hypot(u, v);

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
    const tcls = t > 0.55 ? 0 : (t < 0.37 ? 2 : 1);
    const scls = sp > sFast ? 2 : (sp > sMid ? 1 : 0);
    SEGS[scls * 3 + tcls].push(a[0], a[1], b[0], b[1]);

    p.lon = nlon; p.lat = nlat;
  }

  fctx.lineCap = 'round';
  fctx.lineJoin = 'round';
  for (let sc = 0; sc < 3; sc++) {
    fctx.lineWidth = S_WIDTH[sc];
    for (let tc = 0; tc < 3; tc++) {
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
    if (sc === 2) {
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
  bctx.fillStyle = MAP.ocean;
  bctx.fillRect(0, 0, W, H);

  const wx = originX, wy = originY, ww = 360 * scaleK, wh = 180 * scaleK;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';

  if (showSST && sstReady) {
    bctx.drawImage(sstCanvas, 0, 0, TW, TH, wx, wy, ww, wh);
  } else if (satReady) {
    bctx.drawImage(satOceanCanvas, wx, wy, ww, wh);
    if (MAP.oceanDim) { bctx.fillStyle = MAP.oceanDim; bctx.fillRect(0, 0, W, H); }
  }

  if (land) {
    bctx.save();
    bctx.beginPath();
    geoPath(land);
    bctx.fillStyle = MAP.land; // base lisa: cobre ilhas pequenas demais pra máscara da textura
    bctx.fill();
    if (satReady) {
      bctx.clip();
      bctx.drawImage(satLandCanvas, wx, wy, ww, wh);
      if (MAP.landDim) { bctx.fillStyle = MAP.landDim; bctx.fillRect(0, 0, W, H); }
    }
    bctx.restore();
    // o path atual não faz parte do estado salvo — o contorno reaproveita o mesmo traçado
    bctx.strokeStyle = MAP.landLine;
    bctx.lineWidth = 0.6;
    bctx.stroke();
  }

  drawPolarIce();
  drawCountryBorders();

  if (showGrat) {
    bctx.beginPath();
    geoPath(graticule);
    bctx.strokeStyle = MAP.grat;
    bctx.lineWidth = 0.6;
    bctx.stroke();
  }

  if (!panning) {
    labelRects = [];
    drawCountryLabels();
    if (showNavRoutes) drawNavRoutes();
    drawOceanLabels();
  }

  if (showPorts) drawPorts();
  else portScreenPos = [];

  drawOilSpill();
  drawFishHeatmap();
}

/* ---------- camada de simulação: mancha de vazamento de óleo (Copiloto IA) ---------- */
function traceLL(pts) {
  bctx.beginPath();
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const s = project(normLon(pts[i][0]), pts[i][1]);
    if (!prev || Math.abs(s[0] - prev[0]) > 180 * scaleK) bctx.moveTo(s[0], s[1]); // quebra no antimeridiano
    else bctx.lineTo(s[0], s[1]);
    prev = s;
  }
}

function spillEllipse(f) {
  const s = project(normLon(f.lon), f.lat);
  const ry = Math.max(2, (f.radius_km / 111) * scaleK);
  const rx = ry / Math.max(0.2, Math.cos(f.lat * Math.PI / 180)); // km -> graus de longitude
  return [s[0], s[1], rx, ry];
}

function drawAlertMarker(x, y) {
  const s = 9;
  bctx.save();
  bctx.beginPath();
  bctx.moveTo(x, y - s);
  bctx.lineTo(x + s * 0.95, y + s * 0.7);
  bctx.lineTo(x - s * 0.95, y + s * 0.7);
  bctx.closePath();
  bctx.shadowColor = 'rgba(255,40,20,0.9)';
  bctx.shadowBlur = 10;
  bctx.fillStyle = '#ff3b30';
  bctx.fill();
  bctx.restore();
  bctx.lineJoin = 'round';
  bctx.lineWidth = 1.4;
  bctx.strokeStyle = '#fff';
  bctx.stroke();
  bctx.fillStyle = '#fff';
  bctx.font = '800 10px "Inter","Segoe UI",sans-serif';
  bctx.textAlign = 'center';
  bctx.textBaseline = 'middle';
  bctx.fillText('!', x, y + 1.5);
}

function drawShipMarker(x, y, angle, aground) {
  bctx.save();
  bctx.translate(x, y);
  bctx.rotate(angle);
  bctx.beginPath(); // casco com a proa apontando no sentido da deriva
  bctx.moveTo(10, 0);
  bctx.quadraticCurveTo(3, -5.5, -7, -4.5);
  bctx.lineTo(-7, 4.5);
  bctx.quadraticCurveTo(3, 5.5, 10, 0);
  bctx.closePath();
  bctx.shadowColor = 'rgba(0,0,0,0.65)';
  bctx.shadowBlur = 6;
  bctx.fillStyle = aground ? '#ff9f1a' : '#ffd23f';
  bctx.fill();
  bctx.shadowBlur = 0;
  bctx.lineWidth = 1.2;
  bctx.strokeStyle = '#3a2a00';
  bctx.stroke();
  bctx.fillStyle = '#3a2a00';
  bctx.fillRect(-4.5, -2, 5, 4); // ponte de comando
  bctx.restore();
}

function drawMapTag(text, x, y, color, align) {
  bctx.font = '700 10.5px "Inter","Segoe UI",sans-serif';
  bctx.textAlign = align || 'left';
  bctx.textBaseline = 'middle';
  bctx.lineJoin = 'round';
  bctx.lineWidth = 3.2;
  bctx.strokeStyle = 'rgba(0,0,0,0.7)';
  bctx.strokeText(text, x, y);
  bctx.fillStyle = color;
  bctx.fillText(text, x, y);
}

function drawOilSpill() {
  if (!oilSpill || !oilSpill.frames || !oilSpill.frames.length) return;
  const frames = oilSpill.frames;
  const n = frames.length;
  const origin = [normLon(oilSpill.origin.lon), oilSpill.origin.lat];

  // rota do navio em que ocorreu o incidente (contexto)
  if (oilSpill.shipRoute && oilSpill.shipRoute.length > 1) {
    traceLL(oilSpill.shipRoute);
    bctx.setLineDash([3, 5]);
    bctx.lineCap = 'round';
    bctx.strokeStyle = 'rgba(255,255,255,0.8)';
    bctx.lineWidth = 1.6;
    bctx.stroke();
    bctx.setLineDash([]);
  }

  // mancha: união de todas as posições hora a hora num único preenchimento (sem acumular opacidade)
  bctx.beginPath();
  for (let i = 0; i < n; i++) {
    const e = spillEllipse(frames[i]);
    bctx.moveTo(e[0] + e[2], e[1]);
    bctx.ellipse(e[0], e[1], e[2], e[3], 0, 0, Math.PI * 2);
  }
  bctx.fillStyle = 'rgba(214,28,28,0.26)';
  bctx.fill();

  // mancha atual (mais densa no centro), expandida conforme o tempo informado
  const eL = spillEllipse(frames[n - 1]);
  const grad = bctx.createRadialGradient(eL[0], eL[1], 0, eL[0], eL[1], Math.max(eL[2], eL[3]));
  grad.addColorStop(0, 'rgba(90,0,0,0.6)');
  grad.addColorStop(0.6, 'rgba(170,10,10,0.38)');
  grad.addColorStop(1, 'rgba(230,40,30,0.14)');
  bctx.beginPath();
  bctx.ellipse(eL[0], eL[1], eL[2], eL[3], 0, 0, Math.PI * 2);
  bctx.fillStyle = grad;
  bctx.fill();
  bctx.strokeStyle = 'rgba(255,95,70,0.9)';
  bctx.lineWidth = 1.2;
  bctx.stroke();

  // trajeto pontilhado da deriva: origem -> posição a cada hora
  traceLL([origin].concat(frames.map((f) => [f.lon, f.lat])));
  bctx.setLineDash([2.5, 4]);
  bctx.lineJoin = 'round';
  bctx.lineCap = 'round';
  bctx.strokeStyle = 'rgba(255,120,40,0.95)';
  bctx.lineWidth = 2;
  bctx.stroke();
  bctx.setLineDash([]);

  // origem da avaria + navio na posição atual (orientado pelo último trecho de deriva)
  const sO = project(origin[0], origin[1]);
  const last = frames[n - 1];
  const sL = project(normLon(last.lon), last.lat);
  const ref = n > 1 ? frames[Math.max(0, n - 4)] : { lon: origin[0], lat: origin[1] };
  const sR = project(normLon(ref.lon), ref.lat);
  const moved = Math.hypot(sL[0] - sR[0], sL[1] - sR[1]) > 0.5;
  const angle = moved ? Math.atan2(sL[1] - sR[1], sL[0] - sR[0]) : -Math.PI / 2;

  drawAlertMarker(sO[0], sO[1]);
  drawShipMarker(sL[0], sL[1], angle, !!oilSpill.aground);
  if (!panning) {
    // rótulos em lados opostos, conforme a direção da deriva, pra não se sobreporem
    const right = sL[0] >= sO[0];
    drawMapTag('Avaria', sO[0] + (right ? -12 : 12), sO[1] - 10, '#ffb3a8', right ? 'right' : 'left');
    drawMapTag('Navio · T+' + (oilSpill.drift_hours || last.hour) + ' h',
      sL[0] + (right ? 13 : -13), sL[1] + 11, '#ffe38a', right ? 'left' : 'right');
  }
}

/* ---------- camada de simulação: heatmap de cardumes (Copiloto IA) ---------- */
function drawFishHeatmap() {
  if (!fishHotspots || !fishHotspots.hotspots || !fishHotspots.hotspots.length) return;
  for (const h of fishHotspots.hotspots) {
    const s = project(h.lon, h.lat);
    const r = 16 + h.score * 30;
    const g = bctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], r);
    g.addColorStop(0, 'rgba(90,255,195,' + (0.55 * h.score + 0.15).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(90,255,195,0)');
    bctx.fillStyle = g;
    bctx.beginPath();
    bctx.arc(s[0], s[1], r, 0, Math.PI * 2);
    bctx.fill();
  }
}

/* ---------- hover explicativo sobre as camadas de simulação (cardumes / vazamento e deriva) ---------- */
function findFishHotspotAt(px, py) {
  if (!fishHotspots || !fishHotspots.hotspots) return null;
  for (const h of fishHotspots.hotspots) {
    const s = project(h.lon, h.lat);
    const r = 16 + h.score * 30;
    if (Math.hypot(px - s[0], py - s[1]) <= r) return h;
  }
  return null;
}

function findOilHoverAt(px, py) {
  if (!oilSpill || !oilSpill.frames || !oilSpill.frames.length) return null;
  const frames = oilSpill.frames;
  let prev = project(oilSpill.origin.lon, oilSpill.origin.lat);
  for (let i = 0; i < frames.length; i++) {
    const cur = project(frames[i].lon, frames[i].lat);
    if (Math.abs(cur[0] - prev[0]) <= W * 0.5 && distToSegment(px, py, prev[0], prev[1], cur[0], cur[1]) <= 7) {
      return oilSpill;
    }
    const rPx = Math.max(2, (frames[i].radius_km / 111) * scaleK);
    if (Math.hypot(px - cur[0], py - cur[1]) <= rPx) return oilSpill;
    prev = cur;
  }
  return null;
}

function showSimTooltip(mx, my, kind, title, body) {
  const el = document.getElementById('sim-tooltip');
  if (!el) return;
  el.classList.toggle('is-fish', kind === 'fish');
  el.classList.toggle('is-oil', kind === 'oil');
  document.getElementById('sim-tt-title').textContent = title;
  document.getElementById('sim-tt-body').textContent = body;
  el.style.left = mx + 'px';
  el.style.top = my + 'px';
  el.hidden = false;
}

function hideSimTooltip() {
  const el = document.getElementById('sim-tooltip');
  if (el) el.hidden = true;
}

/* ---------- fronteiras dos países ----------
   desenhadas UMA vez numa textura fixa (buildBordersTexture); a cada frame
   é só um drawImage esticado pro zoom/pan atual — sem retraçar geometria. */
function bboxVisible(b, vb) {
  if (!b) return true;
  const lon0 = b[0][0], lat0 = b[0][1], lon1 = b[1][0], lat1 = b[1][1];
  if (lon1 - lon0 > 180) return true; // provavelmente cruza o antimeridiano
  return lon1 >= vb.lon0 && lon0 <= vb.lon1 && lat1 >= vb.lat0 && lat0 <= vb.lat1;
}

function buildBordersTexture() {
  if (!countries) return;
  bordersCanvas.width = BW;
  bordersCanvas.height = BH;
  const proj2 = d3.geoEquirectangular().translate([BW / 2, BH / 2]).scale(BW / (2 * Math.PI));
  const path2 = d3.geoPath(proj2, brctx);
  brctx.clearRect(0, 0, BW, BH);
  brctx.beginPath();
  path2(countries);
  brctx.setLineDash([6, 4]);
  brctx.strokeStyle = MAP.border;
  brctx.lineWidth = 1.6;
  brctx.stroke();
  bordersReady = true;
}

/* ---------- gelo/neve polar (>60°N, <60°S, Groenlândia e Antártida) ---------- */
function drawPolarIce() {
  if (!land) return;
  if (satReady) { // a textura de satélite já traz a linha de neve irregular — só os mantos de gelo
    drawIceSheets(0.9);
    return;
  }

  bctx.save();
  bctx.beginPath();
  geoPath(land);
  bctx.clip();

  const yHardN = project(0, POLAR_HARD_LAT)[1];
  const ySoftN = project(0, POLAR_SOFT_LAT)[1];
  const yHardS = project(0, -POLAR_HARD_LAT)[1];
  const ySoftS = project(0, -POLAR_SOFT_LAT)[1];

  // calota norte: degradê ice -> iceShade até 65°N, depois iceShade -> transparente até 55°N
  let g = bctx.createLinearGradient(0, 0, 0, Math.max(1, yHardN));
  g.addColorStop(0, MAP.ice);
  g.addColorStop(1, MAP.iceShade);
  bctx.fillStyle = g;
  bctx.fillRect(0, 0, W, Math.max(0, yHardN));
  g = bctx.createLinearGradient(0, yHardN, 0, ySoftN);
  g.addColorStop(0, MAP.iceShade);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  bctx.fillStyle = g;
  bctx.fillRect(0, yHardN, W, Math.max(0, ySoftN - yHardN));

  // calota sul: degradê ice -> iceShade abaixo de 65°S, depois iceShade -> transparente até 55°S
  g = bctx.createLinearGradient(0, H, 0, Math.min(H - 1, yHardS));
  g.addColorStop(0, MAP.ice);
  g.addColorStop(1, MAP.iceShade);
  bctx.fillStyle = g;
  bctx.fillRect(0, yHardS, W, Math.max(0, H - yHardS));
  g = bctx.createLinearGradient(0, yHardS, 0, ySoftS);
  g.addColorStop(0, MAP.iceShade);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  bctx.fillStyle = g;
  bctx.fillRect(0, ySoftS, W, Math.max(0, yHardS - ySoftS));

  bctx.restore();
  drawIceSheets(1);
}

// Groenlândia e Antártida: gelo por inteiro, mesmo na parte que escapa da faixa de latitude
function drawIceSheets(alpha) {
  if (!polarTerritories || !polarTerritories.features.length) return;
  bctx.beginPath();
  geoPath(polarTerritories);
  bctx.globalAlpha = alpha;
  bctx.fillStyle = MAP.ice;
  bctx.fill();
  bctx.globalAlpha = 1;
  bctx.strokeStyle = MAP.iceLine;
  bctx.lineWidth = 0.7;
  bctx.stroke();
}

function drawCountryBorders() {
  if (!bordersReady) return;
  if (Z >= 2.5 && countries) { // aproximado: a textura esticada fica borrada — traça em vetor
    bctx.beginPath();
    geoPath(countries);
    bctx.setLineDash([5, 4]);
    bctx.strokeStyle = MAP.border;
    bctx.lineWidth = 0.9;
    bctx.stroke();
    bctx.setLineDash([]);
    return;
  }
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(bordersCanvas, 0, 0, BW, BH, originX, originY, 360 * scaleK, 180 * scaleK);
}

const MAX_LABEL_RANK = 2; // só os países principais — lista travada, não recalcula ao dar zoom
const LABEL_FONT_SIZE = 12;

function drawCountryLabels() {
  if (!majorCountries.length) return;
  const vb = viewBounds();

  bctx.textAlign = 'center';
  bctx.textBaseline = 'middle';
  bctx.lineJoin = 'round';
  bctx.font = '600 ' + LABEL_FONT_SIZE + 'px "Inter","Segoe UI",sans-serif';

  const pad = 3;
  for (let i = 0; i < majorCountries.length; i++) {
    const f = majorCountries[i];
    if (!bboxVisible(f.__b, vb)) continue;
    const p = f.properties;
    const s = project(p.x, p.y);
    if (s[0] < -20 || s[0] > W + 20 || s[1] < -10 || s[1] > H + 10) continue;

    const tw = bctx.measureText(p.n).width;
    const bx0 = s[0] - tw / 2 - pad, bx1 = s[0] + tw / 2 + pad;
    const by0 = s[1] - LABEL_FONT_SIZE / 2 - pad, by1 = s[1] + LABEL_FONT_SIZE / 2 + pad;

    let overlap = false;
    for (let k = 0; k < labelRects.length; k++) {
      const b = labelRects[k];
      if (bx0 < b[2] && bx1 > b[0] && by0 < b[3] && by1 > b[1]) { overlap = true; break; }
    }
    if (overlap) continue;
    labelRects.push([bx0, by0, bx1, by1]);

    bctx.lineWidth = 3;
    bctx.strokeStyle = MAP.labelHalo;
    bctx.strokeText(p.n, s[0], s[1]);
    bctx.fillStyle = MAP.label;
    bctx.fillText(p.n, s[0], s[1]);
  }
}

/* ---------- rotas de navegação (comerciais e estratégicas) ---------- */
function drawNavRoutes() {
  const vb = viewBounds();
  bctx.setLineDash([6, 4]);
  bctx.strokeStyle = MAP.navRoute;
  bctx.lineWidth = 1;
  bctx.lineCap = 'round';
  bctx.lineJoin = 'round';

  const visible = [];
  for (let i = 0; i < NAV_ROUTES.length; i++) {
    const r = NAV_ROUTES[i];
    if (!r.pts || !bboxVisible(r.__b, vb)) continue;
    visible.push(r);
    bctx.beginPath();
    let prev = null;
    for (let k = 0; k < r.pts.length; k++) {
      const s = project(r.pts[k][0], r.pts[k][1]);
      if (k === 0 || (prev && Math.abs(s[0] - prev[0]) > W * 0.5)) bctx.moveTo(s[0], s[1]);
      else bctx.lineTo(s[0], s[1]);
      prev = s;
    }
    bctx.stroke();
  }
  bctx.setLineDash([]);

  bctx.fillStyle = MAP.navRoute;
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i];
    const ends = [r.pts[0], r.pts[r.pts.length - 1]];
    for (let e = 0; e < ends.length; e++) {
      const s = project(ends[e][0], ends[e][1]);
      if (s[0] < -6 || s[0] > W + 6 || s[1] < -6 || s[1] > H + 6) continue;
      bctx.beginPath();
      bctx.arc(s[0], s[1], 2.2, 0, Math.PI * 2);
      bctx.fill();
      bctx.strokeStyle = 'rgba(255,255,255,0.9)';
      bctx.lineWidth = 1;
      bctx.stroke();
    }
  }

  bctx.textAlign = 'center';
  bctx.textBaseline = 'middle';
  bctx.font = 'italic 600 10px "Inter","Segoe UI",sans-serif';
  const pad = 3;
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i];
    const s = project(r.label[0], r.label[1]);
    if (s[0] < -20 || s[0] > W + 20 || s[1] < -10 || s[1] > H + 10) continue;

    const tw = bctx.measureText(r.name).width;
    const bx0 = s[0] - tw / 2 - pad, bx1 = s[0] + tw / 2 + pad;
    const by0 = s[1] - 8, by1 = s[1] + 8;
    let overlap = false;
    for (let k = 0; k < labelRects.length; k++) {
      const b = labelRects[k];
      if (bx0 < b[2] && bx1 > b[0] && by0 < b[3] && by1 > b[1]) { overlap = true; break; }
    }
    if (overlap) continue;
    labelRects.push([bx0, by0, bx1, by1]);

    bctx.lineWidth = 3;
    bctx.strokeStyle = MAP.labelHalo;
    bctx.strokeText(r.name, s[0], s[1]);
    bctx.fillStyle = MAP.navLabel;
    bctx.fillText(r.name, s[0], s[1]);
  }
}

/* ---------- nomes dos oceanos ---------- */
function drawOceanLabels() {
  bctx.textAlign = 'center';
  bctx.textBaseline = 'middle';
  bctx.font = 'italic 700 15px "Inter","Segoe UI",sans-serif';
  const pad = 4;
  for (let i = 0; i < OCEAN_LABELS.length; i++) {
    const o = OCEAN_LABELS[i];
    const s = project(o.lon, o.lat);
    if (s[0] < -40 || s[0] > W + 40 || s[1] < -20 || s[1] > H + 20) continue;

    const tw = bctx.measureText(o.name).width;
    const bx0 = s[0] - tw / 2 - pad, bx1 = s[0] + tw / 2 + pad;
    const by0 = s[1] - 10, by1 = s[1] + 10;
    let overlap = false;
    for (let k = 0; k < labelRects.length; k++) {
      const b = labelRects[k];
      if (bx0 < b[2] && bx1 > b[0] && by0 < b[3] && by1 > b[1]) { overlap = true; break; }
    }
    if (overlap) continue;
    labelRects.push([bx0, by0, bx1, by1]);

    bctx.lineWidth = 3;
    bctx.strokeStyle = MAP.oceanLabelHalo;
    bctx.strokeText(o.name, s[0], s[1]);
    bctx.fillStyle = MAP.oceanLabel;
    bctx.fillText(o.name, s[0], s[1]);
  }
}

/* ---------- portos de desembarque (marcadores, com LOD por zoom) ---------- */
const PORT_HIT_RADIUS = 9; // px — raio de detecção do hover/clique, maior que o desenho p/ facilitar o toque
function drawPorts() {
  portScreenPos = [];
  if (!PORTS.length) return;
  const vb = viewBounds();

  for (let i = 0; i < PORTS.length; i++) {
    const p = PORTS[i];
    const meta = portMeta(p);
    if (Z < meta.minZ) continue; // LOD: ainda não deu zoom suficiente pra este nível de porto
    if (p.lon < vb.lon0 || p.lon > vb.lon1 || p.lat < vb.lat0 || p.lat > vb.lat1) continue;
    const s = project(p.lon, p.lat);
    if (s[0] < -10 || s[0] > W + 10 || s[1] < -10 || s[1] > H + 10) continue;

    portScreenPos.push({ x: s[0], y: s[1], port: p });

    const isHub = p.size === 'Grande Hub';
    bctx.beginPath();
    bctx.arc(s[0], s[1], meta.r, 0, Math.PI * 2);
    bctx.fillStyle = MAP.port;
    bctx.shadowColor = MAP.portGlow;
    bctx.shadowBlur = meta.glow;
    bctx.fill();
    bctx.shadowBlur = 0;
    bctx.lineWidth = isHub ? 1.8 : 1.2;
    bctx.strokeStyle = MAP.portRing;
    bctx.stroke();

    if (isHub) { // halo extra — destaque "neon" pros grandes hubs
      bctx.beginPath();
      bctx.arc(s[0], s[1], meta.r + 3.5, 0, Math.PI * 2);
      bctx.strokeStyle = MAP.portGlow;
      bctx.lineWidth = 1.2;
      bctx.stroke();
    }

    bctx.beginPath();
    bctx.arc(s[0], s[1], 1.3, 0, Math.PI * 2);
    bctx.fillStyle = MAP.portRing;
    bctx.fill();
  }
}

function findPortAt(x, y) {
  let best = null, bestD = PORT_HIT_RADIUS * PORT_HIT_RADIUS;
  for (let i = 0; i < portScreenPos.length; i++) {
    const s = portScreenPos[i];
    const dx = s.x - x, dy = s.y - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = s.port; }
  }
  return best;
}

/* ---------- menu de busca origem/destino (seleção de rota restrita a portos) ---------- */
function populatePortSelectors() {
  const groups = ['Grande Hub', 'Porto Regional', 'Ancoradouro/Terminal'];
  const sorted = groups.map((g) => ({
    label: g,
    ports: PORTS.filter((p) => p.size === g).sort((a, b) => a.name.localeCompare(b.name)),
  }));

  for (const selId of ['r-origin', 'r-dest']) {
    const sel = document.getElementById(selId);
    if (!sel) continue;
    for (const g of sorted) {
      if (!g.ports.length) continue;
      const og = document.createElement('optgroup');
      og.label = g.label;
      for (const p of g.ports) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + ' — ' + p.country;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
  }
}

function routeFromSelectors() {
  const originId = document.getElementById('r-origin').value;
  const destId = document.getElementById('r-dest').value;
  if (!originId || !destId) return;
  const pa = PORT_BY_ID.get(originId), pb = PORT_BY_ID.get(destId);
  if (!pa || !pb) return;
  if (pa.id === pb.id) { routeInfoEl.textContent = 'Escolha portos de origem e destino diferentes.'; return; }

  if (emergencyMode) setEmergencyMode(false);
  routeMode = null;
  flowCanvas.classList.remove('picking');
  routeIsEmergency = false;
  routeA = [pa.lon, pa.lat]; routeAPort = pa;
  routeB = [pb.lon, pb.lat]; routeBPort = pb;
  computeRoute();
}

/* ---------- dimensionamento ---------- */
/* shiftX (opcional): quanto a borda esquerda do mapa andou na tela (painel ☰ abrindo/fechando).
   Com zoom aproximado o conteúdo fica parado na tela e só se revela/cobre a faixa lateral;
   na vista do mundo inteiro o mapa reescala pra continuar preenchendo 100% da largura. */
function resize(shiftX) {
  const hadView = scaleK > 0;
  const prevScale = scaleK, prevOX = originX, prevOY = originY;
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

  baseK = Math.max(W / 360, H / 180);
  if (!hadView) {
    scaleK = baseK; Z = 1;
    originX = (W - 360 * scaleK) / 2;
    originY = (H - 180 * scaleK) / 2;
  } else if (typeof shiftX === 'number' && prevScale >= baseK) {
    scaleK = prevScale;
    Z = scaleK / baseK;
    originX = prevOX + shiftX;
    originY = prevOY;
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

/* ---------- carregamento dos continentes ---------- */
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
    } catch (e) {}
  }
  return null;
}

async function loadCountries() {
  if (window.WORLD_COUNTRIES && window.WORLD_COUNTRIES.features) return window.WORLD_COUNTRIES;
  const urls = [
    'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson',
    'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson',
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { mode: 'cors' });
      if (!res.ok) continue;
      const raw = await res.json();
      raw.features.forEach((f) => {
        const p = f.properties;
        f.properties = {
          n: p.NAME || p.ADMIN || p.SOVEREIGNT || '',
          x: p.LABEL_X, y: p.LABEL_Y, r: p.LABELRANK || 6,
        };
      });
      return raw;
    } catch (e) {}
  }
  return null;
}

/* ============================================================
   ROTEAMENTO — melhor rota entre A e B aproveitando as correntes
   ============================================================ */
const R_EARTH = 6371;

function navLon(o) { return N_LON0 + o * NRES; }
function navLat(a) { return N_LAT0 - a * NRES; }
function navIdx(a, o) { return a * NLON + o; }

function buildNav() {
  if (OD && OD.regional && ODB) {
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

/* Custo de aresta do A* = tempo real: Tempo = Distância / |v⃗navio + v⃗corrente|.
   O navio aproa contra a componente transversal da corrente e avança a
   sqrt(v² − c⊥²) + c∥ sobre o fundo. kn = velocidade na água (padrão: a de serviço);
   cw = peso da corrente (0 = planejamento tradicional, que ignora o mar). */
function edgeHours(lo1, la1, lo2, la2, kn, cw) {
  if (kn == null) kn = SHIP.kn;
  if (cw == null) cw = 1;
  const latM = (la1 + la2) / 2;
  let dLon = ((lo2 - lo1 + 540) % 360) - 180;
  const dx = dLon * 111.32 * Math.cos(latM * Math.PI / 180);
  const dy = (la2 - la1) * 110.57;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  const ex = dx / len, ey = dy / len;

  const f = sampleField(lo1 + dLon / 2, latM);
  const S = (OD ? 3.6 : 2.0) * cw;
  const cu = f[0] * S;
  const cv = f[1] * S;
  const cPar = cu * ex + cv * ey;
  const cPerp2 = Math.max(0, cu * cu + cv * cv - cPar * cPar);

  const Vs = kn * KMH_PER_KN;
  const avail = Vs * Vs - cPerp2;
  if (avail <= 1) return Infinity;
  const ground = Math.sqrt(avail) + cPar;
  if (ground < 0.5) return Infinity;
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

function aStar(aS, oS, aG, oG, cw) {
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
        if (!NAV[ca * NLON + no] || !NAV[na * NLON + co]) continue;
      }
      const dt = edgeHours(clon, clat, navLon(no), navLat(na), SHIP.kn, cw);
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

/* ---------- comparação das 3 abordagens (espelho de compute_three_routes em ai_agent.py) ----------
   Calculada no navegador assim que a rota é traçada; quando o servidor Python responde,
   os números dele (e a análise redigida pelo LLM) substituem estes. */
const ETA_SLACK = 0.03;       // janela de atracação: até 3% após o A* (ou o ETA da rota comercial)
const MIN_SPEED_FRAC = 0.75;  // piso de slow steaming
const SPEED_STEP_KN = 0.25;

// tempo REAL de um trecho já traçado (a corrente age mesmo que o planejamento a ignore)
function segmentHours(lo1, la1, lo2, la2, kn) {
  const dt = edgeHours(lo1, la1, lo2, la2, kn, 1);
  return isFinite(dt) ? dt : havKm(lo1, la1, lo2, la2) / (0.25 * kn * KMH_PER_KN);
}

function pathHours(p, kn) {
  let t = 0;
  for (let i = 1; i < p.length; i++) t += segmentHours(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1], kn);
  return t;
}

/* Copiloto IA — gestão de potência: velocidade na água (potência) por trecho que minimiza
   o VLSFO sem estourar o ETA. Consumo/h ∝ v³, então reduzir o motor onde a corrente empurra
   custa pouco tempo e economiza muito. Relaxação lagrangiana: λ = preço da hora, por bisseção. */
function optimizePower(p, kn, etaBudget) {
  const vmin = Math.max(6, kn * MIN_SPEED_FRAC);
  const speeds = [];
  for (let v = kn; v >= vmin - 1e-9; v -= SPEED_STEP_KN) speeds.push(Math.round(v * 100) / 100);

  const segs = [], segKm = [];
  for (let i = 1; i < p.length; i++) {
    const [lo1, la1] = p[i - 1], [lo2, la2] = p[i];
    const opts = [];
    for (const v of speeds) {
      const t = edgeHours(lo1, la1, lo2, la2, v, 1);
      if (isFinite(t)) opts.push([v, t, fuelTonsPerHour(v) * t]);
    }
    if (!opts.length) {
      const t = segmentHours(lo1, la1, lo2, la2, kn);
      opts.push([kn, t, fuelTonsPerHour(kn) * t]);
    }
    segs.push(opts);
    segKm.push(havKm(lo1, la1, lo2, la2));
  }

  const solve = (lam) => {
    let T = 0;
    const pick = segs.map((o) => {
      let best = o[0], bc = o[0][2] + lam * o[0][1];
      for (let k = 1; k < o.length; k++) {
        const c = o[k][2] + lam * o[k][1];
        if (c < bc) { bc = c; best = o[k]; }
      }
      T += best[1];
      return best;
    });
    return [pick, T];
  };

  let [pick, T] = solve(0);
  if (T > etaBudget) {
    let lo = 0, hi = 1;
    while (solve(hi)[1] > etaBudget && hi < 1e6) hi *= 2;
    for (let it = 0; it < 45; it++) {
      const mid = (lo + hi) / 2;
      if (solve(mid)[1] > etaBudget) lo = mid; else hi = mid;
    }
    [pick, T] = solve(hi);
  }

  const fuel = pick.reduce((s, x) => s + x[2], 0);
  const km = segKm.reduce((s, x) => s + x, 0);
  const v = pick.map((x) => x[0]);
  let ecoKm = 0;
  v.forEach((sv, i) => { if (sv < kn - 0.01) ecoKm += segKm[i]; });
  return {
    km, hours: T, fuel_tons: fuel, co2_tons: fuel * CO2_PER_TON_FUEL,
    speeds: v,
    avg_kn: T > 0 ? pick.reduce((s, x) => s + x[0] * x[1], 0) / T : kn,
    min_kn: v.length ? Math.min(...v) : kn,
    max_kn: v.length ? Math.max(...v) : kn,
    load_pct: T > 0 ? 100 * fuel / (fuelTonsPerHour(kn) * T) : 100,
    eco_share: km > 0 ? ecoKm / km : 0,
    eta_budget_h: etaBudget,
    service_kn: kn,
  };
}

function localAnalysis(comm, astar, ai) {
  const dFuel = Math.max(0, comm.fuel_tons - ai.fuel_tons);
  const pct = comm.fuel_tons > 0 ? 100 * dFuel / comm.fuel_tons : 0;
  const eta = ai.hours - comm.hours;
  const etaTxt = eta < -0.05 ? 'chegando ' + nf1(-eta) + ' h antes da rota comercial'
    : eta > 0.05 ? 'com ETA ' + nf1(eta) + ' h após a rota comercial (dentro da janela de atracação)'
    : 'mantendo o mesmo ETA da rota comercial';
  return 'Análise técnica (cálculo local — servidor Python offline): o A* ganha ' +
    nf1(comm.hours - astar.hours) + ' h sobre a rota comercial explorando as correntes; o Copiloto ' +
    'converte esse ganho em economia, variando a velocidade entre ' + nf1(ai.min_kn) + ' e ' +
    nf1(ai.max_kn) + ' nós (média ' + nf1(ai.avg_kn) + ' nós, carga média ' + Math.round(ai.load_pct) +
    '% da potência de serviço) e reduzindo o motor em ' + Math.round(100 * ai.eco_share) +
    '% do trajeto. Resultado: −' + nf1(dFuel) + ' t de VLSFO (−' + Math.round(pct) + '%), −' +
    nf1(dFuel * CO2_PER_TON_FUEL) + ' t de CO₂ e US$ ' + Math.round(dFuel * FUEL_PRICE_USD).toLocaleString('pt-BR') +
    ' a menos, ' + etaTxt + '.';
}

// astarRes e commRes: saídas cruas do aStar (com e sem correntes) entre os mesmos nós
function buildRouteComparison(astarRes, commRes) {
  const kn = SHIP.kn, rate = fuelTonsPerHour(kn);
  const commHours = pathHours(commRes.path, kn);
  let a = astarRes;
  if (commHours < a.hours) a = { path: commRes.path, hours: commHours }; // A* nunca pior que a comercial
  const comm = { path: commRes.path, km: pathKm(commRes.path), hours: commHours, fuel_tons: rate * commHours, service_kn: kn };
  const astar = { path: a.path, km: pathKm(a.path), hours: a.hours, fuel_tons: rate * a.hours, service_kn: kn };
  const ai = Object.assign({ path: a.path }, optimizePower(a.path, kn, Math.max(commHours, a.hours * (1 + ETA_SLACK))));
  ai.rationale = localAnalysis(comm, astar, ai);
  return { baseline: comm, astar, llm: ai };
}

// suaviza os traçados só pra desenhar (o cálculo usa os nós crus do grafo)
function prepareVariants(v) {
  for (const k of ['baseline', 'astar', 'llm']) {
    if (v[k] && v[k].path && v[k].path.length > 1) v[k].drawPath = smoothPath(v[k].path);
  }
  return v;
}

function pathKm(p) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += havKm(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
  return s;
}

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

/* ---------- abre uma passagem artificial na grade náutica (canais) ---------- */
function openCorridor(lon, lat0, lat1, halfWidthDeg) {
  if (!NAV) return;
  const o = Math.round((lon - N_LON0) / NRES);
  const aFrom = Math.round((N_LAT0 - lat0) / NRES);
  const aTo = Math.round((N_LAT0 - lat1) / NRES);
  const aMin = Math.min(aFrom, aTo), aMax = Math.max(aFrom, aTo);
  const w = Math.max(1, Math.round(halfWidthDeg / NRES));
  for (let a = aMin; a <= aMax; a++) {
    if (a < 0 || a >= NLAT) continue;
    for (let oo = o - w; oo <= o + w; oo++) {
      if (oo < 0 || oo >= NLON) continue;
      NAV[navIdx(a, oo)] = 1;
    }
  }
}

/* ---------- calcula as rotas de navegação pelo mesmo A* náutico da rota manual ---------- */
function computeNavRoutes() {
  if (!NAV || (OD && OD.regional)) return;
  openCorridor(32.4, 29.9, 31.3, 1); // Canal de Suez
  openCorridor(-79.7, 8.9, 9.4, 1);  // Canal do Panamá

  for (const r of NAV_ROUTES) {
    const full = [];
    let ok = true;
    for (let i = 0; i < r.via.length - 1 && ok; i++) {
      const a = r.via[i], b = r.via[i + 1];
      const sA = navSnap(a[0], a[1]), sB = navSnap(b[0], b[1]);
      if (!sA || !sB) { ok = false; break; }
      const res = aStar(sA[0], sA[1], sB[0], sB[1]);
      if (!res || res.path.length < 2) { ok = false; break; }
      const seg = smoothPath(res.path);
      if (full.length) full.push.apply(full, seg.slice(1));
      else full.push.apply(full, seg);
    }
    if (!ok || full.length < 2) { r.pts = null; continue; }

    let lon0 = Infinity, lon1 = -Infinity, lat0 = Infinity, lat1 = -Infinity;
    for (const [lo, la] of full) {
      if (lo < lon0) lon0 = lo; if (lo > lon1) lon1 = lo;
      if (la < lat0) lat0 = la; if (la > lat1) lat1 = la;
    }
    r.pts = full;
    r.__b = [[lon0, lat0], [lon1, lat1]];
    r.label = full[(full.length / 2) | 0];
  }
}

function fmtKm(k) { return Math.round(k).toLocaleString('pt-BR') + ' km'; }
function fmtNm(km) { return Math.round(km * 0.539957).toLocaleString('pt-BR') + ' NM'; }
function fmtCoord(lat, lon) {
  const NS = lat >= 0 ? 'N' : 'S', EW = lon >= 0 ? 'E' : 'O';
  return Math.abs(lat).toFixed(2) + '°' + NS + ', ' + Math.abs(lon).toFixed(2) + '°' + EW;
}
function fmtDur(h) {
  if (!isFinite(h)) return '—';
  const d = Math.floor(h / 24), hh = Math.round(h - d * 24);
  return d > 0 ? d + ' d ' + hh + ' h' : hh + ' h';
}

/* ---------- Copiloto IA: busca as 3 rotas (Padrão / A* Python / LLM) no backend ---------- */
function routeVariantsKey(a, b) {
  return (a && b) ? a[0].toFixed(3) + ',' + a[1].toFixed(3) + '|' + b[0].toFixed(3) + ',' + b[1].toFixed(3) : null;
}

async function fetchRouteVariants(a, b) {
  if (location.protocol === 'file:') return; // precisa do servidor local (python servidor.py)
  const key = routeVariantsKey(a, b);
  if (!key) return;
  try {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a, b, speed_kn: SHIP.kn }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (routeVariantsKey(routeA, routeB) !== key) return; // rota mudou enquanto a resposta chegava
    if (!data.llm || data.llm.service_kn !== SHIP.kn) return; // velocidade mudou no meio do caminho
    routeVariants = prepareVariants(Object.assign({ key, source: 'server' }, data));
    drawRoute();
    const modal = document.getElementById('route-analytics');
    if (modal && !modal.hidden) openRouteAnalytics(); // atualiza a tabela com os números/análise do servidor
  } catch (e) { /* backend offline — mapa continua com a rota calculada no cliente */ }
}

function computeRoute() {
  if (!routeA || !routeB || !NAV) return;
  routeIsEmergency = false;
  routeVariants = null;
  routeInfoEl.textContent = 'calculando rota…';
  const s = navSnap(routeA[0], routeA[1]);
  const gg = navSnap(routeB[0], routeB[1]);
  if (!s || !gg) { routePath = null; routeInfoEl.textContent = 'ponto fora do oceano navegável.'; drawRoute(); return; }

  const res = aStar(s[0], s[1], gg[0], gg[1]);
  if (!res || res.path.length < 2) {
    routePath = null;
    routeInfoEl.textContent = 'não achei rota — os pontos estão separados por terra?';
    drawRoute();
    return;
  }

  routePath = smoothPath(res.path);
  const cmp = setClientComparison(s, gg, res);

  let txt = '';
  if (routeAPort && routeBPort) txt += routeAPort.name + ' → ' + routeBPort.name + '\n';
  if (cmp) {
    const c = cmp.baseline, a = cmp.astar, ai = cmp.llm;
    const pct = (x) => Math.round(100 * (c.fuel_tons - x) / c.fuel_tons);
    txt += '1. Rota comercial\n  ' + fmtKm(c.km) + '  ·  ' + fmtDur(c.hours) + '  ·  ' + nf1(c.fuel_tons) + ' t\n';
    txt += '2. A* (correntes)\n  ' + fmtKm(a.km) + '  ·  ' + fmtDur(a.hours) + '  ·  ' + nf1(a.fuel_tons) + ' t (−' + pct(a.fuel_tons) + '%)\n';
    txt += '3. Copiloto IA (potência)\n  ' + nf1(ai.min_kn) + '–' + nf1(ai.max_kn) + ' nós  ·  ' + fmtDur(ai.hours) +
           '  ·  ' + nf1(ai.fuel_tons) + ' t (−' + pct(ai.fuel_tons) + '%)';
  } else {
    txt += 'A* (correntes)\n  ' + fmtKm(pathKm(routePath)) + '  ·  ' + fmtDur(res.hours);
  }
  txt += '\n\nclique com o botão direito na linha da rota p/ análise detalhada';
  routeInfoEl.textContent = txt;
  drawRoute();
  fetchRouteVariants(routeA, routeB);
}

// rota comercial (A* sem correntes entre os mesmos nós) + perfil de potência, no cliente
function setClientComparison(s, gg, astarRes) {
  routeVariants = null;
  const comm = aStar(s[0], s[1], gg[0], gg[1], 0);
  if (!comm || comm.path.length < 2) return null;
  const cmp = buildRouteComparison(astarRes, comm);
  routeVariants = prepareVariants(Object.assign({ key: routeVariantsKey(routeA, routeB), source: 'client' }, cmp));
  return cmp;
}

function handleMapClick(px, py) {
  if (emergencyMode) { handleEmergencyClick(px, py); return; }
  if (!routeMode) return;

  /* modo normal: só aceita pontos válidos da lista de portos —
     nada de clicar no meio do oceano pra virar origem/destino */
  const port = findPortAt(px, py);
  if (!port) {
    routeInfoEl.textContent = (routeMode === 'A'
      ? 'Selecione o porto de origem'
      : 'Selecione o porto de destino') +
      ' clicando sobre um marcador no mapa, ou use os menus "Origem"/"Destino" abaixo.';
    return;
  }

  lastRouteClick = performance.now();
  routeIsEmergency = false;
  if (routeMode === 'A') {
    routeA = [port.lon, port.lat]; routeAPort = port;
    routeB = null; routeBPort = null; routePath = null;
    routeMode = 'B';
    routeInfoEl.textContent = 'Origem: ' + port.name + '. Agora clique no porto de destino.';
    drawRoute();
  } else {
    if (routeAPort && port.id === routeAPort.id) {
      routeInfoEl.textContent = 'Escolha um porto de destino diferente da origem.';
      return;
    }
    routeB = [port.lon, port.lat]; routeBPort = port;
    routeMode = null;
    flowCanvas.classList.remove('picking');
    computeRoute();
  }
}

/* ---------- Rota de Emergência: clique livre no oceano -> porto seguro mais próximo ---------- */
function findNearestPorts(lon, lat, limit) {
  const arr = PORTS.map((p) => ({ port: p, km: havKm(lon, lat, p.lon, p.lat) }));
  arr.sort((a, b) => a.km - b.km);
  return limit ? arr.slice(0, limit) : arr;
}

function setEmergencyMode(on) {
  emergencyMode = on;
  const btn = document.getElementById('r-emergency');
  const alertEl = document.getElementById('emg-alert');
  if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); }
  flowCanvas.classList.toggle('emergency', on);

  routeMode = null;
  routeA = routeB = routePath = null;
  routeAPort = routeBPort = null;
  routeIsEmergency = false;
  flowCanvas.classList.remove('picking');
  routeInfoEl.textContent = '';
  closeRouteAnalytics();
  drawRoute();

  if (!alertEl) return;
  if (on) {
    alertEl.hidden = false;
    alertEl.textContent = '🚨 Modo de emergência ativo — clique em qualquer ponto do oceano para marcar a posição do navio em perigo.';
  } else {
    alertEl.hidden = true;
  }
}

function handleEmergencyClick(px, py) {
  const ll = invert(px, py);
  if (ll[1] > 89 || ll[1] < -89) return;
  const lon = ((ll[0] + 180) % 360 + 360) % 360 - 180;
  const alertEl = document.getElementById('emg-alert');

  if (isLandLL(lon, ll[1])) {
    if (alertEl) alertEl.textContent = '🚨 Ponto em terra — clique dentro do oceano para marcar o navio em perigo.';
    return;
  }

  routeA = [lon, ll[1]]; routeAPort = null;
  routeB = null; routeBPort = null; routePath = null;
  routeIsEmergency = true;
  drawRoute();
  if (alertEl) alertEl.textContent = '🚨 Calculando o porto seguro mais próximo…';
  computeEmergencyRoute(lon, ll[1]);
}

function computeEmergencyRoute(lon, lat) {
  const alertEl = document.getElementById('emg-alert');
  routeVariants = null;
  const s = navSnap(lon, lat);
  if (!s || !NAV) {
    if (alertEl) alertEl.textContent = '🚨 Ponto fora do oceano navegável — tente clicar em uma área de água.';
    return;
  }

  const candidates = findNearestPorts(lon, lat, 6);
  for (let i = 0; i < candidates.length; i++) {
    const port = candidates[i].port;
    const gg = navSnap(port.lon, port.lat);
    if (!gg) continue;
    const res = aStar(s[0], s[1], gg[0], gg[1]);
    if (res && res.path.length > 1) {
      routePath = smoothPath(res.path);
      routeB = [port.lon, port.lat]; routeBPort = port;
      routeIsEmergency = true;
      const km = pathKm(routePath);
      const hOpt = res.hours;
      setClientComparison(s, gg, res); // só p/ a análise do botão direito — no mapa segue a linha vermelha
      if (alertEl) {
        alertEl.innerHTML =
          '🚨 <strong>Rota de emergência traçada</strong><br>' +
          'Porto seguro mais próximo: <strong>' + port.name + '</strong> (' + port.country + ')<br>' +
          'Distância: ' + fmtNm(km) + ' · ' + fmtKm(km) + '<br>' +
          'Tempo estimado: ' + fmtDur(hOpt) + ' a ' + SHIP.kn + ' nós<br>' +
          '<em>clique com o botão direito na linha da rota p/ análise detalhada</em>';
      }
      drawRoute();
      fetchRouteVariants(routeA, routeB);
      return;
    }
  }

  routePath = null;
  routeB = null; routeBPort = null;
  if (alertEl) alertEl.textContent = '🚨 Não foi possível traçar uma rota até um porto próximo a partir deste ponto.';
  drawRoute();
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

function drawRouteArrows(p, color) {
  rctx.fillStyle = color || MAP.route;
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

function drawEngineRoute(path, color, width, glow) {
  if (!path || path.length < 2) return;
  rctx.lineJoin = 'round';
  rctx.lineCap = 'round';
  rctx.strokeStyle = 'rgba(255,255,255,0.6)';
  rctx.lineWidth = width + 3;
  strokeRoute(path);
  if (glow) { rctx.shadowColor = color; rctx.shadowBlur = 12; }
  rctx.strokeStyle = color;
  rctx.lineWidth = width;
  strokeRoute(path);
  rctx.shadowBlur = 0;
}

function haveRouteVariants() {
  return !routeIsEmergency && routeVariants && routeVariants.key === routeVariantsKey(routeA, routeB);
}

// cor da potência do motor: verde-néon (motor reduzido ao piso) -> ciano-néon (potência de serviço)
function powerColor(v, vmin, vmax, alpha) {
  const t = vmax - vmin > 0.01 ? Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin))) : 1;
  return 'rgba(' + Math.round(140 - 80 * t) + ',255,' + Math.round(80 + 140 * t) + ',' + alpha.toFixed(2) + ')';
}

// Copiloto IA: mesmo caminho do A*, colorido trecho a trecho pela potência escolhida
function drawPowerRoute(ai, alpha, dashed) {
  const p = ai.drawPath || ai.path;
  if (!p || p.length < 2) return;
  const sp = ai.speeds || [];
  const kn = ai.service_kn || SHIP.kn, vmin = kn * MIN_SPEED_FRAC;
  const nDraw = p.length - 1, nSeg = Math.max(1, sp.length);
  const speedAt = (i) => (sp.length ? sp[Math.min(nSeg - 1, Math.floor(i * nSeg / nDraw))] : kn);

  rctx.lineJoin = 'round';
  rctx.lineCap = 'round';
  if (!dashed) {
    rctx.strokeStyle = 'rgba(255,255,255,0.6)';
    rctx.lineWidth = 6;
    strokeRoute(p);
  }
  rctx.setLineDash(dashed ? [10, 7] : []);
  rctx.lineWidth = 3;
  rctx.shadowBlur = 10;
  let i = 0;
  while (i < nDraw) { // agrupa trechos seguidos de mesma potência num só stroke
    const v = speedAt(i);
    let j = i + 1;
    while (j < nDraw && speedAt(j) === v) j++;
    rctx.beginPath();
    let prev = project(p[i][0], p[i][1]);
    rctx.moveTo(prev[0], prev[1]);
    for (let k = i + 1; k <= j; k++) {
      const s = project(p[k][0], p[k][1]);
      if (Math.abs(s[0] - prev[0]) > W * 0.5) rctx.moveTo(s[0], s[1]); else rctx.lineTo(s[0], s[1]);
      prev = s;
    }
    const col = powerColor(v, vmin, kn, alpha);
    rctx.strokeStyle = col;
    rctx.shadowColor = col;
    rctx.stroke();
    i = j;
  }
  rctx.shadowBlur = 0;
  rctx.setLineDash([]);
}

function drawRoute() {
  rctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  rctx.clearRect(0, 0, W, H);

  if (haveRouteVariants()) {
    const v = routeVariants;
    // 1. Rota comercial padrão — linha cinza tracejada (referência, sempre visível)
    rctx.setLineDash([6, 5]);
    rctx.lineJoin = 'round';
    rctx.lineCap = 'round';
    rctx.strokeStyle = 'rgba(190,198,208,0.85)';
    rctx.lineWidth = 1.6;
    strokeRoute(v.baseline.drawPath || v.baseline.path);
    rctx.setLineDash([]);

    // 2. A* (menor tempo com a matriz de correntes) — linha sólida azul metálico
    if (routeDisplayMode === 'astar' || routeDisplayMode === 'both') {
      drawEngineRoute(v.astar.drawPath || v.astar.path, '#4f7fc9', 2.6, false);
    }
    // 3. Copiloto IA — néon pulsante colorido pela potência; tracejado sobre o A* no modo "ambas"
    if (routeDisplayMode === 'llm' || routeDisplayMode === 'both') {
      drawPowerRoute(v.llm, 0.6 + 0.4 * Math.sin(pulsePhase), routeDisplayMode === 'both');
    }
  } else if (routePath && routePath.length > 1) {
    const routeColor = routeIsEmergency ? '#ff3b30' : MAP.route;
    rctx.lineJoin = 'round';
    rctx.lineCap = 'round';
    rctx.strokeStyle = 'rgba(255,255,255,0.75)';
    rctx.lineWidth = 6;
    strokeRoute(routePath);
    rctx.strokeStyle = routeColor;
    rctx.lineWidth = routeIsEmergency ? 3 : 2.5;
    strokeRoute(routePath);
    drawRouteArrows(routePath, routeColor);
  }

  if (routeA) drawPin(routeA, routeIsEmergency ? '#ff3b30' : '#4ade80', routeIsEmergency ? '!' : 'A');
  if (routeB) drawPin(routeB, routeIsEmergency ? '#22c55e' : '#f87171', routeIsEmergency ? 'P' : 'B');
}

setInterval(() => {
  if (haveRouteVariants() && (routeDisplayMode === 'llm' || routeDisplayMode === 'both')) {
    pulsePhase += 0.18;
    drawRoute();
  }
}, 120);

/* ---------- análise da rota (clique com botão direito na linha) ---------- */
const FUEL_REF_TPD = 180;    // t/dia de referência a 20 nós (porta-contêineres médio)
const FUEL_REF_KN = 20;
const FUEL_PRICE_USD = 600;  // US$/t de VLSFO — estimativa de mercado
const CO2_PER_TON_FUEL = 3.114; // fator de emissão (IMO) p/ combustível fóssil marítimo

function fuelTonsPerHour(kn) {
  return (FUEL_REF_TPD / 24) * Math.pow(kn / FUEL_REF_KN, 3);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isPointNearPath(px, py, tol, path) {
  if (!path || path.length < 2) return false;
  let prev = null;
  for (let i = 0; i < path.length; i++) {
    const s = project(path[i][0], path[i][1]);
    if (prev && Math.abs(s[0] - prev[0]) <= W * 0.5) {
      if (distToSegment(px, py, prev[0], prev[1], s[0], s[1]) <= tol) return true;
    }
    prev = s;
  }
  return false;
}

function isPointNearRoute(px, py, tol) {
  if (haveRouteVariants()) {
    const v = routeVariants;
    return ['baseline', 'astar', 'llm'].some((k) => v[k] && isPointNearPath(px, py, tol, v[k].drawPath || v[k].path));
  }
  return isPointNearPath(px, py, tol, routePath);
}

function setRaCell(row, idx, text) {
  const el = document.getElementById('ra3-' + row + '-' + idx);
  if (el) el.textContent = text;
}

// colunas 2 e 3 comparadas com a rota comercial padrão (coluna 1)
function fillRaColumn(idx, m, base) {
  if (!m || !isFinite(m.hours)) {
    ['speed', 'dist', 'time', 'fuel', 'co2', 'cost'].forEach((row) => setRaCell(row, idx, '—'));
    return;
  }
  const kn = m.service_kn || SHIP.kn;
  const fuel = (m.fuel_tons != null && isFinite(m.fuel_tons)) ? m.fuel_tons : fuelTonsPerHour(kn) * m.hours;
  setRaCell('speed', idx, m.speeds
    ? nf1(m.min_kn) + '–' + nf1(m.max_kn) + ' nós · média ' + nf1(m.avg_kn) + ' (carga ' + Math.round(m.load_pct) + '%)'
    : nf1(kn) + ' nós constantes (carga 100%)');
  setRaCell('dist', idx, fmtNm(m.km) + ' · ' + fmtKm(m.km));
  setRaCell('time', idx, fmtDur(m.hours) +
    (base && isFinite(base.hours) ? ' (' + (m.hours <= base.hours ? '−' : '+') + nf1(Math.abs(m.hours - base.hours)) + ' h)' : ''));

  if (idx === 0 || !base) {
    setRaCell('fuel', idx, nf1(fuel) + ' t VLSFO');
    setRaCell('co2', idx, nf1(fuel * CO2_PER_TON_FUEL) + ' t emitidas (ref.)');
    setRaCell('cost', idx, 'US$ ' + Math.round(fuel * FUEL_PRICE_USD).toLocaleString('pt-BR') + ' (ref.)');
    return;
  }
  const baseFuel = base.fuel_tons;
  const saved = Math.max(0, baseFuel - fuel);
  const pct = baseFuel > 0 ? (saved / baseFuel) * 100 : 0;
  setRaCell('fuel', idx, nf1(fuel) + ' t (−' + nf1(pct) + '%)');
  setRaCell('co2', idx, nf1(saved * CO2_PER_TON_FUEL) + ' t evitadas');
  setRaCell('cost', idx, 'US$ ' + Math.round(saved * FUEL_PRICE_USD).toLocaleString('pt-BR'));
}

function bearingDeg(lo1, la1, lo2, la2) {
  const p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180;
  const dl = (lo2 - lo1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function openRouteAnalytics() {
  const modal = document.getElementById('route-analytics');
  if (!modal || !routeA || !routeB) return;
  const v = (routeVariants && routeVariants.key === routeVariantsKey(routeA, routeB)) ? routeVariants : null;

  fillRaColumn(0, v && v.baseline, null);
  fillRaColumn(1, v && v.astar, v && v.baseline);
  fillRaColumn(2, v && v.llm, v && v.baseline);

  const subtitle = routeAPort && routeBPort
    ? routeAPort.name + ' → ' + routeBPort.name
    : (routeIsEmergency && routeBPort ? 'Posição de emergência → ' + routeBPort.name : null);
  document.getElementById('ra-subtitle').textContent =
    (subtitle || (fmtCoord(routeA[1], routeA[0]) + ' → ' + fmtCoord(routeB[1], routeB[0]))) +
    ' · ' + nf1(SHIP.kn) + ' nós de serviço';

  document.getElementById('ra-rationale').textContent = v && v.llm && v.llm.rationale
    ? '🧭 ' + v.llm.rationale
    : '🧭 Não foi possível comparar as abordagens para este trajeto.';

  modal.hidden = false;
}

function closeRouteAnalytics() {
  const modal = document.getElementById('route-analytics');
  if (modal) modal.hidden = true;
}

function bindRouteAnalytics() {
  const modal = document.getElementById('route-analytics');
  if (!modal) return;

  flowCanvas.addEventListener('contextmenu', (e) => {
    const r = flowCanvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (isPointNearRoute(mx, my, 8)) {
      e.preventDefault();
      openRouteAnalytics();
    }
  });

  document.getElementById('ra-close').addEventListener('click', closeRouteAnalytics);
  modal.querySelector('.ra-backdrop').addEventListener('click', closeRouteAnalytics);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeRouteAnalytics();
  });
}

/* ---------- Previsões IA: aciona as ferramentas do Copiloto (sem chat) ---------- */
function aiCurrentPoint() {
  if (lastHoverLL) return { lon: lastHoverLL[0], lat: lastHoverLL[1] };
  const c = invert(W / 2, H / 2);
  return { lon: c[0], lat: c[1] };
}

const nf1 = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const COMPASS_PT = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
function compassPt(deg) { return COMPASS_PT[Math.floor(((deg + 22.5) % 360) / 45)]; }
function normLon(lon) { return ((lon + 180) % 360 + 360) % 360 - 180; }

function updateDriftMetrics() {
  const box = document.getElementById('ai-drift-metrics');
  if (!box) return;
  if (!oilSpill || oilSpill.drift_hours == null) { box.hidden = true; return; }
  box.hidden = false;
  const s = oilSpill;
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set('ai-drift-time', s.drift_hours + ' horas no mar (' + nf1(s.drift_hours / 24) + ' dias)');
  set('ai-drift-dist', nf1(s.drift_nm) + ' NM');
  set('ai-drift-speed', nf1(s.drift_speed_kn) + ' nós');

  // campos extras só existem na simulação local (a resposta antiga do servidor não os traz)
  const local = s.dx_km != null;
  box.querySelectorAll('[data-opt]').forEach((el) => { el.hidden = !local; });
  if (local) {
    set('ai-drift-xy',
      'X ' + nf1(Math.abs(s.dx_km)) + ' km ' + (s.dx_km >= 0 ? 'L' : 'O') +
      ' · Y ' + nf1(Math.abs(s.dy_km)) + ' km ' + (s.dy_km >= 0 ? 'N' : 'S') +
      (s.drift_compass ? ' (rumo ' + s.drift_compass + ')' : ''));
    const r = s.frames[s.frames.length - 1].radius_km;
    set('ai-drift-radius', nf1(r) + ' km (~' + Math.round(Math.PI * r * r).toLocaleString('pt-BR') + ' km²)');
    set('ai-drift-origin',
      (s.routeLabel ? s.routeLabel + (s.incident_frac != null ? ' · ' + Math.round(s.incident_frac * 100) + '%' : '') + ' — ' : '') +
      fmtCoord(s.origin.lat, s.origin.lon));
    set('ai-drift-ship', fmtCoord(s.final.lat, s.final.lon));
  }
  const ag = document.getElementById('ai-drift-aground');
  if (ag) {
    ag.hidden = !s.aground;
    if (s.aground) ag.textContent = '⚠️ Atingiu a costa após ' + s.grounded_hour + ' h de deriva — risco de contaminação do litoral.';
  }
}

/* ---------- Simulação de Vazamento & Deriva (calculada no navegador) ----------
   Usa o MESMO campo de correntes que anima as partículas (sampleField), então
   funciona sem o servidor Python e responde na hora a cada ajuste do formulário. */
let spillActive = false;
let spillCursorOrigin = null; // ponto livre fixado no clique, pra ajustes ao vivo não "seguirem" o mouse
const spillRouteCache = new Map();

function spillShipRoute(choice) {
  if (choice === 'current') {
    if (!routePath || routePath.length < 2) {
      return { error: 'Trace uma rota em "Navegação" primeiro — ou escolha uma das rotas pré-definidas.' };
    }
    const label = routeAPort && routeBPort ? routeAPort.name + ' → ' + routeBPort.name
      : (routeIsEmergency ? 'Rota de emergência' : 'Rota atual');
    return { path: routePath, label };
  }
  if (spillRouteCache.has(choice)) return spillRouteCache.get(choice);

  const [ia, ib] = choice.split('|');
  const pa = PORT_BY_ID.get(ia), pb = PORT_BY_ID.get(ib);
  if (!pa || !pb) return { error: 'Porto não encontrado na base de portos.' };
  const sA = navSnap(pa.lon, pa.lat), sB = navSnap(pb.lon, pb.lat);
  if (!sA || !sB) return { error: 'Esta rota está fora da área navegável dos dados carregados.' };
  const res = aStar(sA[0], sA[1], sB[0], sB[1]);
  if (!res || res.path.length < 2) {
    return { error: 'Não encontrei trajeto marítimo entre ' + pa.name + ' e ' + pb.name + ' com os dados atuais.' };
  }
  const out = { path: smoothPath(res.path), label: pa.name + ' → ' + pb.name };
  spillRouteCache.set(choice, out);
  return out;
}

function pointAlongPath(path, frac) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = havKm(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    seg.push(d);
    total += d;
  }
  let target = total * Math.max(0, Math.min(1, frac));
  for (let i = 1; i < path.length; i++) {
    const d = seg[i - 1];
    if (target <= d || i === path.length - 1) {
      const t = d > 0 ? Math.min(1, target / d) : 0;
      const a = path[i - 1], b = path[i];
      return [normLon(a[0] + (b[0] - a[0]) * t), a[1] + (b[1] - a[1]) * t];
    }
    target -= d;
  }
  return [normLon(path[0][0]), path[0][1]];
}

function toWater(lon, lat) {
  if (!isLandLL(lon, lat)) return [lon, lat];
  const s = navSnap(lon, lat);
  return s ? [navLon(s[1]), navLat(s[0])] : null;
}

function simulateDrift(lon0, lat0, hours, volume) {
  const S = OD ? 3.6 : 2.0; // mesma conversão do edgeHours: m/s -> km/h (campo sintético: 2,0)
  const SUB = 4;            // 4 passos de 15 min por hora — segue melhor as curvas das correntes
  const r0 = 0.15 * Math.sqrt(Math.max(1, volume));
  const spread = 2.17 * Math.pow(Math.max(1, volume) / 500, 0.25); // espalhamento tipo Fay: maior volume, mancha maior
  let lon = lon0, lat = lat0, driftKm = 0, aground = false, groundedHour = null;
  const frames = [];

  for (let h = 1; h <= hours; h++) {
    for (let k = 0; k < SUB && !aground; k++) {
      const f = sampleField(lon, lat);
      const nlat = lat + (f[1] * S / SUB) / 110.57;
      const nlon = normLon(lon + (f[0] * S / SUB) / (111.32 * Math.max(0.05, Math.cos(lat * Math.PI / 180))));
      if (Math.abs(nlat) > 84 || isLandLL(nlon, nlat)) { aground = true; groundedHour = h; break; }
      driftKm += havKm(lon, lat, nlon, nlat);
      lon = nlon;
      lat = nlat;
    }
    frames.push({ hour: h, lat, lon, radius_km: r0 + spread * Math.pow(h, 0.75) });
  }

  const midLat = (lat0 + lat) / 2;
  const dxKm = (((lon - lon0 + 540) % 360) - 180) * 111.32 * Math.cos(midLat * Math.PI / 180);
  const dyKm = (lat - lat0) * 110.57;
  const driftNm = driftKm * 0.539957;
  const speedKn = driftNm / hours;
  const compass = driftKm > 0.05 ? compassPt(bearingDeg(lon0, lat0, lon, lat)) : null;

  let explanation = compass
    ? 'Conclusão da IA: Modelo de advecção-difusão impulsionado por correntes de superfície (direção '
      + compass + ' a ' + nf1(speedKn) + ' nós). O navio derivou ' + nf1(driftNm) + ' NM ao longo de '
      + hours + ' horas.'
    : 'Conclusão da IA: Modelo de advecção-difusão impulsionado por correntes de superfície — correntes '
      + 'fracas no ponto, deriva de apenas ' + nf1(driftNm) + ' NM em ' + hours + ' horas.';
  if (aground) explanation += ' A mancha atingiu a costa após ' + groundedHour + ' h.';

  return {
    origin: { lat: lat0, lon: lon0 },
    final: { lat, lon },
    volume_ton: volume,
    frames,
    title: 'SIMULAÇÃO DE DERIVA & VAZAMENTO',
    explanation,
    drift_hours: hours,
    drift_km: driftKm,
    drift_nm: driftNm,
    drift_speed_kn: speedKn,
    drift_compass: compass,
    dx_km: dxKm,
    dy_km: dyKm,
    aground,
    grounded_hour: groundedHour,
  };
}

// zoomIn=false (ajustes ao vivo): só recentraliza se o evento saiu da tela, sem mexer no zoom
function focusOnSpill(sim, zoomIn) {
  const o = sim.origin, f = sim.final;
  const dLon = ((f.lon - o.lon + 540) % 360) - 180; // funciona mesmo cruzando 180°
  const cLon = normLon(o.lon + dLon / 2), cLat = (o.lat + f.lat) / 2;
  if (!zoomIn) {
    const a = project(normLon(o.lon), o.lat), b = project(normLon(f.lon), f.lat);
    const inView = (p) => p[0] > 40 && p[0] < W - 40 && p[1] > 40 && p[1] < H - 40;
    if (inView(a) && inView(b)) return;
  } else {
    const rKm = sim.frames[sim.frames.length - 1].radius_km;
    const spanX = Math.abs(dLon) + 2 * rKm / (111 * Math.max(0.2, Math.cos(cLat * Math.PI / 180)));
    const spanY = Math.abs(f.lat - o.lat) + 2 * rKm / 111;
    const fitK = Math.min(0.45 * W / Math.max(spanX, 0.05), 0.45 * H / Math.max(spanY, 0.05));
    const nz = Math.min((OD && OD.regional) ? 120 : 16, fitK / baseK);
    if (nz > Z) { Z = nz; scaleK = Z * baseK; }
  }
  originX = W / 2 - (cLon + 180) * scaleK;
  originY = H / 2 - (90 - cLat) * scaleK;
  clampView();
  updateProj();
  fctx.clearRect(0, 0, W, H);
}

function readSpillForm() {
  let hours = Math.round(+document.getElementById('spill-hours').value);
  if (!isFinite(hours) || hours < 1) hours = 18;
  hours = Math.min(240, hours);
  let volume = +document.getElementById('spill-volume').value;
  if (!isFinite(volume) || volume <= 0) volume = 500;
  return {
    choice: document.getElementById('spill-route').value,
    frac: +document.getElementById('spill-pos').value / 100,
    hours,
    volume,
  };
}

function runSpillSimulation(live) {
  const statusEl = document.getElementById('ai-status');
  const say = (t) => { if (statusEl) statusEl.textContent = t; };
  if (!NAV) { say('O mapa ainda está carregando — tente de novo em instantes.'); return; }

  const form = readSpillForm();
  let origin, shipRoute = null, label, frac = null;
  if (form.choice === 'cursor') {
    if (!live || !spillCursorOrigin) {
      const p = aiCurrentPoint();
      spillCursorOrigin = [normLon(p.lon), p.lat];
    }
    origin = spillCursorOrigin;
    label = 'Ponto livre';
  } else {
    const r = spillShipRoute(form.choice);
    if (r.error) { say(r.error); return; }
    shipRoute = r.path;
    label = r.label;
    frac = form.frac;
    origin = pointAlongPath(r.path, frac);
  }
  origin = toWater(origin[0], origin[1]);
  if (!origin) { say('O ponto escolhido não está em água navegável.'); return; }

  const sim = simulateDrift(origin[0], origin[1], form.hours, form.volume);
  sim.shipRoute = shipRoute;
  sim.routeLabel = label;
  sim.incident_frac = frac;
  oilSpill = sim;
  spillActive = true;
  updateDriftMetrics();

  say('🚨 Incidente em ' + label + (frac != null ? ' (' + Math.round(frac * 100) + '% do trajeto)' : '') +
      ': deriva de ' + nf1(sim.drift_nm) + ' NM em ' + form.hours + ' h' +
      (sim.aground ? ' — atingiu a costa.' : '.'));

  focusOnSpill(sim, !live); // no clique: centraliza e aproxima o suficiente p/ ler a deriva
  drawBase();
  drawRoute();
}

async function aiToolRequest(message, statusPrefix) {
  const statusEl = document.getElementById('ai-status');
  if (statusEl) statusEl.textContent = statusPrefix || 'consultando o Copiloto IA…';

  const point = aiCurrentPoint();
  let data;
  try {
    if (location.protocol === 'file:') throw new Error('sem servidor local');
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, context: point }),
    });
    data = await res.json();
  } catch (e) {
    data = {
      reply: 'Não consegui falar com o servidor local. Rode "python servidor.py" para ativar as Previsões IA '
           + '(simulação de vazamento e previsão de cardumes).',
      tool: null, data: null,
    };
  }

  if (statusEl) statusEl.textContent = data.reply || '';

  if (data.tool === 'simular_vazamento' && data.data) {
    oilSpill = data.data;
    spillActive = false;
    updateDriftMetrics();
    drawBase();
  } else if (data.tool === 'prever_cardumes' && data.data) {
    fishHotspots = data.data;
    drawBase();
  }
}

function bindAiPredictions() {
  const fishBtn = document.getElementById('ai-fish');
  const clearBtn = document.getElementById('ai-clear');
  const runBtn = document.getElementById('spill-run');
  const routeSel = document.getElementById('spill-route');
  const pos = document.getElementById('spill-pos');
  const posVal = document.getElementById('spill-pos-val');
  const posWrap = document.getElementById('spill-pos-wrap');
  if (!fishBtn || !clearBtn || !runBtn || !routeSel || !pos) return;

  fishBtn.addEventListener('click', () => aiToolRequest('Prever zonas de cardumes na costa', '🐟 procurando frentes de convergência…'));
  clearBtn.addEventListener('click', () => {
    oilSpill = null;
    fishHotspots = null;
    spillActive = false;
    spillCursorOrigin = null;
    hideSimTooltip();
    updateDriftMetrics();
    const statusEl = document.getElementById('ai-status');
    if (statusEl) statusEl.textContent = '';
    drawBase();
  });

  runBtn.addEventListener('click', () => runSpillSimulation(false));

  // depois da 1ª simulação, qualquer ajuste recalcula na hora (no máximo 1x por quadro)
  let pending = false;
  const live = () => {
    if (!spillActive || pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; runSpillSimulation(true); });
  };
  const syncPos = () => {
    if (posVal) posVal.textContent = pos.value + '%';
    if (posWrap) posWrap.hidden = routeSel.value === 'cursor';
  };
  pos.addEventListener('input', () => { syncPos(); live(); });
  routeSel.addEventListener('change', () => { syncPos(); live(); });
  document.getElementById('spill-hours').addEventListener('input', live);
  document.getElementById('spill-volume').addEventListener('input', live);
  syncPos();
}

/* ---------- legenda ---------- */
function buildLegend() {
  const idxByKey = { cold: 2, mild: 1, warm: 0 };
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
  const nav = document.getElementById('lg-nav');
  const ports = document.getElementById('lg-ports');
  if (sw) sw.hidden = showSST;
  if (sst) sst.hidden = !showSST;
  if (nav) nav.hidden = !showNavRoutes;
  if (ports) ports.hidden = !showPorts;
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

  fetch('/api/status', { cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => { if (j.state === 'running') { btn.disabled = true; poll(); } })
    .catch(() => {});
}

/* ---------- tema claro/escuro ---------- */
function isDarkActive() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function updateThemeColorMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDarkActive() ? '#0f1620' : '#eef2f4');
}

function applyMapTheme() {
  Object.assign(MAP, isDarkActive() ? MAP_DARK : MAP_LIGHT);
  updateThemeColorMeta();
  buildBordersTexture();
  drawBase();
  drawRoute();
}

function bindThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  let stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
  applyMapTheme();

  btn.addEventListener('click', () => {
    const next = isDarkActive() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    applyMapTheme();
  });

  const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  mqDark.addEventListener('change', () => {
    if (!document.documentElement.getAttribute('data-theme')) applyMapTheme();
  });
}

/* ---------- painel recolhível (celular/tablet) ---------- */
function bindPanelToggle() {
  const panel = document.getElementById('panel');
  const btn = document.getElementById('panel-toggle');
  if (!panel || !btn) return;
  const mq = window.matchMedia('(max-width: 640px)');

  const setCollapsed = (collapsed) => {
    panel.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.textContent = collapsed ? '+' : '−';
  };

  btn.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  setCollapsed(mq.matches);
  mq.addEventListener('change', (e) => setCollapsed(e.matches));
}

/* ---------- botão ☰: painel lateral retrátil (slide-in / slide-out) ----------
   Ao ocultar, o mapa passa a 100% da largura logo no início (um único resize) e o
   painel desliza por cima pra fora; ao mostrar, ele desliza de volta por cima do mapa
   e só no fim da animação volta a ocupar sua coluna. Assim o canvas nunca é esticado
   nem realocado a cada quadro da animação. */
function bindMenuToggle() {
  const app = document.getElementById('app');
  const panel = document.getElementById('panel');
  const stage = document.getElementById('stage');
  const btn = document.getElementById('menu-toggle');
  if (!app || !panel || !stage || !btn) return;

  let token = 0;
  const relayout = (mutate) => {
    const before = stage.getBoundingClientRect().left;
    mutate();
    const r = stage.getBoundingClientRect();
    if (Math.abs(r.left - before) > 0.5 || Math.round(r.width) !== W) resize(before - r.left);
  };

  const setHidden = (hide) => {
    const my = ++token;
    btn.setAttribute('aria-expanded', String(!hide));
    if (hide) {
      relayout(() => app.classList.add('panel-overlay'));
      void panel.offsetWidth; // a transição parte da posição visível
      app.classList.add('panel-hidden');
      return;
    }
    app.classList.add('panel-overlay');
    void panel.offsetWidth;
    app.classList.remove('panel-hidden');

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      panel.removeEventListener('transitionend', onEnd);
      if (my !== token) return; // clicaram de novo no meio da animação
      relayout(() => app.classList.remove('panel-overlay'));
    };
    const onEnd = (e) => { if (e.target === panel && e.propertyName === 'transform') finish(); };
    panel.addEventListener('transitionend', onEnd);
    setTimeout(finish, 380); // sem transição (prefers-reduced-motion) o transitionend não dispara
  };

  btn.addEventListener('click', () => setHidden(!app.classList.contains('panel-hidden')));
}

/* ---------- controles ---------- */
function bindControls() {
  showSST = document.getElementById('t-sst').checked;
  showCurr = document.getElementById('t-curr').checked;
  showGrat = document.getElementById('t-grat').checked;
  showNavRoutes = document.getElementById('t-navroutes').checked;
  showPorts = document.getElementById('t-ports').checked;

  document.getElementById('t-sst').addEventListener('change', (e) => { showSST = e.target.checked; updateLegend(); drawBase(); drawRoute(); });
  document.getElementById('t-grat').addEventListener('change', (e) => { showGrat = e.target.checked; drawBase(); });
  document.getElementById('t-curr').addEventListener('change', (e) => { showCurr = e.target.checked; });
  document.getElementById('t-density').addEventListener('change', (e) => {
    const lvl = DENSITY_LEVELS[e.target.value] || DENSITY_LEVELS.alta;
    CFG.density = lvl.density; CFG.minP = lvl.minP; CFG.maxP = lvl.maxP;
    seedParticles();
  });
  document.getElementById('t-navroutes').addEventListener('change', (e) => { showNavRoutes = e.target.checked; updateLegend(); drawBase(); });
  document.getElementById('t-ports').addEventListener('change', (e) => {
    showPorts = e.target.checked;
    if (!showPorts) { hoveredPort = null; portTooltipEl.hidden = true; }
    updateLegend();
    drawBase();
  });
  document.getElementById('z-in').addEventListener('click', () => setZoom(Z * 1.5, W / 2, H / 2));
  document.getElementById('z-out').addEventListener('click', () => setZoom(Z / 1.5, W / 2, H / 2));
  document.getElementById('z-reset').addEventListener('click', resetView);

  routeInfoEl = document.getElementById('r-info');
  populatePortSelectors();

  document.getElementById('r-pick').addEventListener('click', () => {
    if (emergencyMode) setEmergencyMode(false);
    routeMode = 'A'; routeA = routeB = routePath = null;
    routeAPort = routeBPort = null;
    routeIsEmergency = false;
    closeRouteAnalytics();
    if (!showPorts) {
      showPorts = true;
      document.getElementById('t-ports').checked = true;
      updateLegend();
    }
    document.getElementById('r-origin').value = '';
    document.getElementById('r-dest').value = '';
    routeInfoEl.textContent = 'Clique em um porto de origem (marcador no mapa) ou use o menu "Origem" abaixo.';
    flowCanvas.classList.add('picking');
    drawRoute();
    drawBase();
  });
  document.getElementById('r-clear').addEventListener('click', () => {
    routeMode = null; routeA = routeB = routePath = null;
    routeAPort = routeBPort = null;
    routeIsEmergency = false;
    routeInfoEl.textContent = '';
    flowCanvas.classList.remove('picking');
    document.getElementById('r-origin').value = '';
    document.getElementById('r-dest').value = '';
    const alertEl = document.getElementById('emg-alert');
    if (alertEl) alertEl.hidden = true;
    closeRouteAnalytics();
    drawRoute();
  });
  document.getElementById('r-origin').addEventListener('change', routeFromSelectors);
  document.getElementById('r-dest').addEventListener('change', routeFromSelectors);
  document.getElementById('r-emergency').addEventListener('click', () => setEmergencyMode(!emergencyMode));
  document.getElementById('r-speed').addEventListener('input', (e) => {
    SHIP.kn = +e.target.value;
    document.getElementById('r-kn').textContent = e.target.value;
    if (!routeA || !routeB || routeMode) return;
    if (routeIsEmergency) computeEmergencyRoute(routeA[0], routeA[1]);
    else computeRoute();
  });
  document.querySelectorAll('input[name="r-algo"]').forEach((el) => {
    el.addEventListener('change', (e) => {
      if (e.target.checked) { routeDisplayMode = e.target.value; drawRoute(); }
    });
  });

  bindUpdateButton();
  bindPanelToggle();
  bindMenuToggle();
  bindThemeToggle();
  bindRouteAnalytics();
  bindAiPredictions();

  let drag = null, touch = null, wheelEnd = null;

  flowCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    panning = true;
    clearTimeout(wheelEnd);
    wheelEnd = setTimeout(() => { panning = false; requestBase(); }, 150);
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
    panning = true;
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
    if (panning) { panning = false; requestBase(); }
  });

  flowCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    panning = true;
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
    e.preventDefault();
    if (touch && touch.mode === 'pan' && touch.moved < 8 && !e.touches.length) {
      const r = flowCanvas.getBoundingClientRect();
      handleMapClick(touch.x - r.left, touch.y - r.top);
    }
    if (!e.touches.length) {
      touch = null;
      panning = false;
      requestBase();
    }
  }, { passive: false });

  flowCanvas.addEventListener('mousemove', (ev) => {
    if (drag || touch) return;
    const r = flowCanvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;

    if (showPorts) {
      const p = findPortAt(mx, my);
      if (p !== hoveredPort) {
        hoveredPort = p;
        flowCanvas.classList.toggle('port-hover', !!p);
      }
      if (p) {
        portTooltipEl.innerHTML =
          '<span class="pt-name">' + p.name + '</span>' +
          '<span class="pt-meta">' + p.country + ' · ' + p.type + '</span>' +
          '<span class="pt-meta">' + fmtCoord(p.lat, p.lon) + '</span>' +
          '<span class="pt-size">' + p.size + '</span>';
        portTooltipEl.style.left = mx + 'px';
        portTooltipEl.style.top = my + 'px';
        portTooltipEl.hidden = false;
      } else {
        portTooltipEl.hidden = true;
      }
    } else if (hoveredPort) {
      hoveredPort = null;
      portTooltipEl.hidden = true;
    }

    if (!hoveredPort) {
      const fish = findFishHotspotAt(mx, my);
      const oil = !fish ? findOilHoverAt(mx, my) : null;
      if (fish) {
        showSimTooltip(mx, my, 'fish', fish.title || 'ZONA DE ALTA PRODUTIVIDADE BIOLÓGICA', fish.explanation || '');
      } else if (oil) {
        showSimTooltip(mx, my, 'oil', oil.title || 'SIMULAÇÃO DE VAZAMENTO & DERIVA', oil.explanation || '');
      } else {
        hideSimTooltip();
      }
    } else {
      hideSimTooltip();
    }

    const ll = invert(mx, my);
    if (ll[1] > 90 || ll[1] < -90) { readoutEl.textContent = ''; return; }
    lastHoverLL = [((ll[0] + 180) % 360 + 360) % 360 - 180, ll[1]];
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
  flowCanvas.addEventListener('mouseleave', () => {
    readoutEl.textContent = '';
    hoveredPort = null;
    portTooltipEl.hidden = true;
    flowCanvas.classList.remove('port-hover');
    hideSimTooltip();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      lastT = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  });

  let rt;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(resize, 180); };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
}

/* ---------- inicialização ---------- */
async function init() {
  resize();
  bindControls();

  MD = window.MARINE_DATA || null;
  OD = decodeMarine(curDay) || decodeOceanData();
  if (OD) {
    const regional = OD.regional;
    CFG.speed = regional ? 0.30 : 0.22;
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
  [land, countries] = await Promise.all([loadLand(), loadCountries()]);
  if (!land) warnEl.hidden = false;
  if (countries) {
    countries.features.forEach((f) => { f.__b = d3.geoBounds(f); });
    majorCountries = countries.features
      .filter((f) => f.properties.r <= MAX_LABEL_RANK)
      .sort((a, b) => a.properties.r - b.properties.r);
    polarTerritories = {
      type: 'FeatureCollection',
      features: countries.features.filter((f) => POLAR_TERRITORY_NAMES.has(f.properties.n)),
    };
    buildBordersTexture();
  }

  await new Promise((r) => setTimeout(r, 16));

  prepCurrents();
  buildLandMask();
  buildSatelliteTextures();
  buildNav();
  if (!OD) buildField();
  computeNavRoutes();
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
