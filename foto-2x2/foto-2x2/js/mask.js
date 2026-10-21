// Máscara de recorte pessoa/fundo com borda refinada.
// O segmentador devolve 256 × 256 pontos de confiança. Aqui a confiança é
// ampliada e passa por um filtro guiado pelas cores da própria foto
// (He, Sun e Tang, "Guided Image Filtering"), que encaixa o contorno nas
// bordas reais do cabelo, das orelhas e da roupa. O filtro só age numa faixa
// estreita em volta do contorno, para não abrir buracos na roupa nem criar
// manchas no fundo.
import { applyView } from "./photo.js";

const SIZE = 640;

function smoothstep(lo, hi, x) {
  const t = (x - lo) / (hi - lo);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// Média em janela quadrada (2r + 1)², separável, com bordas repetidas.
// As duas passadas percorrem a memória em ordem de linha.
let colSum = new Float64Array(0);
function boxBlur(src, out, tmp, n, r) {
  const inv = 1 / (2 * r + 1);
  const last = n - 1;
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const first = src[row];
    const end = src[row + last];
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += k <= 0 ? first : k >= last ? end : src[row + k];
    for (let x = 0; x < n; x++) {
      tmp[row + x] = acc * inv;
      const a = x + r + 1;
      const s = x - r;
      acc += (a < last ? src[row + a] : end) - (s > 0 ? src[row + s] : first);
    }
  }
  if (colSum.length !== n) colSum = new Float64Array(n);
  colSum.fill(0);
  for (let k = -r; k <= r; k++) {
    const row = Math.min(n - 1, Math.max(0, k)) * n;
    for (let x = 0; x < n; x++) colSum[x] += tmp[row + x];
  }
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const addRow = Math.min(n - 1, y + r + 1) * n;
    const subRow = Math.max(0, y - r) * n;
    for (let x = 0; x < n; x++) {
      out[row + x] = colSum[x] * inv;
      colSum[x] += tmp[addRow + x] - tmp[subRow + x];
    }
  }
}

function guidedFilterColor(R, G, B, p, n, r, eps) {
  const N = n * n;
  const arr = () => new Float32Array(N);
  const tmp = arr();
  const prod = arr();
  const mR = arr(), mG = arr(), mB = arr(), mP = arr();
  boxBlur(R, mR, tmp, n, r);
  boxBlur(G, mG, tmp, n, r);
  boxBlur(B, mB, tmp, n, r);
  boxBlur(p, mP, tmp, n, r);
  const boxOf = (a, b, out) => {
    for (let i = 0; i < N; i++) prod[i] = a[i] * b[i];
    boxBlur(prod, out, tmp, n, r);
    return out;
  };
  const cR = boxOf(R, p, arr()), cG = boxOf(G, p, arr()), cB = boxOf(B, p, arr());
  const vRR = boxOf(R, R, arr()), vRG = boxOf(R, G, arr()), vRB = boxOf(R, B, arr());
  const vGG = boxOf(G, G, arr()), vGB = boxOf(G, B, arr()), vBB = boxOf(B, B, arr());
  for (let i = 0; i < N; i++) {
    const mr = mR[i], mg = mG[i], mb = mB[i], mp = mP[i];
    const cr = cR[i] - mr * mp, cg = cG[i] - mg * mp, cb = cB[i] - mb * mp;
    const rr = vRR[i] - mr * mr + eps, rg = vRG[i] - mr * mg, rb = vRB[i] - mr * mb;
    const gg = vGG[i] - mg * mg + eps, gb = vGB[i] - mg * mb, bb = vBB[i] - mb * mb + eps;
    const iRR = gg * bb - gb * gb, iRG = gb * rb - rg * bb, iRB = rg * gb - gg * rb;
    const iGG = rr * bb - rb * rb, iGB = rb * rg - rr * gb, iBB = rr * gg - rg * rg;
    const det = rr * iRR + rg * iRG + rb * iRB;
    const aR = (iRR * cr + iRG * cg + iRB * cb) / det;
    const aG = (iRG * cr + iGG * cg + iGB * cb) / det;
    const aB = (iRB * cr + iGB * cg + iBB * cb) / det;
    cR[i] = aR;
    cG[i] = aG;
    cB[i] = aB;
    vRR[i] = mp - aR * mr - aG * mg - aB * mb;
  }
  boxBlur(cR, vRG, tmp, n, r);
  boxBlur(cG, vRB, tmp, n, r);
  boxBlur(cB, vGG, tmp, n, r);
  boxBlur(vRR, vGB, tmp, n, r);
  const q = vBB;
  for (let i = 0; i < N; i++) q[i] = vRG[i] * R[i] + vRB[i] * G[i] + vGG[i] * B[i] + vGB[i];
  return q;
}

// conf: confiança 256 × 256 do segmentador para a vista "region".
export function buildMask(src, region, conf, w, h, size = SIZE) {
  const n = size;
  const N = n * n;
  const guide = document.createElement("canvas");
  guide.width = guide.height = n;
  const gctx = guide.getContext("2d", { willReadFrequently: true });
  gctx.fillStyle = "#ffffff";
  gctx.fillRect(0, 0, n, n);
  gctx.imageSmoothingEnabled = true;
  gctx.imageSmoothingQuality = "high";
  gctx.save();
  applyView(gctx, region, n);
  gctx.drawImage(src, 0, 0);
  gctx.restore();
  const px = gctx.getImageData(0, 0, n, n).data;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    R[i] = px[i * 4] / 255;
    G[i] = px[i * 4 + 1] / 255;
    B[i] = px[i * 4 + 2] / 255;
  }

  // confiança ampliada (bilinear) e cortada com transição suave
  const p0 = new Float32Array(N);
  const sx = n / w;
  const sy = n / h;
  for (let y = 0; y < n; y++) {
    const fy = (y + 0.5) / sy - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < n; x++) {
      const fx = (x + 0.5) / sx - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0));
      const top = conf[y0 * w + x0] * (1 - tx) + conf[y0 * w + x1] * tx;
      const bot = conf[y1 * w + x0] * (1 - tx) + conf[y1 * w + x1] * tx;
      p0[y * n + x] = smoothstep(0.4, 0.8, top * (1 - ty) + bot * ty);
    }
  }

  const k = n / 768;
  const q = guidedFilterColor(R, G, B, p0, n, Math.max(2, Math.round(6 * k)), 1e-3);
  const near = new Float32Array(N);
  const tmp = new Float32Array(N);
  boxBlur(p0, near, tmp, n, Math.max(3, Math.round(8 * k)));

  const out = gctx.createImageData(n, n);
  const d = out.data;
  for (let i = 0; i < N; i++) {
    let a = smoothstep(0.2, 0.8, q[i]);
    const m = near[i];
    const low = smoothstep(0.97, 0.995, m);
    const high = smoothstep(0.005, 0.03, m);
    if (a < low) a = low;
    if (a > high) a = high;
    const j = i * 4;
    d[j] = 255;
    d[j + 1] = 255;
    d[j + 2] = 255;
    d[j + 3] = Math.round(a * 255);
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = n;
  canvas.getContext("2d").putImageData(out, 0, 0);
  return canvas;
}
