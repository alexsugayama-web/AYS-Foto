import {
  SPEC,
  autoView,
  centerView,
  exportJpeg,
  faceGeometry,
  fromView,
  measure,
  renderOutput,
  renderView,
  toView,
} from "./photo.js";
import { buildMask } from "./mask.js";
import { analyzeBackground, detectFaces, findHeadTop, loadVision, segmentView } from "./vision.js";

// Altura típica do topo do cabelo acima da linha dos olhos, em unidades da
// distância olhos-queixo. Usada só quando a segmentação não acha o topo.
const HEAD_TOP_FALLBACK = 1.12;
const MAX_WORK_SIDE = 3000;
const MAX_WORK_AREA = 9e6;
const RULER = { top: 28, left: 36 };

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  frame: $("frame"),
  canvas: $("preview"),
  pick: $("pick"),
  file: $("file"),
  status: $("status"),
  change: $("change"),
  refit: $("refit"),
  zoom: $("zoom"),
  zoomOut: $("zoomOut"),
  rot: $("rot"),
  rotOut: $("rotOut"),
  whiten: $("whiten"),
  whitenHint: $("whitenHint"),
  guides: $("guides"),
  summary: $("summary"),
  checks: $("checks"),
  download: $("download"),
  fileNote: $("fileNote"),
  rulerTop: $("rulerTop"),
  rulerLeft: $("rulerLeft"),
};

let vision = null;
let visionState = "loading";
let state = null;
let busy = false;
let frameCss = 0;
let dpr = 1;
let renderQueued = false;
let settleTimer = 0;
let lastChecksHtml = "";
let gauge = null;

// ---------- status e utilidades ----------

function setStatus(text, tone = "") {
  el.status.textContent = text;
  el.status.dataset.tone = tone;
}

function setPhase(phase) {
  el.body.dataset.status = phase;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("tempo esgotado")), ms)),
  ]);
}

function fmtPct(x) {
  return `${Math.round(x * 100)}%`;
}

function fmtDeg(d) {
  const v = Math.round(d * 10) / 10;
  const s = Math.abs(v).toFixed(1).replace(".", ",");
  return v > 0 ? `+${s}°` : v < 0 ? `−${s}°` : "0°";
}

// ---------- detector ----------

function bootVision() {
  visionState = "loading";
  if (!state) setStatus("Preparando o detector de rosto…");
  loadVision().then(
    (v) => {
      vision = v;
      visionState = "ready";
      if (!state && !busy) setStatus("");
      if (state && state.visionFailed && !busy) analyzeCurrent();
    },
    (err) => {
      console.error(err);
      visionState = "failed";
      if (!state && !busy) {
        setStatus("O detector automático não carregou. Você ainda pode enquadrar a foto à mão.", "warn");
      }
    },
  );
}

// ---------- abrir a foto ----------

function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    img.src = url;
  });
}

function downscaleInto(img, w, h) {
  let srcEl = img;
  let sw = img.naturalWidth || img.width;
  let sh = img.naturalHeight || img.height;
  while (sw / 2 >= w * 1.0001 && sh / 2 >= h * 1.0001) {
    const half = document.createElement("canvas");
    half.width = Math.round(sw / 2);
    half.height = Math.round(sh / 2);
    const hctx = half.getContext("2d");
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(srcEl, 0, 0, half.width, half.height);
    srcEl = half;
    sw = half.width;
    sh = half.height;
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcEl, 0, 0, w, h);
  return c;
}

function toWorkingCanvas(img) {
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  const s = Math.min(1, MAX_WORK_SIDE / Math.max(w0, h0), Math.sqrt(MAX_WORK_AREA / (w0 * h0)));
  return downscaleInto(img, Math.max(1, Math.round(w0 * s)), Math.max(1, Math.round(h0 * s)));
}

function decodeErrorMessage(file) {
  if (/\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type)) {
    return "Este navegador não abre fotos HEIC. Envie a foto pelo navegador do próprio celular ou salve-a em JPG.";
  }
  return "Não foi possível abrir este arquivo. Envie uma foto em JPG, PNG ou WebP.";
}

async function processFile(file) {
  if (!file || busy) return;
  if (file.type && !file.type.startsWith("image/")) {
    setStatus("Esse arquivo não é uma imagem. Envie uma foto em JPG, PNG ou WebP.", "error");
    return;
  }
  busy = true;
  setPhase("busy");
  setControlsEnabled(false);
  setStatus("Abrindo a foto…");
  let decoded;
  try {
    decoded = await decodeImage(file);
  } catch {
    busy = false;
    setPhase(state ? "ready" : "idle");
    setControlsEnabled(!!state);
    setStatus(decodeErrorMessage(file), "error");
    return;
  }
  const { img, url } = decoded;
  if (Math.min(img.naturalWidth, img.naturalHeight) < 200) {
    URL.revokeObjectURL(url);
    busy = false;
    setPhase(state ? "ready" : "idle");
    setControlsEnabled(!!state);
    setStatus("A foto é pequena demais. Use uma imagem com pelo menos 600 pixels de lado.", "error");
    return;
  }
  const src = toWorkingCanvas(img);
  URL.revokeObjectURL(url);

  const start = centerView(src.width, src.height);
  state = {
    src,
    face: null,
    auto: start,
    view: { ...start },
    mask: null,
    bg: null,
    whiten: false,
    noFace: false,
    visionFailed: false,
    baseL: start.L,
  };
  lastChecksHtml = "";
  el.body.classList.add("has-photo");
  el.fileNote.textContent = "JPEG, 600 × 600 pixels, 300 dpi, até 240 kB.";
  requestRender();
  await analyzeCurrent();
}

// Detecta o rosto na foto atual, enquadra e libera os controles. Também é
// chamada de novo se o detector terminar de carregar depois da foto.
async function analyzeCurrent() {
  busy = true;
  setPhase("busy");
  setControlsEnabled(false);
  state.visionFailed = false;
  state.noFace = false;
  setStatus(
    visionState === "ready"
      ? "Procurando o rosto…"
      : "Carregando o detector de rosto. Na primeira vez pode levar alguns segundos…",
  );
  await nextFrame();

  let v = null;
  try {
    v = await withTimeout(loadVision(), 90000);
    vision = v;
    visionState = "ready";
  } catch (err) {
    console.error(err);
    visionState = "failed";
  }
  if (v) {
    setStatus("Procurando o rosto…");
    await nextFrame();
    try {
      await analyze(v);
    } catch (err) {
      console.error(err);
      state.noFace = !state.face;
    }
  } else {
    state.visionFailed = true;
  }

  el.zoom.value = "0";
  el.rot.value = "0";
  el.whiten.checked = state.whiten;
  busy = false;
  setPhase("ready");
  setControlsEnabled(true);
  requestRender();

  if (state.visionFailed) {
    setStatus("O detector automático não carregou. Arraste a foto e use o zoom para encaixar a cabeça no oval.", "warn");
  } else if (!state.face) {
    setStatus("Nenhum rosto encontrado. Arraste a foto e use o zoom para encaixar a cabeça no oval.", "warn");
  } else {
    let msg = "Pronto. A foto foi enquadrada no padrão; confira a lista e baixe o arquivo.";
    if (state.whiten) msg += " O fundo foi trocado por branco porque o original não era claro.";
    setStatus(msg, "ok");
  }
}

async function analyze(v) {
  const { src } = state;
  state.face = null;
  const faces = await detectFaces(v.landmarker, src);
  if (faces.length) {
    const best = faces[0];
    const face = faceGeometry(best.pts, best.blend);
    face.multi = faces.length > 1 && faces[1].area > best.area * 0.15;
    const ht = findHeadTop(v.segmenter, src, face);
    let topB = ht.topB;
    let estimated = false;
    if (topB == null || topB > -0.75 * face.F || topB < -2.1 * face.F) {
      topB = -HEAD_TOP_FALLBACK * face.F;
      estimated = true;
    }
    if (ht.cut) topB = Math.min(topB, -HEAD_TOP_FALLBACK * face.F);
    face.topB = topB;
    face.topCut = !!ht.cut;
    face.topEstimated = estimated;
    state.face = face;
    state.auto = autoView(face);
  } else {
    state.noFace = true;
    state.auto = centerView(src.width, src.height);
  }
  state.view = { ...state.auto };
  state.baseL = state.auto.L;
  refreshMask(v);
  state.bg = analyzeBackground(src, state.view, state.mask);
  state.whiten = !!(state.face && state.bg.known && !state.bg.light);
}

// ---------- máscara de fundo ----------

function refreshMask(v = vision) {
  if (!v || !state) return;
  const region = { ...state.view, L: state.view.L * 1.2 };
  const seg = segmentView(v.segmenter, state.src, region);
  state.mask = { canvas: buildMask(state.src, region, seg.data, seg.w, seg.h), view: region };
}

function maskCovers() {
  const m = state && state.mask;
  if (!m) return false;
  if (state.view.L < m.view.L * 0.6) return false;
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([x, y]) => fromView(state.view, 1, { x, y }));
  return corners.every((p) => {
    const q = toView(m.view, 1, p);
    return q.x > 0.01 && q.x < 0.99 && q.y > 0.01 && q.y < 0.99;
  });
}

function ensureMask() {
  if (state && state.whiten && vision && !maskCovers()) refreshMask();
}

// Depois que a pessoa para de mexer: refaz a máscara se a vista saiu da área
// coberta e atualiza a análise do fundo e das bordas da foto.
function scheduleSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (!state || busy || !vision || state.visionFailed) return;
    if (!maskCovers()) refreshMask();
    if (state.mask) state.bg = analyzeBackground(state.src, state.view, state.mask);
    requestRender();
  }, 260);
}

// ---------- desenho ----------

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const c = el.canvas;
  const size = c.width;
  if (!size) return;
  const ctx = c.getContext("2d");
  if (!state) {
    drawTemplate(ctx, size);
    updateGauge(null);
    updateChecks(null);
    return;
  }
  renderView(c, state.src, state.view, { whiten: state.whiten, mask: state.mask, scratchKey: "preview" });
  const m = state.face ? measure(state.face, state.view) : null;
  if (el.guides.checked) drawGuides(ctx, size, m);
  updateGauge(m);
  updateReadouts();
  updateChecks(m);
}

const GUIDE = "0, 130, 179";

function ellipsePath(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
}

function drawTemplate(ctx, size) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#f7f9fb";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#e3e9ef";
  ellipsePath(ctx, size * 0.5, size * 0.395, size * 0.2, size * 0.285);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(size * 0.06, size);
  ctx.bezierCurveTo(size * 0.09, size * 0.8, size * 0.3, size * 0.735, size * 0.5, size * 0.735);
  ctx.bezierCurveTo(size * 0.7, size * 0.735, size * 0.91, size * 0.8, size * 0.94, size);
  ctx.closePath();
  ctx.fill();
  drawEyeBand(ctx, size);
  ctx.restore();
}

function hline(ctx, y, size) {
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(size, y);
  ctx.stroke();
}

function drawEyeBand(ctx, size) {
  const y1 = Math.round((1 - SPEC.eyes.max) * size);
  const y2 = Math.round((1 - SPEC.eyes.min) * size);
  ctx.fillStyle = `rgba(${GUIDE}, 0.10)`;
  ctx.fillRect(0, y1, size, y2 - y1);
  ctx.strokeStyle = `rgba(${GUIDE}, 0.75)`;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.setLineDash([]);
  hline(ctx, y1 + 0.5, size);
  hline(ctx, y2 - 0.5, size);
  return [y1, y2];
}

function label(ctx, text, x, y, color) {
  ctx.font = `600 ${11 * dpr}px "Public Sans", system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawGuides(ctx, size, m) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const pad = 8 * dpr;
  const [e1, e2] = drawEyeBand(ctx, size);
  ctx.strokeStyle = `rgba(${GUIDE}, 0.45)`;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.stroke();
  if (m) {
    const t1 = (m.chin - SPEC.head.max) * size;
    const t2 = (m.chin - SPEC.head.min) * size;
    ctx.fillStyle = `rgba(${GUIDE}, 0.10)`;
    ctx.fillRect(0, t1, size, t2 - t1);
    ctx.strokeStyle = `rgba(${GUIDE}, 0.75)`;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    hline(ctx, t1, size);
    hline(ctx, t2, size);
    const chinY = m.chin * size;
    ctx.strokeStyle = "rgba(15, 35, 66, 0.6)";
    hline(ctx, chinY, size);
    ctx.setLineDash([]);
    label(ctx, "topo da cabeça", size - pad, (t1 + t2) / 2, `rgb(${GUIDE})`);
    label(ctx, "queixo", size - pad, chinY - 9 * dpr, "rgb(15, 35, 66)");
  } else {
    ctx.strokeStyle = `rgba(${GUIDE}, 0.9)`;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    ellipsePath(ctx, size * 0.5, size * 0.395, size * 0.2, size * 0.285);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  label(ctx, "olhos", size - pad, (e1 + e2) / 2, `rgb(${GUIDE})`);
  ctx.restore();
}

// ---------- réguas ----------

function svgEl(name, attrs) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function drawRulers() {
  const D = frameCss;
  if (!D) return;
  const top = el.rulerTop;
  const left = el.rulerLeft;
  top.setAttribute("viewBox", `0 0 ${D} ${RULER.top}`);
  left.setAttribute("viewBox", `0 0 ${RULER.left} ${D}`);
  top.textContent = "";
  left.textContent = "";

  const ticksTop = svgEl("g", { class: "ticks" });
  for (let i = 0; i <= 16; i++) {
    const x = Math.min(D - 0.5, Math.max(0.5, (i * D) / 16));
    const len = i % 8 === 0 ? 12 : i % 4 === 0 ? 9 : i % 2 === 0 ? 6 : 4;
    ticksTop.append(svgEl("line", { x1: x, x2: x, y1: RULER.top - len, y2: RULER.top }));
  }
  top.append(ticksTop);
  const tl = (text, x, anchor) => {
    const t = svgEl("text", { x, y: 11, "text-anchor": anchor });
    t.textContent = text;
    top.append(t);
  };
  tl("pol", 1, "start");
  tl("1", D / 2, "middle");
  tl("2", D - 1, "end");

  const y1 = (1 - SPEC.eyes.max) * D;
  const y2 = (1 - SPEC.eyes.min) * D;
  left.append(svgEl("rect", { class: "band", x: 0, y: y1, width: RULER.left, height: y2 - y1 }));
  const ticksLeft = svgEl("g", { class: "ticks" });
  const perMm = D / 50.8;
  for (let mm = 0; mm <= 50; mm++) {
    const y = Math.max(0.5, mm * perMm);
    const len = mm % 10 === 0 ? 12 : mm % 5 === 0 ? 8 : 4;
    ticksLeft.append(svgEl("line", { x1: RULER.left - len, x2: RULER.left, y1: y, y2: y }));
  }
  left.append(ticksLeft);
  const ll = (text, y) => {
    const t = svgEl("text", { x: RULER.left - 15, y, "text-anchor": "end", "dominant-baseline": "middle" });
    t.textContent = text;
    left.append(t);
  };
  ll("mm", 8);
  for (let mm = 10; mm <= 50; mm += 10) ll(String(mm), mm * perMm);

  const bar = svgEl("line", { class: "head-bar", x1: RULER.left - 2, x2: RULER.left - 2, y1: 0, y2: 0 });
  const mark = svgEl("path", { class: "eye-mark", d: "M -9 -5 L -1 0 L -9 5 Z" });
  left.append(bar, mark);
  gauge = { bar, mark };
}

function updateGauge(m) {
  if (!gauge) return;
  const D = frameCss;
  if (!m) {
    gauge.bar.style.display = "none";
    gauge.mark.style.display = "none";
    return;
  }
  const headOk = m.head >= SPEC.head.min && m.head <= SPEC.head.max;
  const eyeOk = m.eyes >= SPEC.eyes.min && m.eyes <= SPEC.eyes.max;
  gauge.bar.style.display = "";
  gauge.mark.style.display = "";
  gauge.bar.setAttribute("y1", Math.max(0, m.top * D));
  gauge.bar.setAttribute("y2", Math.min(D, m.chin * D));
  gauge.bar.dataset.ok = headOk ? "1" : "0";
  gauge.mark.setAttribute("transform", `translate(${RULER.left}, ${(1 - m.eyes) * D})`);
  gauge.mark.dataset.ok = eyeOk ? "1" : "0";
}

// ---------- leitura dos controles ----------

function updateReadouts() {
  if (!state) return;
  el.zoomOut.textContent = `${Math.round((state.baseL / state.view.L) * 100)}%`;
  const deg = ((state.auto.theta - state.view.theta) * 180) / Math.PI;
  el.rotOut.textContent = fmtDeg(deg);
}

function syncSliders() {
  if (!state) return;
  el.zoom.value = String(Math.round(100 * Math.log2(state.baseL / state.view.L)));
  el.rot.value = String(Math.round((((state.auto.theta - state.view.theta) * 180) / Math.PI) * 10));
}

function setControlsEnabled(on) {
  for (const n of [el.zoom, el.rot, el.guides, el.refit, el.change, el.download]) n.disabled = !on;
  el.whiten.disabled = !on || !vision || !state || state.visionFailed;
  el.whitenHint.textContent =
    state && state.visionFailed
      ? "Indisponível porque o detector automático não carregou."
      : "Troca o fundo por branco liso. Confira as bordas do cabelo.";
}

// ---------- conferência ----------

const ICONS = {
  ok: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor"/><path d="M6 10.4l2.6 2.6L14.2 7.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8l8.6 15.4H1.4z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 7.2v4.6" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.15" fill="#fff"/></svg>',
  fail: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor"/><path d="M6.8 6.8l6.4 6.4M13.2 6.8l-6.4 6.4" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
};
const SR = { ok: "Certo: ", warn: "Atenção: ", fail: "Corrigir: " };

function buildChecks(m) {
  const items = [];
  const add = (s, t, v = "", d = "") => items.push({ s, t, v, d });
  if (state.visionFailed) {
    add("warn", "Detector automático indisponível", "", "Encaixe a cabeça no oval e os olhos na faixa azul.");
  } else if (state.noFace) {
    add("fail", "Nenhum rosto encontrado", "", "Encaixe a cabeça no oval e os olhos na faixa azul.");
  }
  if (m) {
    const f = state.face;
    const headOk = m.head >= SPEC.head.min && m.head <= SPEC.head.max;
    add(
      headOk ? "ok" : "fail",
      "Altura da cabeça",
      fmtPct(m.head),
      headOk
        ? "Exigido: de 50% a 69% da foto."
        : m.head < SPEC.head.min
          ? "Abaixo de 50%. Aumente o zoom."
          : "Acima de 69%. Diminua o zoom.",
    );
    const eyeOk = m.eyes >= SPEC.eyes.min && m.eyes <= SPEC.eyes.max;
    add(
      eyeOk ? "ok" : "fail",
      "Altura dos olhos",
      fmtPct(m.eyes),
      eyeOk
        ? "Medida a partir da base. Exigido: de 56% a 69%."
        : m.eyes < SPEC.eyes.min
          ? "Olhos baixos demais. Arraste a foto para cima."
          : "Olhos altos demais. Arraste a foto para baixo.",
    );
    const off = Math.abs(m.centerX - 0.5);
    add(off <= 0.04 ? "ok" : "warn", off <= 0.04 ? "Rosto centralizado" : "Rosto fora do centro", "", off <= 0.04 ? "" : "Arraste a foto para os lados.");
    const tilt = Math.abs(m.tiltDeg);
    add(tilt <= 2.5 ? "ok" : "warn", tilt <= 2.5 ? "Cabeça reta" : "Cabeça inclinada", tilt <= 2.5 ? "" : fmtDeg(m.tiltDeg), tilt <= 2.5 ? "" : "Ajuste a inclinação para nivelar os olhos.");
    if (f.yaw < 0.62 || f.yaw > 1.6) add("warn", "Rosto virado de lado", "", "Olhe direto para a câmera.");
    if (f.blink > 0.55) add("warn", "Olhos parecem fechados", "", "Os dois olhos precisam estar abertos.");
    if (f.smile > 0.75 || f.jawOpen > 0.35) add("warn", "Sorriso aberto", "", "Para visto, o pedido é expressão neutra.");
    if (f.topCut) add("warn", "Topo da cabeça cortado na foto original", "", "A altura da cabeça foi estimada. Se puder, use uma foto com espaço acima do cabelo.");
    else if (f.topEstimated) add("warn", "Topo do cabelo estimado", "", "Confira se a cabeça inteira aparece na foto.");
    if (f.multi) add("warn", "Mais de uma pessoa na foto", "", "Foi usado o maior rosto.");
    const res = state.view.L;
    if (res >= 500) add("ok", "Resolução boa");
    else if (res >= 360) add("warn", "Resolução baixa", "", "A foto pode ficar sem nitidez. Uma foto mais próxima ajuda.");
    else add("fail", "Resolução muito baixa", "", "Use uma foto mais próxima ou com mais pixels.");
  }
  if (state.bg && state.bg.known) {
    if (state.whiten) add("ok", "Fundo branco", "", "O fundo original foi trocado por branco.");
    else if (state.bg.light) add("ok", "Fundo claro e uniforme");
    else add("warn", "Fundo escuro ou colorido", "", "Ative Fundo branco ou use uma foto com parede clara.");
  }
  if (state.bg && state.bg.cutFrac > 0.04) {
    add("warn", "A foto original não cobre o quadro inteiro", "", "Parte do corpo aparece cortada em linha reta. Use uma foto com mais espaço em volta da cabeça e dos ombros.");
  } else if (!state.whiten && state.bg && state.bg.outsideFrac > 0.004 && !state.bg.light) {
    add("warn", "A foto não preenche o quadro", "", "A parte que falta ficou branca.");
  }
  return items;
}

function updateChecks(m) {
  let html;
  let summary;
  let tone;
  if (!state || busy) {
    html = '<li class="check is-idle">Envie uma foto para conferir as medidas.</li>';
    summary = "";
    tone = "";
  } else {
    const items = buildChecks(m);
    const fails = items.filter((i) => i.s === "fail").length;
    const warns = items.filter((i) => i.s === "warn").length;
    if (fails) {
      summary = fails === 1 ? "1 item precisa de ajuste." : `${fails} itens precisam de ajuste.`;
      tone = "fail";
    } else if (warns) {
      summary = "Medidas dentro do padrão. Veja os avisos.";
      tone = "warn";
    } else {
      summary = "Tudo dentro do padrão.";
      tone = "ok";
    }
    if (!m) {
      summary = "Confira o enquadramento pelas guias.";
      tone = fails ? "fail" : "warn";
    }
    html = items
      .map(
        (i) =>
          `<li class="check is-${i.s}">${ICONS[i.s]}<span class="t"><span class="sr">${SR[i.s]}</span>${i.t}</span>` +
          `<span class="v">${i.v}</span>${i.d ? `<span class="d">${i.d}</span>` : ""}</li>`,
      )
      .join("");
  }
  if (html !== lastChecksHtml) {
    el.checks.innerHTML = html;
    lastChecksHtml = html;
  }
  el.summary.textContent = summary;
  el.summary.dataset.tone = tone;
}

// ---------- interação ----------

function clampL(L) {
  return Math.min(state.baseL * 2, Math.max(state.baseL / 2, L));
}

function panBy(du, dv) {
  const v = state.view;
  const k = v.L / frameCss;
  const rx = -du * k;
  const ry = -dv * k;
  const c = Math.cos(v.theta);
  const s = Math.sin(v.theta);
  v.cx += c * rx - s * ry;
  v.cy += s * rx + c * ry;
}

function zoomAt(factor, u, w) {
  const v = state.view;
  const D = frameCss;
  const p = fromView(v, D, { x: u, y: w });
  const L = clampL(v.L / factor);
  const rx = ((u - D / 2) * L) / D;
  const ry = ((w - D / 2) * L) / D;
  const c = Math.cos(v.theta);
  const s = Math.sin(v.theta);
  v.cx = p.x - (c * rx - s * ry);
  v.cy = p.y - (s * rx + c * ry);
  v.L = L;
}

function changed() {
  requestRender();
  scheduleSettle();
}

const pointers = new Map();
let pinch = null;

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

function localPoint(e) {
  const r = el.canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * frameCss) / r.width, y: ((e.clientY - r.top) * frameCss) / r.height };
}

el.canvas.addEventListener("pointerdown", (e) => {
  if (!state || busy) return;
  el.canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localPoint(e));
  if (pointers.size === 2) pinch = pinchInfo();
  el.frame.classList.add("is-dragging");
});

el.canvas.addEventListener("pointermove", (e) => {
  if (!state || !pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const cur = localPoint(e);
  pointers.set(e.pointerId, cur);
  if (pointers.size === 1) {
    panBy(cur.x - prev.x, cur.y - prev.y);
  } else if (pointers.size === 2 && pinch) {
    const info = pinchInfo();
    panBy(info.mid.x - pinch.mid.x, info.mid.y - pinch.mid.y);
    zoomAt(info.dist / pinch.dist, info.mid.x, info.mid.y);
    pinch = info;
    syncSliders();
  }
  changed();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) el.frame.classList.remove("is-dragging");
}
el.canvas.addEventListener("pointerup", endPointer);
el.canvas.addEventListener("pointercancel", endPointer);

el.canvas.addEventListener(
  "wheel",
  (e) => {
    if (!state || busy) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? frameCss : 1;
    const p = localPoint(e);
    zoomAt(Math.exp(-e.deltaY * unit * 0.0015), p.x, p.y);
    syncSliders();
    changed();
  },
  { passive: false },
);

el.canvas.addEventListener("keydown", (e) => {
  if (!state || busy) return;
  const step = frameCss * (e.shiftKey ? 0.05 : 0.01);
  const keys = {
    ArrowLeft: () => panBy(-step, 0),
    ArrowRight: () => panBy(step, 0),
    ArrowUp: () => panBy(0, -step),
    ArrowDown: () => panBy(0, step),
    "+": () => zoomAt(1.02, frameCss / 2, frameCss / 2),
    "=": () => zoomAt(1.02, frameCss / 2, frameCss / 2),
    "-": () => zoomAt(1 / 1.02, frameCss / 2, frameCss / 2),
    "[": () => (state.view.theta += (0.5 * Math.PI) / 180),
    "]": () => (state.view.theta -= (0.5 * Math.PI) / 180),
  };
  const fn = keys[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
  syncSliders();
  changed();
});

el.canvas.addEventListener("click", () => {
  if (!state && !busy) el.file.click();
});

el.zoom.addEventListener("input", () => {
  if (!state) return;
  state.view.L = clampL(state.baseL / 2 ** (Number(el.zoom.value) / 100));
  changed();
});

el.rot.addEventListener("input", () => {
  if (!state) return;
  state.view.theta = state.auto.theta - ((Number(el.rot.value) / 10) * Math.PI) / 180;
  changed();
});

el.whiten.addEventListener("change", () => {
  if (!state) return;
  state.whiten = el.whiten.checked;
  ensureMask();
  requestRender();
});

el.guides.addEventListener("change", requestRender);

el.refit.addEventListener("click", () => {
  if (!state) return;
  state.view = { ...state.auto };
  el.zoom.value = "0";
  el.rot.value = "0";
  ensureMask();
  changed();
});

el.pick.addEventListener("click", (e) => {
  e.stopPropagation();
  el.file.click();
});
el.change.addEventListener("click", () => el.file.click());
el.file.addEventListener("change", () => {
  const f = el.file.files && el.file.files[0];
  el.file.value = "";
  processFile(f);
});

// arrastar e soltar em qualquer lugar da página
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  el.frame.classList.add("is-drop");
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.frame.classList.remove("is-drop");
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.frame.classList.remove("is-drop");
  const f = e.dataTransfer?.files?.[0];
  if (f) processFile(f);
});

document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) processFile(item.getAsFile());
});

// ---------- download ----------

el.download.addEventListener("click", async () => {
  if (!state || busy) return;
  el.download.disabled = true;
  try {
    ensureMask();
    const out = renderOutput(state.src, state.view, { whiten: state.whiten, mask: state.mask });
    const { blob, size } = await exportJpeg(out);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "foto-2x2.jpg";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    el.fileNote.textContent = `Arquivo salvo como foto-2x2.jpg: 600 × 600 pixels, 300 dpi, ${Math.max(1, Math.round(size / 1000))} kB.`;
  } catch (err) {
    console.error(err);
    el.fileNote.textContent = "Não foi possível gerar o arquivo. Tente de novo.";
  } finally {
    el.download.disabled = false;
  }
});

// ---------- tamanho do quadro ----------

function resize() {
  const w = el.frame.clientWidth;
  if (!w) return;
  frameCss = w;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(w * dpr);
  if (el.canvas.width !== px) {
    el.canvas.width = px;
    el.canvas.height = px;
  }
  drawRulers();
  render();
}

new ResizeObserver(resize).observe(el.frame);
window.addEventListener("resize", resize);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestRender());

setControlsEnabled(false);
setPhase("idle");
resize();
bootVision();

if (new URLSearchParams(location.search).has("debug")) {
  window.__foto2x2 = {
    get state() {
      return state;
    },
    get vision() {
      return visionState;
    },
    measure: () => (state && state.face ? measure(state.face, state.view) : null),
    maskDataUrl: () => (state && state.mask ? state.mask.canvas.toDataURL() : null),
  };
}
