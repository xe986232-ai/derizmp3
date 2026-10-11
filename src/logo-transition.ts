// Transisi logo Melvox (animasi logo v11) yang diputar menutupi layar saat Gaya UI diganti Default <-> Flat.
// Alur: overlay fade-in cepat -> gaya UI diganti saat layar sudah tertutup (callback `swap`) -> animasi logo jalan sampai
// tile membanjiri layar -> overlay fade-out. Tap overlay = lewati. Gerak dikurangi (prefers-reduced-motion) = ganti langsung tanpa animasi.
// Warna ikut gaya UI: latar = warna gaya lama, tile (yang membanjiri layar) = warna latar gaya baru, batang M = teks gaya baru, bar & titik = aksen gaya baru,
// jadi akhir flood sama persis dengan latar UI baru dan fade-out nyaris tak terlihat.
// Isi animasi (seek) disalin dari melvox-logo-animation-v11-916.html; bedanya hanya viewBox menyesuaikan rasio layar & flood diperbesar.

import type { Swatch } from './ui-theme';

const END = 2.7;              // overlay berhenti di akhir flood (c = 2.7)
const FADE_IN = 0.18;         // detik: overlay muncul, ganti gaya dilakukan setelah ini
const FADE_OUT = 0.32;        // detik: overlay hilang setelah animasi selesai
const K = 300 / 512;          // lebar tile = 300 dari 540
const BARS = [{ cx: 292, cy: 253, h: 102 }, { cx: 350, cy: 256, h: 192 }, { cx: 405, cy: 257, h: 280 }];

const clamp = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const prog = (c: number, a: number, d: number): number => clamp((c - a) / d);
const outQ = (x: number): number => 1 - Math.pow(1 - x, 4);
const inC = (x: number): number => x * x * x;
const ioC = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

let running = false;
export const isLogoTransitionRunning = (): boolean => running;

const reducedMotion = (): boolean => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// Putar transisi. `from` = warna gaya lama, `to` = warna gaya baru. `swap` dipanggil tepat satu kali, saat layar tertutup overlay. Mengembalikan false kalau transisi sedang jalan (swap tidak dipanggil).
export function playLogoTransition(swap: () => void, from: Swatch, to: Swatch): boolean {
  if (running) return false;
  if (reducedMotion()) { swap(); return true; }
  running = true;

  const root = document.createElement('div');
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;opacity:0;touch-action:none;cursor:pointer;background:' + from.bg + ';';
  root.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block" preserveAspectRatio="xMidYMid meet">' +
      '<defs><clipPath id="mlx-clip"><rect width="512" height="512" rx="112"/></clipPath></defs>' +
      '<rect data-r="bg" x="-6000" y="-6000" width="12540" height="12960" fill="' + from.bg + '"/>' +
      '<g data-r="gTile">' +
        '<rect data-r="tile" width="512" height="512" rx="112" fill="' + to.bg + '"/>' +
        '<g clip-path="url(#mlx-clip)">' +
          '<rect data-r="stem" x="88" y="118" width="32" height="280" rx="16" fill="' + to.text + '"/>' +
          '<g transform="rotate(43.1 182 207)"><rect data-r="diag" x="59.1" y="191" width="245.8" height="32" rx="16" fill="' + to.text + '"/></g>' +
          '<g data-r="bars"><rect data-r="b0" fill="' + to.accent + '"/><rect data-r="b1" fill="' + to.accent + '"/><rect data-r="b2" fill="' + to.accent + '"/></g>' +
        '</g>' +
      '</g>' +
      '<g data-r="gDot"><rect data-r="dot" width="512" height="512" rx="112" fill="' + to.accent + '"/></g>' +
    '</svg>';

  const q = (n: string): SVGElement => root.querySelector('[data-r="' + n + '"]') as SVGElement;
  const svg = root.querySelector('svg') as SVGSVGElement;
  const el = { gTile: q('gTile'), stem: q('stem'), diag: q('diag'), bars: q('bars'), gDot: q('gDot'), b: [q('b0'), q('b1'), q('b2')] };

  // viewBox mengikuti rasio layar: area 540x960 (pusat 270,480) selalu muat utuh, sisanya diperluas supaya flood menutup seluruh layar
  let flood = 5;
  const fit = (): void => {
    const W = Math.max(1, window.innerWidth), H = Math.max(1, window.innerHeight), a = W / H;
    let vw = 540, vh = 960;
    if (a >= 540 / 960) vw = 960 * a; else vh = 540 / a;
    svg.setAttribute('viewBox', (270 - vw / 2).toFixed(1) + ' ' + (480 - vh / 2).toFixed(1) + ' ' + vw.toFixed(1) + ' ' + vh.toFixed(1));
    flood = Math.max(5, (Math.hypot(vw, vh) * 1.2) / 300);   // skala akhir tile supaya pasti menutup layar (termasuk sudut membulat)
  };
  fit();

  const G = (s: number): string => 'translate(270 480) scale(' + (K * s).toFixed(4) + ') translate(-256 -256)';

  const seek = (t: number): void => {
    const c = Math.min(t, END);
    // tile tumbuh dari titik, lalu di akhir membesar sampai memenuhi layar
    const isFlood = c >= 2.55;
    let s: number;
    if (!isFlood) s = c < 0.4 ? 0.1 + 0.9 * outQ(c / 0.4) : 1;
    else s = 1 + (flood - 1) * inC(prog(c, 2.55, 0.15));
    el.gTile.setAttribute('transform', G(s));

    // semua batang (M + 3 bar) tumbuh serentak: kurva sama, tanpa overshoot proporsional (pantulan kecil sama dalam piksel), napas sama
    const uE = prog(c, 0.4, 0.5), gBase = outQ(uE);
    const pop = 7 * Math.sin(Math.PI * uE) * (1 - uE) * 2.7;
    const e = inC(prog(c, 1.5, 0.25));
    const grow = Math.max(0, 1 - e);
    const u = prog(c, 1.0, 0.6), breath = 1 - 0.1 * Math.sin(Math.PI * u);
    const Ls = Math.max(0, (280 * gBase + pop) * grow * breath);
    const Wd = Math.max(0, (245.8 * gBase + pop) * grow * breath);
    el.stem.setAttribute('display', Ls < 1 ? 'none' : 'inline');
    el.stem.setAttribute('y', (258 - Ls / 2).toFixed(2));
    el.stem.setAttribute('height', Ls.toFixed(2));
    el.diag.setAttribute('display', Wd < 1 ? 'none' : 'inline');
    el.diag.setAttribute('x', (182 - Wd / 2).toFixed(2));
    el.diag.setAttribute('width', Wd.toFixed(2));

    // bar pink: tumbuh bareng, lalu menyatu & jadi titik
    const conv = ioC(prog(c, 1.75, 0.3)), shr = ioC(prog(c, 2.05, 0.35));
    el.bars.setAttribute('display', isFlood ? 'none' : 'inline');
    BARS.forEach((b, i) => {
      const L = Math.max(0, (b.h * gBase + pop) * breath);
      const cx = lerp(b.cx, 256, conv), cy = lerp(b.cy, 256, conv);
      const h = lerp(L, 34, shr);
      const r = el.b[i];
      r.setAttribute('display', L < 1 && shr === 0 ? 'none' : 'inline');
      r.setAttribute('x', (cx - 17).toFixed(2));
      r.setAttribute('y', (cy - h / 2).toFixed(2));
      r.setAttribute('width', '34');
      r.setAttribute('height', h.toFixed(2));
      r.setAttribute('rx', lerp(17, 7.4, shr).toFixed(2));
    });

    // titik aksen menyusut hilang ke dalam banjir warna (akhir animasi = layar polos berwarna latar gaya baru)
    el.gDot.setAttribute('display', isFlood ? 'inline' : 'none');
    el.gDot.setAttribute('transform', G(lerp(34 / 512, 0, inC(prog(c, 2.55, 0.15)))));
  };

  seek(0);
  document.body.appendChild(root);
  window.addEventListener('resize', fit);

  let raf = 0, swapped = false, finished = false, t0 = 0;
  const doSwap = (): void => { if (swapped) return; swapped = true; try { swap(); } catch (err) { console.error(err); } };

  const cleanup = (): void => {
    window.removeEventListener('resize', fit);
    root.remove();
    running = false;
  };
  const fadeOut = (dur: number): void => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    root.style.transition = 'opacity ' + dur + 's ease';
    root.style.opacity = '0';
    setTimeout(cleanup, dur * 1000 + 40);
  };

  // tap = lewati: ganti gaya kalau belum, langsung fade-out
  root.addEventListener('click', () => { doSwap(); fadeOut(0.18); });
  root.addEventListener('contextmenu', e => e.preventDefault());

  // fade-in singkat, lalu loop animasi
  requestAnimationFrame(() => {
    root.style.transition = 'opacity ' + FADE_IN + 's ease';
    root.style.opacity = '1';
  });
  const loop = (now: number): void => {
    if (finished) return;
    if (!t0) t0 = now;
    const t = (now - t0) / 1000;
    if (!swapped && t >= FADE_IN) doSwap();
    seek(t);
    if (t >= END) { doSwap(); fadeOut(FADE_OUT); return; }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return true;
}
