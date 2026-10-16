// Shared page layout and degradation used by gen.mjs (step 1) and gen2.mjs (step 2). Runs in the page via evaluate.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


export // Runs in the page: lays out one page and returns its ground-truth text in reading order.
function renderPage({ spec, cat, W, H }) {
  document.body.innerHTML = '';
  const page = document.createElement('div');
  page.style.cssText =
    'width:' +
    W +
    'px;height:' +
    H +
    'px;box-sizing:border-box;padding:170px 165px;background:#fff;color:#111;font-family:"' +
    spec.font +
    '";font-size:' +
    spec.fontSize +
    'px;line-height:1.75;overflow:hidden;position:relative';
  document.body.appendChild(page);
  const h = document.createElement('div');
  h.textContent = spec.title;
  h.style.cssText = 'font-size:52px;font-weight:600;text-align:center;margin-bottom:46px';
  page.appendChild(h);
  const gt = [spec.title];
  const limit = H - 170;
  function fill(container, maxBottom) {
    let p = document.createElement('p');
    p.style.cssText = 'margin:0 0 18px 0;text-indent:2em;text-align:justify';
    container.appendChild(p);
    let paraText = '';
    const out = [];
    for (let i = 0; i < spec.stream.length; i++) {
      const s = spec.stream[i];
      const before = p.textContent;
      p.textContent = before + s;
      if (container.getBoundingClientRect().top + container.scrollHeight > maxBottom || p.getBoundingClientRect().bottom > maxBottom) {
        p.textContent = before;
        if (!before) p.remove();
        break;
      }
      paraText = p.textContent;
      if (spec.paraBreaks[i]) {
        out.push(paraText);
        paraText = '';
        p = document.createElement('p');
        p.style.cssText = 'margin:0 0 18px 0;text-indent:2em;text-align:justify';
        container.appendChild(p);
      }
    }
    if (paraText) out.push(paraText);
    return out;
  }
  if (cat === 'two_column') {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:70px';
    page.appendChild(row);
    const top = row.getBoundingClientRect().top;
    const cols = [0, 1].map(() => {
      const c = document.createElement('div');
      c.style.cssText = 'flex:1;height:' + (limit - top) + 'px;overflow:hidden';
      row.appendChild(c);
      return c;
    });
    gt.push(...fill(cols[0], limit));
    spec.stream = spec.stream.slice(37).concat(spec.stream.slice(0, 37));
    gt.push(...fill(cols[1], limit));
  } else if (cat === 'table') {
    const intro = document.createElement('div');
    page.appendChild(intro);
    spec.stream = spec.stream.slice(0, 3);
    gt.push(...fill(intro, limit));
    const t = document.createElement('table');
    t.style.cssText = 'border-collapse:collapse;width:100%;margin-top:20px;font-size:28px';
    spec.table.forEach((row, ri) => {
      const tr = document.createElement('tr');
      row.forEach((cell) => {
        const td = document.createElement(ri ? 'td' : 'th');
        td.textContent = cell;
        td.style.cssText = 'border:2px solid #222;padding:10px 12px;text-align:left' + (ri ? '' : ';background:#eee');
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    page.appendChild(t);
    while (t.getBoundingClientRect().bottom > limit && t.rows.length > 2) {
      t.deleteRow(t.rows.length - 1);
      spec.table.pop();
    }
    spec.table.forEach((row) => gt.push(row.join(' ')));
  } else {
    const body = document.createElement('div');
    page.appendChild(body);
    gt.push(...fill(body, limit));
  }
  return gt.join('\n');
}


export // Runs in the page: applies one degradation recipe on a canvas and returns a JPEG.
async function degrade({ png, d, seed }) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = 0,
      v = 0;
    while (!u) u = r();
    while (!v) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
  const w = Math.round(img.width * d.scale),
    h = Math.round(img.height * d.scale);
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d');
  x.fillStyle = d.tint ? '#d9d4c8' : '#f4f4f2';
  x.fillRect(0, 0, w, h);
  x.translate(w / 2, h / 2);
  x.rotate((d.rot * Math.PI) / 180);
  x.translate(-w / 2, -h / 2);
  if (d.blur) x.filter = 'blur(' + d.blur + 'px)';
  x.drawImage(img, 0, 0, w, h);
  x.filter = 'none';
  x.setTransform(1, 0, 0, 1, 0, 0);
  if (d.light) {
    const g = x.createRadialGradient(w * (0.3 + 0.4 * r()), h * (0.3 + 0.3 * r()), w * 0.1, w / 2, h / 2, Math.hypot(w, h) * 0.7);
    g.addColorStop(0, 'rgba(255,250,235,1)');
    g.addColorStop(
      1,
      'rgba(' + Math.round(255 * (1 - d.light)) + ',' + Math.round(250 * (1 - d.light)) + ',' + Math.round(230 * (1 - d.light)) + ',1)',
    );
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'source-over';
  }
  const im = x.getImageData(0, 0, w, h);
  const p = im.data;
  for (let i = 0; i < p.length; i += 4) {
    const n = gauss() * d.noise;
    let sp = 0;
    if (d.sp && r() < d.sp) sp = r() < 0.5 ? -255 : 255;
    for (let k = 0; k < 3; k++) p[i + k] = Math.max(0, Math.min(255, p[i + k] + n + sp));
  }
  x.putImageData(im, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: d.q });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { jpg: btoa(bin), w, h };
}
