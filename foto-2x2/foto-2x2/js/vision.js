// Detecção do rosto e segmentação pessoa/fundo com o MediaPipe Tasks Vision.
// Os modelos rodam no navegador; a foto nunca sai do aparelho.
import { applyInverseView, applyView, axes, fromView, onFaceAxis, toView } from "./photo.js";

const MP_VERSION = "1.1.1";
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const SEG_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let loading = null;

export function loadVision() {
  if (!loading) {
    loading = (async () => {
      const { FilesetResolver, FaceLandmarker, ImageSegmenter } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: "CPU" },
        runningMode: "IMAGE",
        numFaces: 4,
        outputFaceBlendshapes: true,
      });
      const segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEG_MODEL, delegate: "CPU" },
        runningMode: "IMAGE",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      return { landmarker, segmenter };
    })();
    loading.catch(() => {
      loading = null; // permite nova tentativa
    });
  }
  return loading;
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function runLandmarker(landmarker, canvas, mapPoint) {
  const res = landmarker.detect(canvas);
  return res.faceLandmarks.map((lms, i) => {
    const pts = lms.map((p) => mapPoint(p.x * canvas.width, p.y * canvas.height));
    const blend = {};
    for (const c of res.faceBlendshapes?.[i]?.categories || []) blend[c.categoryName] = c.score;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return { pts, blend, box: { x0, y0, x1, y1 }, area: (x1 - x0) * (y1 - y0) };
  });
}

// Proporções de um rosto de verdade: distância entre as íris comparada à
// distância olhos-queixo, e inclinação razoável da linha dos olhos.
function plausible(face) {
  const a = face.pts[468];
  const b = face.pts[473];
  const chin = face.pts[152];
  const ipd = Math.hypot(b.x - a.x, b.y - a.y);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const F = Math.hypot(chin.x - mid.x, chin.y - mid.y);
  if (!(ipd > 0 && F > 0)) return false;
  const ratio = ipd / F;
  const tilt = Math.abs((Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI);
  const chinBelow = chin.y > mid.y;
  return ratio > 0.32 && ratio < 0.85 && tilt < 40 && chinBelow;
}

// Procura rostos na imagem inteira; se não achar (rosto pequeno, foto de
// corpo inteiro), procura em recortes ampliados com um critério mais rígido,
// para não confundir objetos com rostos.
export async function detectFaces(landmarker, src) {
  const W = src.width;
  const H = src.height;
  const s = Math.min(1, 1280 / Math.max(W, H));
  const det = makeCanvas(W * s, H * s);
  det.getContext("2d").drawImage(src, 0, 0, det.width, det.height);
  let faces = runLandmarker(landmarker, det, (x, y) => ({ x: x / s, y: y / s })).filter(plausible);
  if (!faces.length && Math.max(W, H) >= 900) {
    const T = Math.round(Math.min(W, H) * 0.55);
    const step = Math.round(T / 2);
    const tiles = [];
    for (let y = 0; y + T <= H + step / 2; y += step) {
      for (let x = 0; x + T <= W + step / 2; x += step) {
        tiles.push({ x: Math.min(x, W - T), y: Math.min(y, H - T) });
      }
    }
    // linhas de cima primeiro, centro antes das bordas
    tiles.sort((a, b) => a.y - b.y || Math.abs(a.x + T / 2 - W / 2) - Math.abs(b.x + T / 2 - W / 2));
    const size = Math.min(768, T);
    const tile = makeCanvas(size, size);
    const tctx = tile.getContext("2d");
    await landmarker.setOptions({ minFaceDetectionConfidence: 0.8, minFacePresenceConfidence: 0.9 });
    try {
      for (const t of tiles.slice(0, 16)) {
        tctx.clearRect(0, 0, size, size);
        tctx.drawImage(src, t.x, t.y, T, T, 0, 0, size, size);
        const k = T / size;
        faces = runLandmarker(landmarker, tile, (x, y) => ({ x: t.x + x * k, y: t.y + y * k })).filter(plausible);
        if (faces.length) break;
      }
    } finally {
      await landmarker.setOptions({ minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5 });
    }
  }
  faces.sort((a, b) => b.area - a.area);
  return faces;
}

// Segmenta um quadrado da imagem (uma "vista") em 256 × 256 e devolve a
// confiança de "pessoa" por pixel. Áreas fora da foto entram como branco.
export function segmentView(segmenter, src, view, size = 256) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  applyView(ctx, view, size);
  ctx.drawImage(src, 0, 0);
  ctx.restore();
  const res = segmenter.segment(c);
  try {
    const m = res.confidenceMasks[0];
    return { data: new Float32Array(m.getAsFloat32Array()), w: m.width, h: m.height, view };
  } finally {
    res.close();
  }
}

// Topo da cabeça (incluindo o cabelo): a partir da testa, sobe por cada coluna
// da faixa do rosto enquanto o segmentador ainda vê "pessoa".
export function findHeadTop(segmenter, src, face) {
  const F = face.F;
  const side = 4.8 * F;
  const center = onFaceAxis(face, 0.2 * F);
  const view = { cx: center.x, cy: center.y, L: side, theta: face.alpha };
  const seg = segmentView(segmenter, src, view);
  const { data, w, h } = seg;
  const k = w / side;

  // quais pixels da máscara caem dentro da foto original
  const o = fromView(view, w, { x: 0.5, y: 0.5 });
  const ox = fromView(view, w, { x: 1.5, y: 0.5 });
  const oy = fromView(view, w, { x: 0.5, y: 1.5 });
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = o.x + (ox.x - o.x) * x + (oy.x - o.x) * y;
      const py = o.y + (ox.y - o.y) * x + (oy.y - o.y) * y;
      inside[y * w + x] = px >= 0 && py >= 0 && px < src.width && py < src.height ? 1 : 0;
    }
  }

  const eyeM = toView(view, w, face.E);
  const foreM = toView(view, w, face.forehead);
  const half = Math.max(2, Math.round(0.42 * F * k));
  const eyeRow = Math.max(0, Math.min(h - 1, Math.round(eyeM.y)));
  const startRow = Math.max(0, Math.min(eyeRow, Math.round(foreM.y)));
  const tops = [];
  let edgeHits = 0;
  for (let x = Math.round(eyeM.x - half); x <= Math.round(eyeM.x + half); x++) {
    if (x < 0 || x >= w) continue;
    let y = startRow;
    while (y < eyeRow && (!inside[y * w + x] || data[y * w + x] < 0.5)) y++;
    if (y >= eyeRow) continue;
    let top = y;
    let gap = 0;
    let hit = false;
    for (let yy = y - 1; yy >= -1; yy--) {
      if (yy < 0 || !inside[yy * w + x]) {
        hit = gap === 0;
        break;
      }
      if (data[yy * w + x] >= 0.5) {
        top = yy;
        gap = 0;
      } else if (++gap > 2) break;
    }
    if (hit) edgeHits++;
    tops.push(top);
  }
  if (tops.length < 3) return { topB: null, cut: false, seg };
  tops.sort((a, b) => a - b);
  const topM = tops[Math.floor(tops.length * 0.1)];
  const p = fromView(view, w, { x: eyeM.x, y: topM });
  const { ey } = axes(face.alpha);
  const topB = (p.x - face.E.x) * ey.x + (p.y - face.E.y) * ey.y;
  return { topB, cut: edgeHits >= Math.max(2, tops.length * 0.25), seg };
}

// Fundo claro e uniforme? Analisa só os pixels que o segmentador marcou como
// fundo e que estão dentro da foto original.
export function analyzeBackground(src, view, mask) {
  const N = 160;
  const pic = makeCanvas(N, N);
  const pctx = pic.getContext("2d", { willReadFrequently: true });
  pctx.save();
  applyView(pctx, view, N);
  pctx.drawImage(src, 0, 0);
  pctx.restore();
  const cover = makeCanvas(N, N);
  const cctx = cover.getContext("2d", { willReadFrequently: true });
  cctx.save();
  applyView(cctx, view, N);
  cctx.fillStyle = "#000";
  cctx.fillRect(0, 0, src.width, src.height);
  cctx.restore();
  const alpha = makeCanvas(N, N);
  const actx = alpha.getContext("2d", { willReadFrequently: true });
  actx.save();
  applyView(actx, view, N);
  applyInverseView(actx, mask.view, mask.canvas.width);
  actx.drawImage(mask.canvas, 0, 0);
  actx.restore();
  const P = pctx.getImageData(0, 0, N, N).data;
  const C = cctx.getImageData(0, 0, N, N).data;
  const A = actx.getImageData(0, 0, N, N).data;
  let n = 0, sum = 0, sum2 = 0, chroma = 0, outside = 0, cutEdge = 0;
  for (let i = 0; i < N * N; i++) {
    const j = i * 4;
    if (C[j + 3] < 250) {
      outside++;
      continue;
    }
    if (A[j + 3] > 20) {
      // pessoa encostada na borda da foto original, dentro do quadro
      if (A[j + 3] > 128) {
        const x = i % N;
        const y = (i - x) / N;
        const out = (xx, yy) => xx >= 0 && yy >= 0 && xx < N && yy < N && C[(yy * N + xx) * 4 + 3] < 128;
        if (out(x - 1, y) || out(x + 1, y) || out(x, y - 1) || out(x, y + 1)) cutEdge++;
      }
      continue;
    }
    const r = P[j], g = P[j + 1], b = P[j + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += lum;
    sum2 += lum * lum;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
    n++;
  }
  const outsideFrac = outside / (N * N);
  const cutFrac = cutEdge / N;
  if (n < N * N * 0.03) return { known: false, outsideFrac, cutFrac };
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const chr = chroma / n;
  return {
    known: true,
    mean,
    std,
    chroma: chr,
    light: mean >= 212 && chr <= 28 && std <= 26,
    outsideFrac,
    cutFrac,
  };
}
