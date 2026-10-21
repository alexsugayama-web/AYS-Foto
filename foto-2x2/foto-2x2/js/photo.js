// Geometria do enquadramento, renderização e exportação do JPEG.
// Tudo aqui é independente do detector: recebe pontos em pixels da imagem.

// Requisitos do Departamento de Estado dos EUA para a foto digital
// (travel.state.gov): quadrado de 600 a 1200 px, JPEG até 240 kB,
// cabeça (do topo do cabelo ao queixo) entre 50% e 69% da altura,
// olhos entre 56% e 69% da altura, medidos a partir da base.
export const SPEC = {
  outPx: 600, // 2 polegadas a 300 dpi
  dpi: 300,
  maxBytes: 240000,
  head: { min: 0.5, max: 0.69, target: 0.6 },
  eyes: { min: 0.56, max: 0.69, target: 0.625 },
  minTopMargin: 0.06,
};

export function axes(theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { ex: { x: c, y: s }, ey: { x: -s, y: c } };
}

// Uma "vista" é o quadrado recortado da imagem: centro (cx, cy) em pixels
// da imagem, lado L em pixels da imagem e rotação theta (radianos).
export function toView(view, size, p) {
  const dx = p.x - view.cx;
  const dy = p.y - view.cy;
  const c = Math.cos(view.theta);
  const s = Math.sin(view.theta);
  const k = size / view.L;
  return { x: (c * dx + s * dy) * k + size / 2, y: (-s * dx + c * dy) * k + size / 2 };
}

export function fromView(view, size, q) {
  const k = view.L / size;
  const rx = (q.x - size / 2) * k;
  const ry = (q.y - size / 2) * k;
  const c = Math.cos(view.theta);
  const s = Math.sin(view.theta);
  return { x: view.cx + c * rx - s * ry, y: view.cy + s * rx + c * ry };
}

export function applyView(ctx, view, size) {
  ctx.translate(size / 2, size / 2);
  ctx.scale(size / view.L, size / view.L);
  ctx.rotate(-view.theta);
  ctx.translate(-view.cx, -view.cy);
}

// Desfaz applyView para desenhar algo que foi gerado no espaço de outra vista
// (usado para posicionar a máscara de segmentação).
export function applyInverseView(ctx, view, size) {
  ctx.translate(view.cx, view.cy);
  ctx.rotate(view.theta);
  ctx.scale(view.L / size, view.L / size);
  ctx.translate(-size / 2, -size / 2);
}

// Medidas do rosto em coordenadas da imagem a partir dos 478 pontos do
// MediaPipe Face Landmarker. Íris: 468 e 473; queixo: 152; testa: 10;
// laterais do rosto: 234 e 454; ponta do nariz: 1.
export function faceGeometry(pts, blend) {
  const i1 = pts[468];
  const i2 = pts[473];
  const [left, right] = i1.x <= i2.x ? [i1, i2] : [i2, i1];
  const alpha = Math.atan2(right.y - left.y, right.x - left.x);
  const E = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const { ex, ey } = axes(alpha);
  const proj = (p) => ({
    a: (p.x - E.x) * ex.x + (p.y - E.y) * ex.y,
    b: (p.x - E.x) * ey.x + (p.y - E.y) * ey.y,
  });
  const chinB = proj(pts[152]).b;
  const foreB = proj(pts[10]).b;
  const a1 = proj(pts[234]).a;
  const a2 = proj(pts[454]).a;
  const aMin = Math.min(a1, a2);
  const aMax = Math.max(a1, a2);
  const noseA = proj(pts[1]).a;
  const yaw = (noseA - aMin) / Math.max(1, aMax - noseA);
  const score = (name) => (blend && typeof blend[name] === "number" ? blend[name] : 0);
  return {
    E,
    alpha,
    F: chinB, // distância olhos-queixo, a unidade de medida do rosto
    chinB,
    foreB,
    faceA: (a1 + a2) / 2,
    faceWidth: aMax - aMin,
    ipd: Math.hypot(right.x - left.x, right.y - left.y),
    yaw,
    blink: Math.max(score("eyeBlinkLeft"), score("eyeBlinkRight")),
    smile: (score("mouthSmileLeft") + score("mouthSmileRight")) / 2,
    jawOpen: score("jawOpen"),
    forehead: pts[10],
    chin: pts[152],
  };
}

// Ponto do eixo vertical do rosto a uma distância b dos olhos.
export function onFaceAxis(face, b) {
  const { ey } = axes(face.alpha);
  return { x: face.E.x + b * ey.x, y: face.E.y + b * ey.y };
}

// Enquadramento automático: cabeça com 60% da altura e olhos a 62,5% da base,
// garantindo uma folga mínima acima do cabelo.
export function autoView(face) {
  const H = face.chinB - face.topB;
  const L = H / SPEC.head.target;
  let eyeFromTop = 1 - SPEC.eyes.target;
  const topOut = eyeFromTop + face.topB / L;
  if (topOut < SPEC.minTopMargin) eyeFromTop += SPEC.minTopMargin - topOut;
  const maxEyeFromTop = 1 - SPEC.eyes.min - 0.005;
  if (eyeFromTop > maxEyeFromTop) eyeFromTop = maxEyeFromTop;
  const a0 = face.faceA * 0.5;
  const b0 = (0.5 - eyeFromTop) * L;
  const { ex, ey } = axes(face.alpha);
  return {
    cx: face.E.x + a0 * ex.x + b0 * ey.x,
    cy: face.E.y + a0 * ex.y + b0 * ey.y,
    L,
    theta: face.alpha,
  };
}

// Enquadramento padrão quando não há rosto: o maior quadrado central.
export function centerView(w, h) {
  const L = Math.min(w, h);
  return { cx: w / 2, cy: Math.min(h / 2, L / 2 + (h - L) * 0.2), L, theta: 0 };
}

export function measure(face, view) {
  const eye = toView(view, 1, face.E);
  const chin = toView(view, 1, onFaceAxis(face, face.chinB));
  const top = toView(view, 1, onFaceAxis(face, face.topB));
  return {
    head: chin.y - top.y,
    eyes: 1 - eye.y,
    top: top.y,
    chin: chin.y,
    centerX: eye.x,
    tiltDeg: ((face.alpha - view.theta) * 180) / Math.PI,
  };
}

const scratch = new Map();
function scratchCanvas(key, size) {
  let c = scratch.get(key);
  if (!c) {
    c = document.createElement("canvas");
    scratch.set(key, c);
  }
  if (c.width !== size || c.height !== size) {
    c.width = size;
    c.height = size;
  }
  return c;
}

// Desenha a vista em um canvas quadrado. Com "whiten", troca o fundo por
// branco usando a máscara de segmentação (que tem sua própria vista).
export function renderView(target, src, view, opts = {}) {
  const size = target.width;
  const ctx = target.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (!opts.whiten || !opts.mask) {
    applyView(ctx, view, size);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    return;
  }
  const layer = scratchCanvas(opts.scratchKey || "layer", size);
  const lctx = layer.getContext("2d");
  lctx.save();
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = "source-over";
  lctx.clearRect(0, 0, size, size);
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  applyView(lctx, view, size);
  lctx.drawImage(src, 0, 0);
  lctx.globalCompositeOperation = "destination-in";
  applyInverseView(lctx, opts.mask.view, opts.mask.canvas.width);
  lctx.drawImage(opts.mask.canvas, 0, 0);
  lctx.restore();
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

// Renderização final com redução em etapas (metade por vez), que preserva
// a nitidez melhor do que uma redução grande de uma só vez.
export function renderOutput(src, view, opts = {}) {
  const size = opts.size || SPEC.outPx;
  let steps = 0;
  while (view.L / (size * 2 ** (steps + 1)) > 1 && steps < 3) steps++;
  let current = document.createElement("canvas");
  current.width = current.height = size * 2 ** steps;
  renderView(current, src, view, { ...opts, scratchKey: "out" + current.width });
  while (current.width > size) {
    const next = document.createElement("canvas");
    next.width = next.height = current.width / 2;
    const nctx = next.getContext("2d");
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = "high";
    nctx.drawImage(current, 0, 0, next.width, next.height);
    current = next;
  }
  return current;
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob falhou"))), "image/jpeg", quality);
  });
}

// Grava 300 dpi no cabeçalho JFIF, para a foto sair com 2 × 2 polegadas
// quando impressa em "tamanho real".
export function setJpegDpi(bytes, dpi) {
  const b = bytes;
  const isJfif =
    b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] === 0xe0 &&
    b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0x00;
  if (isJfif) {
    const out = new Uint8Array(b);
    out[13] = 1;
    out[14] = dpi >> 8;
    out[15] = dpi & 0xff;
    out[16] = dpi >> 8;
    out[17] = dpi & 0xff;
    return out;
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const app0 = [
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
    0x01, dpi >> 8, dpi & 0xff, dpi >> 8, dpi & 0xff, 0x00, 0x00,
  ];
  const out = new Uint8Array(b.length + app0.length);
  out.set(b.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(b.subarray(2), 2 + app0.length);
  return out;
}

export async function exportJpeg(canvas) {
  let quality = 0.95;
  let blob = await toBlob(canvas, quality);
  while (blob.size > SPEC.maxBytes - 64 && quality > 0.5) {
    quality -= 0.05;
    blob = await toBlob(canvas, quality);
  }
  const bytes = setJpegDpi(new Uint8Array(await blob.arrayBuffer()), SPEC.dpi);
  return { blob: new Blob([bytes], { type: "image/jpeg" }), quality, size: bytes.length };
}
