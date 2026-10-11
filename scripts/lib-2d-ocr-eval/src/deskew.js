// Projection-profile deskew: find the angle (±6°) that makes horizontal ink rows sharpest, then rotate.
export async function deskew(bytes, { range = 6, step = 0.1 } = {}) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const s = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s),
    h = Math.round(bmp.height * s);
  const small = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  small.drawImage(bmp, 0, 0, w, h);
  const px = small.getImageData(0, 0, w, h).data;
  // local-contrast ink mask (robust to uneven lighting): pixel darker than its row-block mean by 25%
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
  const ink = [];
  const B = 16;
  for (let by = 0; by < h; by += B)
    for (let bx = 0; bx < w; bx += B) {
      let sum = 0,
        n = 0;
      for (let y = by; y < Math.min(h, by + B); y++)
        for (let x = bx; x < Math.min(w, bx + B); x++) {
          sum += g[y * w + x];
          n++;
        }
      const t = (sum / n) * 0.75;
      for (let y = by; y < Math.min(h, by + B); y++)
        for (let x = bx; x < Math.min(w, bx + B); x++) if (g[y * w + x] < t) ink.push(x - w / 2, y - h / 2);
    }
  let best = 0,
    bestScore = -1;
  const bins = new Float64Array(h * 2);
  for (let a = -range; a <= range + 1e-9; a += step) {
    const r = (a * Math.PI) / 180,
      sn = Math.sin(r),
      cs = Math.cos(r);
    bins.fill(0);
    for (let i = 0; i < ink.length; i += 2) {
      const y = Math.round(ink[i] * sn + ink[i + 1] * cs + h);
      if (y >= 0 && y < bins.length) bins[y]++;
    }
    let sc = 0;
    for (let k = 1; k < bins.length; k++) {
      const d = bins[k] - bins[k - 1];
      sc += d * d;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  // rotate full-res by -best (positive best = content rotated clockwise in our convention)
  const out = new OffscreenCanvas(bmp.width, bmp.height);
  const x = out.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, bmp.width, bmp.height);
  x.translate(bmp.width / 2, bmp.height / 2);
  x.rotate((best * Math.PI) / 180);
  x.translate(-bmp.width / 2, -bmp.height / 2);
  x.drawImage(bmp, 0, 0);
  return { canvas: out, angle: best };
}
