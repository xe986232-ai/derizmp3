// Record Mode: card pattern (kotak berwarna di timeline) bisa diangkat, dibawa bebas ke mana saja, dan digoyang (rotasi saja, tanpa melar).
// Cara pakai: klik + TAHAN pattern (350ms, jangan geser) -> terangkat jadi overlay -> bawa ke mana saja -> lepas -> memantul balik.
// Geser cepat tanpa menahan tetap memindah pattern kiri-kanan seperti biasa (logika di main.ts).
// Yang digoyang adalah SALINAN visual (clone) di <body>; pattern aslinya tetap di lane tapi disembunyikan (muncul lagi saat salinan mendarat),
// sehingga data, jadwal audio, dan riwayat undo tidak tersentuh.
import { POS_DRAG, POS_FREE, ROT, HOLD_MS, HOLD_SLOP, MAX_TILT, LIFT, REDUCE } from './record-jelly';

export function initPatternJelly(lanesEl: HTMLElement): void {
  const root = document.documentElement;
  const recOn = (): boolean => root.dataset.rec === 'on';

  let src: HTMLElement | null = null;     // pattern asli (di lane)
  let card: HTMLElement | null = null;    // salinan yang bergerak
  let layer: HTMLElement | null = null;
  let raf = 0, last = 0, holdTimer = 0;
  let pointerId = -1, held = false, pending = false, suppressClick = false;
  let x = 0, y = 0, vx = 0, vy = 0, rot = 0, rv = 0, lift = 1;
  let tx = 0, ty = 0, p0x = 0, p0y = 0, lx = 0, ly = 0;
  let gx = 0, gy = 0;
  let nat = { l: 0, t: 0, r: 0, b: 0 };

  function measureNatural(): void {
    if (!card) return;
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2 - x, cy = r.top + r.height / 2 - y;
    const w = card.offsetWidth, h = card.offsetHeight;
    nat = { l: cx - w / 2, t: cy - h / 2, r: cx + w / 2, b: cy + h / 2 };
  }
  function clampTarget(): void {
    const vw = root.clientWidth, vh = window.innerHeight, m = 6;
    tx = Math.min(Math.max(tx, Math.min(m - nat.l, 0)), Math.max(vw - m - nat.r, 0));
    ty = Math.min(Math.max(ty, Math.min(m - nat.t, 0)), Math.max(vh - m - nat.b, 0));
  }

  function start(): void {
    if (!src) return;
    const r = src.getBoundingClientRect();
    card = src.cloneNode(true) as HTMLElement;
    card.querySelector('.pattern__handle')?.remove();
    card.classList.remove('is-selected', 'is-dragging', 'is-settling');
    card.classList.add('is-jelly');
    const s = card.style;
    s.animation = 'none'; s.transition = 'none';
    s.position = 'fixed'; s.left = r.left + 'px'; s.top = r.top + 'px';
    s.width = r.width + 'px'; s.height = r.height + 'px';
    s.margin = '0'; s.zIndex = '450'; s.pointerEvents = 'none';
    s.transformOrigin = 'center center';
    const lane = src.parentElement as HTMLElement;
    const col = lane.style.getPropertyValue('--track-color');
    layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none';
    if (col) layer.style.setProperty('--track-color', col);
    layer.appendChild(card);
    document.body.appendChild(layer);
    src.classList.add('is-jelly-src');
    root.classList.add('is-pat-jelly');
    last = performance.now();
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function finish(): void {
    clearTimeout(holdTimer); holdTimer = 0;
    cancelAnimationFrame(raf); raf = 0;
    if (layer) { layer.remove(); layer = null; }
    if (src) src.classList.remove('is-jelly-src');
    root.classList.remove('is-pat-jelly');
    src = card = null;
    x = y = vx = vy = rot = rv = 0; lift = 1;
    held = pending = false; pointerId = -1;
  }

  function step(dt: number): void {
    const P = held ? POS_DRAG : POS_FREE;
    const ox = held ? tx : 0, oy = held ? ty : 0;
    vx += (P.k * (ox - x) - P.c * vx) * dt;
    vy += (P.k * (oy - y) - P.c * vy) * dt;
    x += vx * dt; y += vy * dt;
    const sign = gy >= 0 ? 1 : -1;
    const tilt = held ? Math.max(-MAX_TILT, Math.min(MAX_TILT, vx * 0.014 * sign + vy * 0.01 * gx * -1)) : 0;
    rv += (ROT.k * (tilt - rot) - ROT.c * rv) * dt;
    rot += rv * dt;
    lift += ((held ? LIFT : 1) - lift) * Math.min(1, dt * 14);
  }

  function paint(): void {
    if (!card) return;
    // hanya posisi + rotasi (goyang miring), tanpa melar/memipih; scale hanya efek "terangkat"
    card.style.transform =
      'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) rotate(' + rot.toFixed(2) + 'deg) scale(' + lift.toFixed(4) + ')';
  }

  function tick(now: number): void {
    raf = 0;
    if (!card) return;
    const dt = Math.min((now - last) / 1000, 1 / 30); last = now;
    for (let i = 0; i < 2; i++) step(dt / 2);
    if (held) { measureNatural(); clampTarget(); }
    paint();
    if (!held && Math.abs(x) < 0.15 && Math.abs(y) < 0.15 && Math.abs(vx) < 1 && Math.abs(vy) < 1 && Math.abs(rot) < 0.1 && Math.abs(rv) < 1) { finish(); return; }
    raf = requestAnimationFrame(tick);
  }

  function pickUp(): void {
    if (!pending || !src) return;
    pending = false; held = true; suppressClick = true;
    p0x = lx; p0y = ly; tx = x; ty = y;
    try { navigator.vibrate?.(12); } catch { /* abaikan */ }
    start(); measureNatural();
    if (REDUCE) paint();
  }

  lanesEl.addEventListener('pointerdown', e => {
    if (!recOn() || e.button > 0 || pointerId !== -1) return;
    const t = e.target as HTMLElement;
    const el = t.closest('.pattern') as HTMLElement | null;
    if (!el || t.closest('.pattern__handle') || t.isContentEditable) return;
    if (card) finish();
    src = el; pointerId = e.pointerId; pending = true; held = false;
    p0x = lx = e.clientX; p0y = ly = e.clientY;
    const r = el.getBoundingClientRect();
    gx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
    gy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(pickUp, HOLD_MS);
  });

  document.addEventListener('pointermove', e => {
    if (e.pointerId !== pointerId || !src) return;
    lx = e.clientX; ly = e.clientY;
    if (pending) {
      // geser sebelum waktunya (atau pattern sudah mulai digeser kiri-kanan oleh main.ts) = bukan tahan
      if (Math.hypot(lx - p0x, ly - p0y) > Math.min(HOLD_SLOP, 4) || src.classList.contains('is-dragging')) {
        clearTimeout(holdTimer); holdTimer = 0; pending = false; pointerId = -1; src = null;
      }
      return;
    }
    if (!held) return;
    e.preventDefault();
    tx = (lx - p0x); ty = (ly - p0y);
    if (REDUCE) { clampTarget(); x = tx; y = ty; vx = vy = rot = rv = 0; paint(); }
  });

  const release = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    clearTimeout(holdTimer); holdTimer = 0;
    pointerId = -1;
    if (pending) { pending = false; src = null; return; }
    held = false;
    if (REDUCE) { finish(); return; }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
    setTimeout(() => { suppressClick = false; }, 0);
  };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);

  lanesEl.addEventListener('click', e => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);

  document.addEventListener('contextmenu', e => {
    const t = e.target as HTMLElement | null;
    if (card || (recOn() && t && t.closest && t.closest('.pattern'))) e.preventDefault();
  }, true);
  document.addEventListener('selectstart', e => { if (card) e.preventDefault(); }, true);
  document.addEventListener('touchmove', e => { if (held && e.cancelable) e.preventDefault(); }, { passive: false });

  document.addEventListener('recmodechange', () => { if (!recOn() && card) finish(); });
  // pattern asli dihapus / diganti (undo, hapus) saat sedang goyang -> hentikan
  new MutationObserver(() => { if (src && !src.isConnected) finish(); }).observe(lanesEl, { childList: true, subtree: true });
}
