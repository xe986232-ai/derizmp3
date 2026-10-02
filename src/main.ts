// @ts-nocheck
import { openAudioUploadCard } from './audio-upload-card';
import { initEffectsPanel } from './effects-panel';
import { initTrackMeters } from './track-meters';
import { initFxRack } from './fx-rack';
import { initLandscape } from './landscape';
import { initMenuPanel } from './menu-panel';
import { hasSynth, startVoice, releaseVoice, playNote, stopAllSynth } from './synth-engine';
import { click as metroClick, cancel as metroCancel } from './metronome-audio';
import { initMetronomePanel, BPM_MIN, BPM_MAX } from './metronome-panel';
import { decodeFile, addBuffer, renderWave, play as playClips, stopAll as stopClips, stopTrack, setTrackVolume, setTrackMuted } from './audio-engine';
import { slideSource, glideBeats } from './note-slide';
import { openPianoRoll, setPianoRollPlayhead, setPianoRollChangeHandler, setPianoRollSeekHandler, getPianoRollNotes, copyPianoRollNotes, trimPianoRollNotes, pianoRollExtraKeys, dropPianoRollNotesOf, clearPianoRollNotes, PR_BEATS } from './piano-roll';
// Tahap 1 (porting tanpa perubahan perilaku): logika dipindah apa adanya dari web-daw.html.
initLandscape();
initMenuPanel();
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE_OUT = 'cubic-bezier(.22,1,.36,1)', EASE_SPRING = 'cubic-bezier(.34,1.56,.64,1)', EASE_INOUT = 'cubic-bezier(.65,0,.35,1)';
const TRACK_TPL = document.querySelector('.trackheader-container').cloneNode(true);
TRACK_TPL.querySelector('.trackheader').classList.remove('trackheader--selected');   // track baru tidak otomatis terpilih dari template
// Gambar penggaris bar/ketukan (bisa di-zoom)
let BARS = 32;   // bertambah otomatis kalau audio yang di-upload lebih panjang dari timeline
const MAX_BARS = 300, H = 48;
const BAR_MIN = 24, BAR_MAX = 3840, BAR_DEFAULT = 80;   // maks 4800%: sampai level 1/64 ketukan kelihatan jelas
const wsEl = document.querySelector('.workspace'), tlEl = document.getElementById('timeline');
let BAR_W = BAR_DEFAULT, W = BARS * BAR_W;
const pl = el => parseFloat(el.style.left) || 0, pw = el => parseFloat(el.style.width) || 0;
// Snap makin halus saat di-zoom besar (1/4 bar sampai 240px, lalu 1/16, 1/32, 1/64)
let snapOn = true;   // tombol Snap di toolbar pattern
const snapStep = () => BAR_W / (BAR_W <= 240 ? 4 : BAR_W <= 640 ? 16 : BAR_W <= 1280 ? 32 : 64);
const canvas = document.getElementById('axis');
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const g = canvas.getContext('2d');
function sizeRuler() {
  W = BARS * BAR_W;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  document.getElementById('timeline').style.width = W + 'px';
  document.getElementById('ruler').style.width = W + 'px';
}
// Ruler hanya digambar untuk bagian yang terlihat (+ margin): canvas selebar W akan melewati batas browser saat zoom besar
let rp = {x0: -1, x1: -1, bar: 0};
function paintRuler(force) {
  const cw = wsEl.clientWidth, off = tlEl.offsetLeft;
  const a0 = Math.max(0, wsEl.scrollLeft - off), a1 = Math.min(W, wsEl.scrollLeft - off + cw);
  const pad = cw * .4;
  if (!force && rp.bar === BAR_W &&
      (rp.x0 === 0 || a0 - pad >= rp.x0) && (rp.x1 === W || a1 + pad <= rp.x1)) return;
  const x0 = Math.max(0, Math.floor(a0 - cw)), x1 = Math.min(W, Math.ceil(a1 + cw));
  rp = {x0, x1, bar: BAR_W};
  const d = Math.min(dpr, 16000 / Math.max(1, x1 - x0));
  canvas.width = Math.max(1, Math.round((x1 - x0) * d)); canvas.height = Math.round(H * d);
  canvas.style.left = x0 + 'px'; canvas.style.width = (x1 - x0) + 'px';
  g.setTransform(d, 0, 0, d, -x0 * d, 0);
  const every = BAR_W < 28 ? 4 : BAR_W < 50 ? 2 : 1;
  const beat = BAR_W >= 56, sub = BAR_W >= 160, mid = BAR_W >= 640, fine = BAR_W >= 1280;
  const step = fine ? 1 : mid ? 2 : sub ? 4 : beat ? 16 : 64;   // dalam satuan 1/64 bar
  const b0 = Math.max(0, Math.floor(x0 / BAR_W) - 1), b1 = Math.min(BARS, Math.ceil(x1 / BAR_W) + 1);
  for (let b = b0; b < b1; b++) {
    const bx = b * BAR_W;
    g.fillStyle = '#8a8a9a';
    if (b % every === 0) { g.font = '11px system-ui, sans-serif'; g.fillRect(bx + .5, 24, 1, 24); g.fillText(b + 1, bx + 4, 38); }
    else g.fillRect(bx + .5, 38, 1, 10);
    for (let j = step; j < 64; j += step) {
      const x = bx + j * BAR_W / 64;
      if (x < x0 - 60 || x > x1 + 60) continue;
      const h = j % 16 === 0 ? 10 : j % 4 === 0 ? 5 : j % 2 === 0 ? 3 : 2;
      g.fillStyle = h >= 10 ? '#8a8a9a' : '#6f6f80';
      g.fillRect(x + .5, 48 - h, 1, h);
      if (j % 16 === 0 && BAR_W >= 240) {            // label ketukan: 3.2 = bar 3 ketukan 2
        g.fillStyle = '#6f6f80'; g.font = '10px system-ui, sans-serif';
        g.fillText((b + 1) + '.' + (j / 16 + 1), x + 4, 38);
      } else if (j % 4 === 0 && BAR_W >= 1280) {      // label 1/16: 3.2.4
        g.fillStyle = '#585868'; g.font = '9px system-ui, sans-serif';
        g.fillText((b + 1) + '.' + (((j / 16) | 0) + 1) + '.' + ((j % 16) / 4 + 1), x + 3, 38);
      }
    }
  }
}
sizeRuler(); paintRuler();
const initRec = root => root.querySelectorAll('.trackheader__rec-mode-button').forEach(btn => {
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-checked') === 'true';
    btn.setAttribute('aria-checked', String(!on));
    if (!REDUCE) btn.animate([{transform:'scale(.8)'},{transform:'scale(1.15)',offset:.55},{transform:'scale(1)'}],{duration:380,easing:EASE_OUT});
  });
});
// Card putih kecil (dipakai bersama knob pan & slider volume): muncul saat digeser, menampilkan nilainya
const panTip = document.createElement('div');
panTip.className = 'pan-tip';
panTip.hidden = true;
panTip.setAttribute('role', 'status');
document.body.appendChild(panTip);
let tipTimer = 0;
// Slider volume: 0-150%, 100% = default (gain 1.0), di atasnya boost sampai 150%. Warna ungu ikut bergeser
const initSliders = root => root.querySelectorAll('.slider').forEach(sl => {
  const sync = () => {
    const min = +sl.min, max = +sl.max, v = +sl.value;
    const f = (v - min) / (max - min);
    sl.style.setProperty('--slider-progress', (f * 100) + '%');
    sl.style.setProperty('--slider-progress-fraction', f);
    sl.setAttribute('aria-valuenow', v);
    sl.setAttribute('aria-valuetext', 'Vol ' + Math.round(v) + '%');
  };
  const showTip = ms => {   // card putih persentase tepat di atas thumb slider
    const min = +sl.min, max = +sl.max, f = (+sl.value - min) / (max - min);
    panTip.textContent = Math.round(+sl.value) + '%';
    panTip.hidden = false;
    const r = sl.getBoundingClientRect(), t = panTip.getBoundingClientRect(), TH = 13;
    let left = r.left + TH / 2 + f * (r.width - TH) - t.width / 2;
    left = Math.max(8, Math.min(left, innerWidth - t.width - 8));
    let top = r.top - t.height - 8;
    if (top < 4) top = r.bottom + 8;
    panTip.style.left = left + 'px';
    panTip.style.top = top + 'px';
    clearTimeout(tipTimer);
    if (ms) tipTimer = setTimeout(() => { panTip.hidden = true; }, ms);
  };
  let drag = false;
  sl.addEventListener('pointerdown', () => {
    drag = true; sync(); showTip();
    const end = () => { drag = false; panTip.hidden = true; clearTimeout(tipTimer); };
    addEventListener('pointerup', end, {once: true});
    addEventListener('pointercancel', end, {once: true});
  });
  sl.addEventListener('input', () => { sync(); showTip(drag ? 0 : 900); });   // keyboard: tampil sebentar
  sync();
});

// Knob pan: putar dengan drag (atas/kanan = naik), panah keyboard, dobel klik = reset
const initKnobs = root => root.querySelectorAll('.knob-input').forEach(el => {
  const hideTip = () => { panTip.hidden = true; };
  const showTip = ms => {
    panTip.textContent = el.getAttribute('aria-valuetext');
    panTip.hidden = false;
    const r = el.getBoundingClientRect(), t = panTip.getBoundingClientRect();
    let left = r.right + 6;
    if (left + t.width > innerWidth - 8) left = r.left - t.width - 6;
    panTip.style.left = left + 'px';
    panTip.style.top = (r.top + r.height / 2 - t.height / 2) + 'px';
    clearTimeout(tipTimer);
    if (ms) tipTimer = setTimeout(hideTip, ms);
  };
  const pos = el.querySelector('.knob-pos');
  const arc = el.querySelector('.circle');
  let v = 0.5;
  el.style.touchAction = 'none';
  const render = () => {
    pos.style.transform = 'rotate(' + (-135 + v * 270) + 'deg)';
    const a = Math.min(v, 0.5) * 75, b = Math.max(v, 0.5) * 75;
    arc.setAttribute('stroke-dashoffset', '0');
    arc.setAttribute('stroke-dasharray', '0 ' + a + ' ' + (b - a) + ' 100');
    const pan = Math.round((v - 0.5) * 200);
    el.setAttribute('aria-valuenow', v.toFixed(3));
    el.setAttribute('aria-valuetext', 'Pan ' + (pan < 0 ? -pan + ' L' : pan > 0 ? pan + ' R' : '0'));
  };
  const set = n => { v = Math.max(0, Math.min(1, n)); render(); if (!panTip.hidden) showTip(); };
  let sx = 0, sy = 0, sv = 0.5, drag = false;
  el.addEventListener('pointerdown', e => {
    drag = true; el.classList.add('is-dragging'); sx = e.clientX; sy = e.clientY; sv = v;
    el.setPointerCapture(e.pointerId); e.preventDefault(); showTip();
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    set(sv + ((sy - e.clientY) + (e.clientX - sx)) / 150);
  });
  const end = () => { drag = false; el.classList.remove('is-dragging'); hideTip(); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { set(0.5); showTip(900); });
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(v + 0.02); showTip(900); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(v - 0.02); showTip(900); e.preventDefault(); }
  });
  render();
});
// Menu titik tiga: Delete & Color
const COLORS = ['#5b3de8','#2f7bff','#14b8a6','#3fbf5f','#ff9f1c','#ff4d8d','#ef4444','#facc15'];
let menu = null, sub = null, menuBtn = null;
function fadeOut(el) {
  el.style.pointerEvents = 'none';
  el.animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.9) translateY(-4px)'}],
    {duration:160,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'}).onfinish = () => el.remove();
}
function closeMenu(instant) {
  const s = sub, m = menu, b = menuBtn;
  sub = menu = menuBtn = null;
  [s, m].forEach(el => { if (el) (instant === true || instant instanceof Event || REDUCE) ? el.remove() : fadeOut(el); });
  if (b) b.setAttribute('aria-expanded', 'false');
}
function removeTrack(cont, lane) {
  stopTrack(actx, cont.dataset.track);
  if (kbdCont === cont) closeKbd();
  if (selTrack && cont.contains(selTrack)) selTrack = null;
  fxRack.drop(cont.dataset.track);
  if (lane && selPat && lane.contains(selPat)) selectPattern(null);
  if (REDUCE) { if (lane) lane.remove(); cont.remove(); return; }
  const h = cont.offsetHeight, o = {duration:420, easing:EASE_INOUT, fill:'forwards'};
  cont.style.overflow = 'hidden';
  cont.animate([
    {height:h+'px', paddingTop:'4px', opacity:1, transform:'translateX(0) scale(1)'},
    {opacity:0, transform:'translateX(-48px) scale(.94)', offset:.5},
    {height:'0px', paddingTop:'0px', opacity:0, transform:'translateX(-48px) scale(.94)'}], o).onfinish = () => cont.remove();
  if (lane) {
    lane.style.overflow = 'hidden';
    lane.animate([{height:h+'px',opacity:1},{opacity:0,offset:.5},{height:'0px',opacity:0}], o).onfinish = () => lane.remove();
  }
}
function openMenu(btn) {
  closeMenu(true);
  const cont = btn.closest('.trackheader-container');
  const cur = cont.style.getPropertyValue('--track-color') || COLORS[0];
  menu = document.createElement('div');
  menu.className = 'track-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML =
    '<button role="menuitem" class="track-menu__item track-menu__item--danger" data-act="delete">' +
      '<span class="soundtrap-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.397 9.652a1.166 1.166 0 0 0-1.165 1.165V21.71a1.165 1.165 0 0 0 1.165 1.165h13.206a1.166 1.166 0 0 0 1.165-1.165V10.817a1.165 1.165 0 0 0-2.33 0v9.728H6.562v-9.728a1.165 1.165 0 0 0-1.165-1.165Zm8.545-8.527h-3.884a1.165 1.165 0 1 0 0 2.33h3.884a1.165 1.165 0 0 0 0-2.33Z"/><path d="M11.223 17.05v-6.215a1.165 1.165 0 0 0-2.33 0v6.214a1.165 1.165 0 0 0 2.33 0Zm3.884 0v-6.215a1.165 1.165 0 1 0-2.33 0v6.214a1.165 1.165 0 0 0 2.33 0Zm3.496-12.041H5.397a1.165 1.165 0 1 0 0 2.33h13.206a1.165 1.165 0 1 0 0-2.33Z"/></svg></span>' +
      '<span>Delete track</span></button>' +
    '<button role="menuitem" class="track-menu__item" data-act="color" aria-expanded="false">' +
      '<span class="track-menu__dot" style="background:' + cur + '"></span><span>Color</span>' +
      '<svg class="track-menu__chev" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6.045 20.89a1.164 1.164 0 0 0 1.639.174l5.05-4.079 5.048-4.078a1.164 1.164 0 0 0 0-1.813l-5.049-4.078-5.049-4.078A1.165 1.165 0 1 0 6.22 4.75l4.488 3.625L15.196 12l-4.488 3.625L6.22 19.25a1.166 1.166 0 0 0-.175 1.64Z"/></svg></button>' +
    '';
  document.body.appendChild(menu);
  // posisi: di sebelah kanan tombol, kalau tidak muat pindah ke kiri
  const r = cont.getBoundingClientRect(), m = menu.getBoundingClientRect();
  let left = r.right + 4;
  if (left + m.width > innerWidth - 8) left = Math.max(8, r.left - m.width - 4);
  menu.style.left = left + 'px';
  menu.style.top = Math.max(8, Math.min(r.top + 12, innerHeight - m.height - 8)) + 'px';
  menu.style.transformOrigin = left >= r.right ? 'left top' : 'right top';
  btn.setAttribute('aria-expanded', 'true');
  menuBtn = btn;

  menu.addEventListener('click', e => {
    const it = e.target.closest('[data-act]');
    if (!it) return;
    if (it.dataset.act === 'delete') {
      const lane = document.querySelector('.lane[data-track="' + cont.dataset.track + '"]');
      removeTrack(cont, lane);
      closeMenu();
    } else {
      openColors(cont, it);
    }
  });
}
// Card terpisah untuk pilihan warna, muncul di kanan menu utama
function openColors(cont, it) {
  if (sub) { fadeOut(sub); sub = null; it.setAttribute('aria-expanded', 'false'); return; }
  sub = document.createElement('div');
  sub.className = 'track-menu track-menu--colors';
  sub.setAttribute('role', 'menu');
  sub.innerHTML = '<div class="track-menu__swatches">' +
    COLORS.map((c, i) => '<button class="track-menu__swatch" data-c="' + c + '" style="background:' + c + ';--i:' + i + '" aria-label="Warna ' + c + '"></button>').join('') +
    '</div>';
  document.body.appendChild(sub);
  const mr = menu.getBoundingClientRect(), ir = it.getBoundingClientRect(), sr = sub.getBoundingClientRect();
  let left = mr.right + 4;
  if (left + sr.width > innerWidth - 8) left = Math.max(8, mr.left - sr.width - 4);
  sub.style.left = left + 'px';
  sub.style.top = Math.max(8, Math.min(ir.top - 6, innerHeight - sr.height - 8)) + 'px';
  sub.style.transformOrigin = left >= mr.right ? 'left top' : 'right top';
  it.setAttribute('aria-expanded', 'true');
  sub.addEventListener('click', e => {
    const sw = e.target.closest('.track-menu__swatch');
    if (!sw) return;
    cont.style.setProperty('--track-color', sw.dataset.c);
    const ln = document.querySelector('.lane[data-track="' + cont.dataset.track + '"]');
    if (ln) ln.style.setProperty('--track-color', sw.dataset.c);
    const ib = cont.querySelector('.trackheader__instrument-button');
    if (ib && !REDUCE) ib.animate([
      {transform:'scale(1)', boxShadow:'0 0 0 0 ' + sw.dataset.c},
      {transform:'scale(1.28)', boxShadow:'0 0 0 10px transparent', offset:.5},
      {transform:'scale(1)', boxShadow:'0 0 0 0 transparent'}], {duration:550, easing:EASE_OUT});
    closeMenu();
  });
}
const initMore = root => root.querySelectorAll('.trackheader__more-options').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation(); closeAddMenu(true);
    if (menuBtn === btn) closeMenu(); else openMenu(btn);
  });
});
document.addEventListener('click', e => { if (menu && !menu.contains(e.target) && !(sub && sub.contains(e.target))) closeMenu(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && menu) { const b = menuBtn; closeMenu(); b && b.focus(); }
});
window.addEventListener('resize', closeMenu);
window.addEventListener('scroll', closeMenu, true);

// Klik area kosong di timeline -> kartu "Add" -> pattern kosong
const lanesEl = document.getElementById('lanes');
let addCard = null, ghost = null;
function dismissAdd(instant) {
  const els = [addCard, ghost]; addCard = ghost = null;
  els.forEach(el => {
    if (!el) return;
    if (instant || REDUCE) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    const kf = el.classList.contains('add-card')
      ? [{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.8)'}] : [{opacity:1},{opacity:0}];
    el.animate(kf, {duration:140, easing:'cubic-bezier(.4,0,1,1)', fill:'forwards'}).onfinish = () => el.remove();
  });
}
// cari posisi (snap ke bar) & lebar yang muat tanpa menimpa pattern lain
function slot(lane, x) {
  const pats = [...lane.querySelectorAll('.pattern')].map(p => ({s:pl(p), e:pl(p) + pw(p)})).sort((a, b) => a.s - b.s);
  let start = Math.floor(x / BAR_W) * BAR_W;
  for (const p of pats) if (p.e > start && p.s <= x) start = p.e;
  let end = Math.min(start + BAR_W * 2, W);
  for (const p of pats) if (p.s >= start && p.s < end) end = p.s;
  return end - start >= BAR_W / 2 ? {start, width: end - start} : null;
}
// Isi note ditampilkan mini di dalam pattern (seperti piano roll kecil): x = ketukan dari awal pattern, y = nada (dipusatkan sesuai rentang nada)
function renderPatNotes(el) {
  const id = el.dataset.prId; if (!id) return;
  const notes = [id, ...pianoRollExtraKeys(id)].flatMap(k => getPianoRollNotes(k));   // nada milik track pattern + nada dari DERIZ lain yang mengisi pattern ini
  let box = el.querySelector('.pattern__notes');
  if (!notes.length) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement('div'); box.className = 'pattern__notes'; el.insertBefore(box, el.querySelector('.pattern__handle')); }
  let lo = 127, hi = 0; notes.forEach(n => { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); });
  const rows = Math.max(hi - lo + 1, 8), top = (rows - (hi - lo + 1)) / 2;   // minimal 8 baris supaya 1-2 nada tidak jadi balok raksasa
  box.innerHTML = '<svg viewBox="0 0 ' + PR_BEATS + ' ' + rows + '" preserveAspectRatio="none" aria-hidden="true">' +
    notes.map(n => '<rect x="' + n.s + '" y="' + (top + hi - n.p + 0.1) + '" width="' + Math.max(n.l, 0.12) + '" height="0.8"/>').join('') + '</svg>';
}
// Banyak DERIZ bisa mengisi satu pattern: nada instrumen bawaan track pemilik pattern disimpan di kunci id pattern, nada DERIZ lain di "<id>@<id DERIZ>"
const patKey = (prId, fxId, laneTrack) => !hasSynth(laneTrack) && fxRack.derizOwnsPlain(laneTrack, fxId) ? prId : prId + '@' + fxId;   // DERIZ pertama yang dibuat di track pemilik pattern pakai kunci polos (data lama tetap terbaca)
const patBase = id => id.split('@')[0];
const copyPatNotes = (from, to, a, b) => { copyPianoRollNotes(from, to, a, b); for (const k of pianoRollExtraKeys(from)) copyPianoRollNotes(k, to + k.slice(from.length), a, b); };
const trimPatNotes = (id, beat) => { trimPianoRollNotes(id, beat); for (const k of pianoRollExtraKeys(id)) trimPianoRollNotes(k, beat); };
setPianoRollChangeHandler(id => { const el = lanesEl.querySelector('.pattern[data-pr-id="' + patBase(id) + '"]'); if (el) renderPatNotes(el); });
function createPattern(lane, sl, ci) {   // ci = {clip, off}: pattern ini adalah audio clip
  const cont = document.querySelector('.trackheader-container[data-track="' + lane.dataset.track + '"]');
  const col = cont && cont.style.getPropertyValue('--track-color');
  if (col) lane.style.setProperty('--track-color', col);
  const nm = document.getElementById('track-name-' + lane.dataset.track);
  const el = document.createElement('div');
  el.className = 'pattern';
  el.style.left = sl.start + 'px';
  el.style.width = sl.width + 'px';
  el.innerHTML = '<div class="pattern__head"><span class="pattern__title"></span></div><div class="pattern__handle" aria-label="Panjangkan pattern"></div>';
  el.querySelector('.pattern__title').textContent = nm ? nm.textContent : 'Track';
  if (ci) { el.dataset.clip = ci.clip; el.dataset.off = ci.off; }
  lane.appendChild(el);
  return el;
}
function onLaneTap(e) {
  if (e.target.closest('.pattern') || e.target.closest('.add-card')) return;
  const lane = e.target.closest('.lane');
  dismissAdd();
  if (!lane) return;
  const x = e.clientX - lane.getBoundingClientRect().left;
  const sl = slot(lane, x);
  if (!sl) return;
  ghost = document.createElement('div');
  ghost.className = 'pattern-ghost';
  ghost.style.left = sl.start + 'px';
  ghost.style.width = sl.width + 'px';
  addCard = document.createElement('button');
  addCard.className = 'add-card';
  addCard.textContent = 'Add';
  addCard.setAttribute('aria-label', 'Tambah pattern kosong');
  addCard.style.left = Math.max(2, Math.min(x - 17, W - 36)) + 'px';
  addCard.addEventListener('click', () => { createPattern(lane, sl); dismissAdd(); });
  lane.append(ghost, addCard);
}
let tap = null;
lanesEl.addEventListener('pointerdown', e => { tap = e.button > 0 ? null : {x:e.clientX, y:e.clientY, t:e.timeStamp, id:e.pointerId}; });
lanesEl.addEventListener('pointercancel', () => { tap = null; });
lanesEl.addEventListener('pointerup', e => {
  if (!tap || tap.id !== e.pointerId) return;
  const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y), dt = e.timeStamp - tap.t;
  tap = null;
  if (moved < 8 && dt < 600) onLaneTap(e);
});
document.addEventListener('click', e => { if (addCard && !lanesEl.contains(e.target)) dismissAdd(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && addCard) dismissAdd(); });
// Geser pattern kiri-kanan: bebas saat di-drag, snap ke 1/4 bar saat dilepas
lanesEl.addEventListener('pointerdown', e => {
  const el = e.target.closest('.pattern');
  if (!el || e.button > 0 || e.target.closest('.pattern__handle') || e.target.isContentEditable) return;
  const lane = el.parentElement, w = pw(el), s0 = pl(el), STEP = snapStep();
  let lo = 0, hi = W;
  [...lane.querySelectorAll('.pattern')].filter(p => p !== el).forEach(p => {
    const a = pl(p), b = a + pw(p);
    if (b <= s0 + 1) lo = Math.max(lo, b); else if (a >= s0 + w - 1) hi = Math.min(hi, a);
  });
  const clamp = v => Math.max(lo, Math.min(hi - w, v));
  const sx = e.clientX; let moved = false;
  el.setPointerCapture(e.pointerId);
  const move = ev => {
    const dx = ev.clientX - sx;
    if (!moved) {
      if (Math.abs(dx) < 4) return;
      moved = true; dismissAdd();
      el.classList.remove('is-settling'); el.classList.add('is-dragging');
    }
    el.style.left = clamp(s0 + dx) + 'px';
  };
  const end = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    if (!moved) return;
    el.classList.remove('is-dragging');
    if (!REDUCE) el.classList.add('is-settling');
    el.style.left = clamp(snapOn ? Math.round(pl(el) / STEP) * STEP : pl(el)) + 'px';
    setTimeout(() => el.classList.remove('is-settling'), 320);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
});

// Seleksi pattern (outline putih) + resize lewat bulatan di kanan
let selPat = null;
function handleSide(el) { el.classList.toggle('handle-inside', pl(el) + pw(el) > W - 40); }
function selectPattern(el) {
  if (selPat === el) return;
  if (selPat) selPat.classList.remove('is-selected');
  selPat = el;
  if (el) { handleSide(el); el.classList.add('is-selected'); }
  patBarShow(el);
}
document.addEventListener('pointerup', () => { if (selPat) setTimeout(() => selPat && handleSide(selPat), 330); });
lanesEl.addEventListener('pointerdown', e => {
  const el = e.target.closest('.pattern');
  if (el && e.button <= 0) {
    if (!e.target.closest('.pattern__handle')) {
      patAnchor = (e.clientX - el.getBoundingClientRect().left) / BAR_W;   // titik klik di dalam pattern
      if (selPat === el) { patBarPlace(); patBarPop(); }   // pattern sama, titik klik baru: muncul ulang di sana (tanpa bergeser)
    }
    selectPattern(el); dismissAdd();
  }
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('.pattern, .pat-bar, .pat-menu, .kbd')) selectPattern(null); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && selPat && !addCard) selectPattern(null); });
lanesEl.addEventListener('pointerdown', e => {
  const h = e.target.closest('.pattern__handle');
  if (!h || e.button > 0) return;
  e.preventDefault();
  const el = h.parentElement, lane = el.parentElement;
  const s0 = pl(el), w0 = pw(el), STEP = snapStep(), MIN = BAR_W / 2;
  let hi = W;
  [...lane.querySelectorAll('.pattern')].filter(p => p !== el).forEach(p => {
    if (pl(p) >= s0 + w0 - 1) hi = Math.min(hi, pl(p));
  });
  const clamp = v => Math.max(MIN, Math.min(hi - s0, v));
  const sx = e.clientX;
  h.setPointerCapture(e.pointerId);
  el.classList.remove('is-snapping'); el.classList.add('is-resizing');
  const move = ev => { el.style.width = clamp(w0 + ev.clientX - sx) + 'px'; handleSide(el); };
  const end = () => {
    h.removeEventListener('pointermove', move);
    h.removeEventListener('pointerup', end);
    h.removeEventListener('pointercancel', end);
    el.classList.remove('is-resizing');
    if (!REDUCE) el.classList.add('is-snapping');
    el.style.width = clamp(snapOn ? Math.round((s0 + pw(el)) / STEP) * STEP - s0 : pw(el)) + 'px';
    setTimeout(() => el.classList.remove('is-snapping'), 300);
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
});


// ===== Toolbar bulat di atas pattern terpilih =====
const patBar = document.createElement('div');
patBar.className = 'pat-bar'; patBar.hidden = true; patBar.setAttribute('role', 'toolbar'); patBar.setAttribute('aria-label', 'Aksi pattern');
[['copy','Copy','Salin pattern'],['del','Delete','Hapus pattern'],['snap','Snap','Snap ke grid'],['edit','Edit','Buka piano roll'],['more','More...','Opsi lainnya']]
  .forEach(([act, txt, label], i) => {
    const b = document.createElement('button');
    b.className = 'pat-btn'; b.type = 'button'; b.dataset.act = act; b.textContent = txt;
    b.setAttribute('aria-label', label); b.style.setProperty('--i', i);
    if (act === 'snap') b.setAttribute('aria-pressed', 'true');
    if (act === 'more') b.setAttribute('aria-haspopup', 'menu');
    patBar.appendChild(b);
  });
lanesEl.appendChild(patBar);

let patAnchor = null;   // posisi klik di pattern (dalam bar); null = tengah bagian yang terlihat
const patObs = new MutationObserver(() => patBarPlace());   // ikut bergerak saat pattern digeser / di-resize / di-zoom
function patBarShow(el) {
  patObs.disconnect(); closePatMenu();
  if (!el) { patBar.hidden = true; return; }
  patObs.observe(el, {attributes: true, attributeFilter: ['style']});
  patBar.hidden = false; patBarPlace(); patBarPop();
}
function patBarPop() { patBar.classList.remove('is-open'); void patBar.offsetWidth; if (!REDUCE) patBar.classList.add('is-open'); }
function patBarPlace() {
  const el = selPat, lane = el && el.parentElement;
  if (!lane || patBar.hidden) return;
  const bw = patBar.offsetWidth, bh = patBar.offsetHeight || 46;
  const a = pl(el), b = a + pw(el);
  const v0 = wsEl.scrollLeft, v1 = wsEl.scrollLeft + wsEl.clientWidth - tlEl.offsetLeft;   // bagian timeline yang terlihat
  const i0 = Math.max(a, v0), i1 = Math.min(b, v1);
  patBar.style.visibility = i1 <= i0 ? 'hidden' : 'visible';
  const cx = patAnchor == null ? (i0 + i1) / 2 : Math.max(a, Math.min(b, a + patAnchor * BAR_W));   // di bawah/atas titik klik
  let left = cx - bw / 2;
  left = Math.max(v0 + 6, Math.min(left, v1 - bw - 6));
  left = Math.max(0, Math.min(left, W - bw));
  const above = lane.offsetTop - bh - 8;
  patBar.style.left = left + 'px';
  patBar.style.top = (above < 0 ? lane.offsetTop + lane.offsetHeight + 8 : above) + 'px';   // track paling atas: toolbar turun ke bawah pattern
}
wsEl.addEventListener('scroll', () => { patBarPlace(); closePatMenu(); }, {passive: true});
window.addEventListener('resize', patBarPlace);

function shakeBar() { patBar.classList.remove('is-shake'); void patBar.offsetWidth; patBar.classList.add('is-shake'); }
const clipOf = (el, addSec) => el.dataset.clip ? {clip: +el.dataset.clip, off: (+el.dataset.off || 0) + addSec} : null;
const otherPats = el => [...el.parentElement.querySelectorAll('.pattern')].filter(p => p !== el);
function freeRightOf(el) {   // batas kanan terdekat sebelum pattern lain / ujung timeline
  const end = pl(el) + pw(el); let hi = W;
  otherPats(el).forEach(p => { if (pl(p) >= end - 1) hi = Math.min(hi, pl(p)); });
  return hi;
}
function copyPattern() {
  const el = selPat; if (!el) return;
  const lane = el.parentElement, w = pw(el);
  const spans = [...lane.querySelectorAll('.pattern')].map(p => ({s: pl(p), e: pl(p) + pw(p)})).sort((x, y) => x.s - y.s);
  let start = pl(el) + w;
  for (const p of spans) if (p.e > start && p.s < start + w) start = p.e;   // geser ke ruang kosong terdekat di kanan
  if (start + w > W + .5) return shakeBar();
  const n = createPattern(lane, {start, width: w}, clipOf(el, 0));
  n.querySelector('.pattern__title').textContent = el.querySelector('.pattern__title').textContent;
  if (el.dataset.prId) { n.dataset.prId = 'pat' + (++prSeq); copyPatNotes(el.dataset.prId, n.dataset.prId); renderPatNotes(n); }   // salinan ikut membawa nada
  patAnchor = null; selectPattern(n);
  n.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'smooth'});
}
function deletePattern() {
  const el = selPat; if (!el) return;
  selectPattern(null);
  if (REDUCE) { el.remove(); return; }
  el.animate([{opacity: 1, transform: 'scale(1)'}, {opacity: 0, transform: 'scale(.9)'}], {duration: 200, easing: EASE_OUT, fill: 'forwards'}).onfinish = () => el.remove();
}
// Tombol "Edit": pattern instrumen -> buka piano roll; pattern audio clip (tidak punya nada) -> tetap ganti nama seperti sebelumnya
let prSeq = 0, prStartBar = 0;   // prStartBar: posisi awal pattern yang sedang dibuka di piano roll (dalam bar), supaya playhead-nya relatif
function editPattern() {
  const el = selPat; if (!el) return;
  if (el.dataset.clip) return renamePattern();
  const lane = el.parentElement, id = lane.dataset.track;
  const nm = document.getElementById('track-name-' + id);
  if (!el.dataset.prId) el.dataset.prId = 'pat' + (++prSeq);   // kunci supaya nada piano roll tersimpan per pattern
  prStartBar = pl(el) / BAR_W;
  openPianoRoll({
    id: editKey(el),
    ghosts: patGhosts(el, editKey(el)),
    track: nm ? nm.textContent : 'Track',
    pattern: el.querySelector('.pattern__title').textContent,
    color: lane.style.getPropertyValue('--track-color') || undefined,
  });
  renderPlayhead();
}
// Masuk ke pattern dari tombol titik tiga di DERIZ: piano roll yang sama, tapi nadanya milik DERIZ ini (dimainkan lewat sampler DERIZ ini)
const trackColorOf = track => { const c = document.querySelector('.trackheader-container[data-track="' + track + '"]'); return (c && getComputedStyle(c).getPropertyValue('--track-color').trim()) || '#a66cff'; };
// nada instrumen lain di pattern yang sama (DERIZ lain di track mana pun + Supersaw milik track pattern): ditampilkan meredup di piano roll
function patGhosts(el, curKey) {
  const prId = el.dataset.prId, lt = el.parentElement.dataset.track, out = [];
  const add = (key, track) => { if (key !== curKey && !out.some(g => g.key === key)) out.push({key, color: trackColorOf(track)}); };
  if (hasSynth(lt)) add(prId, lt);
  document.querySelectorAll('.trackheader-container').forEach(c => fxRack.derizIds(c.dataset.track).forEach(id => add(patKey(prId, id, lt), c.dataset.track)));
  return out;
}
// tombol Edit: kunci nada instrumen track pemilik pattern (Supersaw = polos; DERIZ = DERIZ pertama yang ada di track itu)
function editKey(el) {
  const lt = el.parentElement.dataset.track, ids = hasSynth(lt) ? [] : fxRack.derizIds(lt);
  return ids.length ? patKey(el.dataset.prId, ids[0], lt) : el.dataset.prId;
}
function enterPatternAs(el, fxId) {
  const lane = el.parentElement, track = fxRack.derizTrackOf(fxId); if (track === undefined) return;
  if (!el.dataset.prId) el.dataset.prId = 'pat' + (++prSeq);
  const nm = document.getElementById('track-name-' + track), cont = document.querySelector('.trackheader-container[data-track="' + track + '"]');
  prStartBar = pl(el) / BAR_W;
  openPianoRoll({
    id: patKey(el.dataset.prId, fxId, lane.dataset.track),
    ghosts: patGhosts(el, patKey(el.dataset.prId, fxId, lane.dataset.track)),
    track: (nm ? nm.textContent : 'Track') + (fxRack.derizIds(track).length > 1 ? ' · ' + fxRack.derizLabel(fxId) : ''),
    pattern: el.querySelector('.pattern__title').textContent,
    color: (cont && getComputedStyle(cont).getPropertyValue('--track-color').trim()) || undefined,
  });
  if (kbdCont && cont) openKbd(cont, fxId);   // keyboard di bawah ikut memainkan DERIZ ini
  renderPlayhead();
}
const patternBridge = {
  list(fxId) {
    const rows = [...lanesEl.querySelectorAll('.pattern:not([data-clip])')].map(el => {
      const lane = el.parentElement, lt = lane.dataset.track, id = el.dataset.prId;
      const nm = document.getElementById('track-name-' + lt), cont = document.querySelector('.trackheader-container[data-track="' + lt + '"]');
      return {
        title: el.querySelector('.pattern__title').textContent || 'Pattern',
        trackName: nm ? nm.textContent : 'Track',
        color: (cont && getComputedStyle(cont).getPropertyValue('--track-color').trim()) || '#a66cff',
        bar: Math.round(pl(el) / BAR_W * 100) / 100 + 1,
        notes: id ? getPianoRollNotes(patKey(id, fxId, lt)).length : 0,
        ref: el, top: lane.offsetTop, left: pl(el)
      };
    });
    return rows.sort((a, b) => a.top - b.top || a.left - b.left);
  },
  open(row, fxId) { if (row.ref.isConnected) enterPatternAs(row.ref, fxId); },
  removed(fxId, track, ownedPlain) {
    dropPianoRollNotesOf(String(fxId));
    if (ownedPlain) lanesEl.querySelectorAll('.pattern[data-pr-id]').forEach(p => { if (p.parentElement.dataset.track === track) clearPianoRollNotes(p.dataset.prId); });
  }
};
lanesEl.addEventListener('dblclick', e => {   // ganti nama pattern: klik dua kali judulnya
  const t = e.target.closest && e.target.closest('.pattern__title');
  if (t && selPat && selPat.contains(t)) renamePattern();
});
function renamePattern() {   // ubah nama pattern langsung di judulnya
  const el = selPat; if (!el) return;
  const t = el.querySelector('.pattern__title'), old = t.textContent;
  t.contentEditable = 'true'; t.spellcheck = false; t.focus();
  const rg = document.createRange(); rg.selectNodeContents(t);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg);
  const end = save => {
    t.removeEventListener('blur', onBlur); t.removeEventListener('keydown', onKey);
    t.contentEditable = 'false';
    const v = t.textContent.trim().slice(0, 40);
    t.textContent = save && v ? v : old;
    getSelection().removeAllRanges();
  };
  const onBlur = () => end(true);
  const onKey = e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); end(true); }
    else if (e.key === 'Escape') { e.preventDefault(); end(false); }
  };
  t.addEventListener('blur', onBlur); t.addEventListener('keydown', onKey);
}
function splitPattern() {
  const el = selPat; if (!el) return;
  const s0 = pl(el), w = pw(el), st = snapStep();
  let cut = snapOn ? Math.round((s0 + w / 2) / st) * st : s0 + w / 2;
  if (cut - s0 < st || s0 + w - cut < st) cut = s0 + w / 2;
  if (cut - s0 < 4 || s0 + w - cut < 4) return shakeBar();
  const n = createPattern(el.parentElement, {start: cut, width: s0 + w - cut}, clipOf(el, (cut - s0) / BAR_W * SEC_PER_BAR));
  n.querySelector('.pattern__title').textContent = el.querySelector('.pattern__title').textContent;
  if (el.dataset.prId) {   // nada ikut terbagi: kiri dipotong di titik bagi, kanan mulai dari titik itu
    const cb = (cut - s0) / BAR_W * 4;
    n.dataset.prId = 'pat' + (++prSeq); copyPatNotes(el.dataset.prId, n.dataset.prId, cb); trimPatNotes(el.dataset.prId, cb);
    renderPatNotes(el); renderPatNotes(n);
  }
  el.style.width = (cut - s0) + 'px'; handleSide(el);
}
function doubleLength() {
  const el = selPat; if (!el) return;
  const s0 = pl(el), w = pw(el), nw = Math.min(w * 2, freeRightOf(el) - s0);
  if (nw <= w + 1) return shakeBar();
  if (!REDUCE) { el.classList.add('is-snapping'); setTimeout(() => el.classList.remove('is-snapping'), 300); }
  el.style.width = nw + 'px'; handleSide(el);
}

let patMenu = null;
function closePatMenu() {
  if (patMenu) { patMenu.remove(); patMenu = null; }
  const mb = patBar.querySelector('[data-act="more"]'); if (mb) mb.setAttribute('aria-expanded', 'false');
}
function openPatMenu(btn) {
  closeMenu(true); closeAddMenu(true);
  const m = document.createElement('div');
  m.className = 'track-menu pat-menu'; m.setAttribute('role', 'menu');
  [['Bagi dua', splitPattern], ['Gandakan panjang', doubleLength]].forEach(([txt, fn]) => {
    const it = document.createElement('button');
    it.className = 'track-menu__item'; it.type = 'button'; it.setAttribute('role', 'menuitem'); it.textContent = txt;
    it.addEventListener('click', () => { closePatMenu(); fn(); });
    m.appendChild(it);
  });
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.left + r.width / 2 - mw / 2, innerWidth - mw - 8)) + 'px';
  m.style.top = (r.bottom + 8 + mh > innerHeight - 8 ? r.top - 8 - mh : r.bottom + 8) + 'px';
  patMenu = m; btn.setAttribute('aria-expanded', 'true');
}
document.addEventListener('pointerdown', e => { if (patMenu && !patMenu.contains(e.target) && !e.target.closest('.pat-bar')) closePatMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && patMenu) closePatMenu(); });

patBar.addEventListener('click', e => {
  const b = e.target.closest('.pat-btn'); if (!b) return;
  switch (b.dataset.act) {
    case 'copy': copyPattern(); break;
    case 'del': deletePattern(); break;
    case 'snap': snapOn = !snapOn; b.setAttribute('aria-pressed', String(snapOn)); break;
    case 'edit': editPattern(); break;
    case 'more': patMenu ? closePatMenu() : openPatMenu(b); break;
  }
});


// ===== Keyboard virtual =====
const kbdEl = document.getElementById('kbd'), kbdKeys = document.getElementById('kbdKeys'), kbdTitle = document.getElementById('kbdTitle');
const kbdOctLabel = document.getElementById('kbdOctLabel'), kbdOctDown = document.getElementById('kbdOctDown'), kbdOctUp = document.getElementById('kbdOctUp');
const KEY_W = 68, WK = 66, BK = 44, OCT_W = 7 * KEY_W, KB_C0 = 136, KB_END = 3534;   // ukuran dari markup keyboard
const KSEL = '.whitekey, .blackkey';
// tombol komputer -> semitone dari C di oktaf dasar (susunan sama seperti Soundtrap: ZXCVBNM,. dan QWERTYUIOP)
const KMAP = {z:0,s:1,x:2,d:3,c:4,v:5,g:6,b:7,h:8,n:9,j:10,m:11,',':12,l:13,'.':14,'1':15,q:16,w:17,'3':18,e:19,'4':20,r:21,'5':22,t:23,y:24,'7':25,u:26,'8':27,i:28,o:29,'0':30,p:31};
let kbdCont = null, kbdOct = 3, kbdN = 0;
const baseMidi = () => 12 + 12 * kbdOct;   // C3 = 48 (C4 = 60 = middle C)

// --- suara (WebAudio, polifonik) ---
let actx = null, master = null; const voices = new Map();
function audio() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain(); master.gain.value = 1;   // unity gain: suara asli, tanpa kompresor/limiter
    master.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function noteOn(m) {
  if (voices.has(m)) return;
  const tid = kbdCont && kbdCont.dataset.track;
  if (tid && hasSynth(tid)) {   // track synth (Supersaw): suara dari plugin-nya, melewati efek track
    const ctx = audio();
    voices.set(m, {synth: startVoice(ctx, master, tid, m, ctx.currentTime)});
    return;
  }
  if (tid && fxRack.hasDeriz(tid)) {   // track DERIZ: suara dari sampler-nya (audio yang di-upload), melewati efek track
    audio();
    voices.set(m, {deriz: fxRack.derizOn(tid, m, kbdFx ?? undefined)});
    return;
  }
  const ctx = audio(), t = ctx.currentTime, f = 440 * 2 ** ((m - 69) / 12);
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter(), g2 = ctx.createGain();
  o1.type = 'triangle'; o1.frequency.value = f;
  o2.type = 'sine'; o2.frequency.value = f * 2; g2.gain.value = .25;
  lp.type = 'lowpass'; lp.frequency.value = Math.min(9000, f * 8);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.36, t + .012); g.gain.setTargetAtTime(.16, t + .02, .35);
  o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(master);
  o1.start(t); o2.start(t);
  voices.set(m, {o1, o2, g});
}
function noteOff(m) {
  const v = voices.get(m); if (!v) return;
  voices.delete(m);
  const t = actx.currentTime;
  if ('synth' in v) { releaseVoice(v.synth, t); return; }
  if ('deriz' in v) { fxRack.derizOff(v.deriz); return; }
  v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.setTargetAtTime(0, t, .07);
  v.o1.stop(t + .5); v.o2.stop(t + .5);
}
const keyElOf = m => kbdKeys.querySelector('[data-midi="' + m + '"]');
function press(m) { noteOn(m); const k = keyElOf(m); if (k) { k.classList.add('pressed'); k.classList.remove('unpressed'); } }
function release(m) { noteOff(m); const k = keyElOf(m); if (k) { k.classList.remove('pressed'); k.classList.add('unpressed'); } }
function releaseAll() { [...voices.keys()].forEach(release); pointerNotes.clear(); kbdDown.clear(); }

// --- tuts: pakai markup .keyboardkeyboardcontroller; oktaf = geser translateX, tuts di luar jendela dinonaktifkan ---
const kbdScroll = kbdKeys.querySelector('.scrollable');
const NOTE_PC = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11};
const keyBtns = [...kbdKeys.querySelectorAll(KSEL)].map(el => {
  const m = /pitch-([A-G])(b?)(-?\d+)/.exec(el.className);
  const midi = 12 + 12 * +m[3] + NOTE_PC[m[1]] - (m[2] ? 1 : 0);
  el.dataset.midi = midi; el.tabIndex = -1;
  return {el, left: parseFloat(el.style.left), w: el.classList.contains('blackkey') ? BK : WK};
});
const whitesFit = () => Math.max(7, Math.floor(kbdEl.clientWidth / KEY_W) || Math.floor(innerWidth / KEY_W));
function buildKeys(instant) {
  const nW = whitesFit(), W = nW * KEY_W - 2, maxOct = Math.max(0, Math.floor((KB_END - KB_C0 - W) / OCT_W));
  kbdOct = Math.max(0, Math.min(kbdOct, maxOct)); kbdN = nW;
  releaseAll();
  if (instant) kbdKeys.classList.add('no-anim');
  const off = KB_C0 + OCT_W * kbdOct;
  kbdKeys.style.width = W + 'px';
  kbdScroll.style.transform = 'translateX(' + (-off) + 'px)';
  keyBtns.forEach(k => {
    const vis = k.left >= off && k.left + k.w <= off + W;
    k.el.disabled = !vis; k.el.setAttribute('aria-hidden', String(!vis));
  });
  if (instant) { kbdKeys.offsetWidth; kbdKeys.classList.remove('no-anim'); }
  kbdOctLabel.textContent = 'C' + kbdOct;
  kbdOctDown.disabled = kbdOct <= 0; kbdOctUp.disabled = kbdOct >= maxOct;
}

// --- mouse / sentuh (bisa geser jari antar tuts) ---
const pointerNotes = new Map();
const keyAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest(KSEL) : null; };
kbdKeys.addEventListener('pointerdown', e => {
  const k = e.target.closest(KSEL); if (!k || e.button > 0) return;
  e.preventDefault(); kbdKeys.setPointerCapture(e.pointerId);
  const m = +k.dataset.midi; pointerNotes.set(e.pointerId, m); press(m);
});
kbdKeys.addEventListener('pointermove', e => {
  if (!pointerNotes.has(e.pointerId)) return;
  const k = keyAt(e.clientX, e.clientY); if (!k) return;
  const m = +k.dataset.midi, cur = pointerNotes.get(e.pointerId);
  if (m !== cur) { release(cur); pointerNotes.set(e.pointerId, m); press(m); }
});
const upPtr = e => { const m = pointerNotes.get(e.pointerId); if (m != null) { pointerNotes.delete(e.pointerId); release(m); } };
kbdKeys.addEventListener('pointerup', upPtr); kbdKeys.addEventListener('pointercancel', upPtr);

// --- tombol komputer ---
const kbdDown = new Map();   // e.key -> midi (supaya pelepasan tetap benar walau oktaf berganti)
const typing = t => t && (t.isContentEditable || t.matches && t.matches('textarea, input:not([type="range"])'));
document.addEventListener('keydown', e => {
  if (!kbdEl.classList.contains('is-open') || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
  const k = e.key.toLowerCase();
  if (!(k in KMAP)) return;
  e.preventDefault();
  if (e.repeat || kbdDown.has(k)) return;
  const m = baseMidi() + KMAP[k]; kbdDown.set(k, m); press(m);
});
document.addEventListener('keyup', e => { const k = e.key.toLowerCase(), m = kbdDown.get(k); if (m != null) { kbdDown.delete(k); release(m); } });
window.addEventListener('blur', releaseAll);

// --- buka / tutup ---
let kbdFx = null;   // DERIZ tertentu yang dimainkan keyboard (null = DERIZ pertama track)
function openKbd(cont, fxId = null) {
  kbdFx = fxId;
  const nm = document.getElementById('track-name-' + cont.dataset.track);
  kbdTitle.textContent = 'Keyboard · ' + (nm ? nm.textContent : 'Track');
  const cs = getComputedStyle(cont).getPropertyValue('--track-color').trim() || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  kbdEl.style.setProperty('--kc', cs);
  const wasOpen = kbdEl.classList.contains('is-open');
  kbdCont = cont;
  kbdEl.classList.add('is-open'); kbdEl.removeAttribute('inert'); kbdEl.setAttribute('aria-hidden', 'false');
  if (!wasOpen) { buildKeys(true); setTimeout(() => cont.isConnected && cont.scrollIntoView({block: 'nearest', behavior: 'smooth'}), 400); }
  syncKbdToggle();
}
function closeKbd() {
  releaseAll(); kbdCont = null; kbdFx = null;
  kbdEl.classList.remove('is-open'); kbdEl.setAttribute('inert', ''); kbdEl.setAttribute('aria-hidden', 'true');
  syncKbdToggle();
}
// keyboard hanya dibuka / ditutup manual lewat panah di card transport (tidak lagi otomatis saat track diklik)
const kbdToggle = document.getElementById('kbdToggle');
function syncKbdToggle() {
  const open = kbdEl.classList.contains('is-open'), t = open ? 'Tutup keyboard' : 'Buka keyboard';
  kbdToggle.setAttribute('aria-expanded', String(open));
  kbdToggle.setAttribute('aria-label', t); kbdToggle.title = t;
}
function toggleKbd() {
  if (kbdEl.classList.contains('is-open')) { closeKbd(); return; }
  const cont = (selTrack && selTrack.closest('.trackheader-container')) || document.querySelector('.trackheader-container');
  if (cont) openKbd(cont);   // keyboard memainkan track yang sedang dipilih
}
kbdToggle.addEventListener('click', toggleKbd);
kbdOctDown.addEventListener('click', () => { kbdOct--; buildKeys(); });
kbdOctUp.addEventListener('click', () => { kbdOct++; buildKeys(); });
window.addEventListener('resize', () => { if (kbdEl.classList.contains('is-open') && whitesFit() !== kbdN) buildKeys(); });

initRec(document); initSliders(document); initKnobs(document); initMore(document);

// ===== Pilih track: klik card atau lane-nya (tidak membuka keyboard), efek glass hanya di track yang dipilih =====
let selTrack = document.querySelector('.trackheader--selected');
function selectTrack(cont) {
  const th = cont && cont.querySelector('.trackheader');
  if (!th || selTrack === th) return;
  if (selTrack) selTrack.classList.remove('trackheader--selected');
  selTrack = th; th.classList.add('trackheader--selected');
  fxRack.show(cont.dataset.track);   // panel efek ikut pindah ke track terpilih
  if (kbdEl.classList.contains('is-open')) openKbd(cont);   // keyboard yang sudah terbuka ikut pindah ke track terpilih
}
document.querySelector('.headers-list').addEventListener('pointerdown', e => {
  const c = e.target.closest('.trackheader-container');
  if (c) selectTrack(c);
});
lanesEl.addEventListener('pointerdown', e => {
  const l = e.target.closest('.lane');
  if (l) {
    const hc = document.querySelector('.trackheader-container[data-track="' + l.dataset.track + '"]');
    selectTrack(hc);
  }
});

// ===== Buka / tutup panel track: klik icon instrumen di track mana saja, atau tombol panah di atas =====
const tlistEl = document.querySelector('.tracklist'), panelToggle = document.getElementById('panelToggle');
function setPanel(collapsed) {
  tlistEl.classList.toggle('tracklist--collapsed', collapsed);
  const t = collapsed ? 'Buka panel track' : 'Tutup panel track';
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
  panelToggle.setAttribute('aria-label', t); panelToggle.title = t;
  document.querySelectorAll('.trackheader__left-content').forEach(b => b.title = t);
  closeMenu(true); closeAddMenu(true); dismissAdd(true);
  // timeline bergeser selama panel beranimasi: ruler & toolbar pattern ikut disesuaikan
  const t0 = performance.now();
  (function follow() {
    paintRuler(); patBarPlace();
    if (performance.now() - t0 < 450) requestAnimationFrame(follow); else { paintRuler(true); patBarPlace(); }
  })();
}
const panelCollapsed = () => tlistEl.classList.contains('tracklist--collapsed');
panelToggle.addEventListener('click', () => setPanel(!panelCollapsed()));
document.querySelector('.headers-list').addEventListener('click', e => {
  if (e.target.closest('.trackheader__left-content')) setPanel(!panelCollapsed());
});
document.querySelectorAll('.trackheader__left-content').forEach(b => b.title = 'Tutup panel track');
// Panel efek (kanan): lebar timeline berubah selama animasi, jadi ruler & toolbar pattern digambar ulang tiap frame
const fxRack = initFxRack(() => ({ ctx: audio(), dest: master }), patternBridge);   // isi panel efek: tombol +, card pilihan efek, dan card tiap efek (per track)
initEffectsPanel(settled => { paintRuler(settled); patBarPlace(); }, () => { closeMenu(true); closeAddMenu(true); dismissAdd(true); fxRack.closePicker(true); });
fxRack.show(selTrack ? selTrack.closest('.trackheader-container').dataset.track : null);
// ===== Menu "Tambahkan track" =====
const INSTRUMENTS = [
  {n:'Drums', c:'#ff9f1c'}, {n:'Audio clip', c:'#14b8a6'}, {n:'Supersaw', c:'#5b3de8'},
  {n:'Minisynth', c:'#2f7bff'}, {n:'GMS Synth', c:'#ff4d8d'}, {n:'DW Sampler', c:'#3fbf5f'}, {n:'DERIZ', c:'#22c7e8'}
];
let addMenu = null, addBtn = null;
let trackSeq = Math.max(1, ...[...document.querySelectorAll('.trackheader-container')].map(c => +c.dataset.track));
function closeAddMenu(instant) {
  const m = addMenu, b = addBtn; addMenu = addBtn = null;
  if (b) b.setAttribute('aria-expanded', 'false');
  if (m) (instant === true || instant instanceof Event || REDUCE) ? m.remove() : fadeOut(m);
}
function openAddMenu(btn) {
  closeMenu(true);
  const m = document.createElement('div');
  m.className = 'add-menu';
  m.setAttribute('role', 'menu'); m.setAttribute('aria-label', 'Pilih instrumen');
  m.innerHTML = INSTRUMENTS.map((it, k) => '<button role="menuitem" class="add-menu__item" data-k="' + k + '" style="--i:' + k + '">' + it.n + '</button>').join('');
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect(), w = Math.min(230, innerWidth - 16), h = m.offsetHeight;
  m.style.width = w + 'px';
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  if (r.bottom + 8 + h <= innerHeight - 8) { m.style.top = r.bottom + 8 + 'px'; m.style.transformOrigin = 'left top'; }
  else { m.style.top = Math.max(8, r.top - h - 8) + 'px'; m.style.transformOrigin = 'left bottom'; }
  btn.setAttribute('aria-expanded', 'true');
  addMenu = m; addBtn = btn;
  m.addEventListener('click', e => {
    const it = e.target.closest('.add-menu__item');
    if (!it) return;
    const ins = INSTRUMENTS[+it.dataset.k];
    addTrack(ins);
    closeAddMenu();
    // Audio clip: setelah track dibuat, munculkan card upload audio (menunggu menu selesai menghilang)
    if (ins.n === 'Audio clip') {
      const id = trackSeq, top = parseFloat(m.style.top), left = parseFloat(m.style.left), width = parseFloat(m.style.width);
      const fromBottom = m.style.transformOrigin === 'left bottom', bottom = top + m.offsetHeight;
      setTimeout(() => openAudioUploadCard(id, {left, top, bottom, width, fromBottom}, f => importAudio(id, f)), REDUCE ? 0 : 180);
    }
  });
}
// Icon track "Audio clip": gelombang suara (7 batang, ujung bulat), digambar sendiri dengan SVG supaya tajam di ukuran berapa pun
const ICON_AUDIO_CLIP =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">' +
  '<path d="M3.45 11.5v1M6.3 10.6v2.8M9.15 7.25v9.5M12 10.1v3.8M14.85 8.7v6.65M17.7 10.6v2.8M20.55 11.5v1"/></svg>';
function addTrack(t) {
  const id = ++trackSeq, cont = TRACK_TPL.cloneNode(true);
  cont.dataset.track = id; cont.classList.add('is-new');
  cont.style.setProperty('--track-color', t.c);
  const used = [...document.querySelectorAll('.trackheader__track-name-button span')].map(x => x.textContent);
  let name = t.n, n = 2;
  while (used.includes(name)) name = t.n + ' ' + n++;
  const nm = cont.querySelector('[id^="track-name-"]');
  nm.id = 'track-name-' + id; nm.textContent = name;
  cont.querySelector('.trackheader__track-name-button').title = name;
  if (t.n === 'Audio clip') cont.querySelector('.trackheader__instrument-button .soundtrap-icon').innerHTML = ICON_AUDIO_CLIP;
  cont.querySelector('input[type=range]').setAttribute('aria-label', 'Volume, ' + name);
  const lane = document.createElement('div');
  lane.className = 'lane'; lane.dataset.track = id; lane.style.setProperty('--track-color', t.c);
  document.querySelector('.headers-list').appendChild(cont);
  lanesEl.insertBefore(lane, lanesEl.querySelector('.playhead'));
  initRec(cont); initSliders(cont); initKnobs(cont); initMore(cont);
  cont.querySelector('.trackheader__left-content').title = panelCollapsed() ? 'Buka panel track' : 'Tutup panel track';
  if (t.n === 'Supersaw') fxRack.addInstrument(id, 'supersaw');   // plugin synth otomatis muncul di panel efek track ini
  if (t.n === 'DERIZ') fxRack.addInstrument(id, 'deriz');   // plugin DERIZ (spektrogram + upload audio) juga otomatis muncul di track ini
  selectTrack(cont);
  if (!REDUCE) {
    const H = lane.offsetHeight, o = {duration:520, easing:EASE_OUT, fill:'backwards'};
    cont.style.overflow = lane.style.overflow = 'hidden';
    cont.animate([
      {height:'0px', paddingTop:'0px', opacity:0, transform:'translateX(-36px) scale(.94)'},
      {opacity:1, offset:.55},
      {height:H + 'px', paddingTop:'4px', opacity:1, transform:'none'}], o).onfinish = () => { cont.style.overflow = ''; };
    lane.animate([{height:'0px'},{height:H + 'px'}], o).onfinish = () => { lane.style.overflow = ''; };
  }
  setTimeout(() => cont.scrollIntoView({block:'nearest', inline:'nearest', behavior:'smooth'}), 300);
}
const addTrackBtn = document.querySelector('.addtrack');
addTrackBtn.setAttribute('aria-haspopup', 'dialog');
addTrackBtn.setAttribute('aria-expanded', 'false');
addTrackBtn.addEventListener('click', e => { e.stopPropagation(); addMenu ? closeAddMenu() : openAddMenu(addTrackBtn); });
document.addEventListener('click', e => { if (addMenu && !addMenu.contains(e.target)) closeAddMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && addMenu) { const b = addBtn; closeAddMenu(); b && b.focus(); } });
window.addEventListener('resize', closeAddMenu);
window.addEventListener('scroll', closeAddMenu, true);


// ===== Transport: play / jeda, ke awal, mundur, maju, siklus, rekam =====
let BPM = 120, SEC_PER_BAR = 240 / BPM;               // 4/4: 1 bar = 4 ketukan; BPM bisa diubah lewat panel metronome (tombol M)
const metro = {on: false, countIn: false};
const phEl = document.getElementById('playhead');
const tc = document.querySelector('.transport-controls');
const btnPlay = tc.querySelector('.play'), btnMetro = document.getElementById('btnMetro');
const btnRew = tc.querySelector('.rewind'), btnFwd = tc.querySelector('.forward');
let posBars = 0, playing = false, playRaf = 0, startPos = 0, startCtx = 0, nextBeat = 0, metroTimer = 0, lastBeat = -1;
// Playhead (timeline + piano roll) saat main digerakkan animasi CSS di compositor (tidak lewat JS per frame), jadi tetap mulus
// walau main thread sibuk membunyikan banyak nada. Animasi dibuat dari jam audio (startPos / startCtx) dan dibuat ulang saat
// play / seek / ganti tempo (scheduleClips), zoom timeline (BAR_W berubah), atau piano roll dibuka.
let phAnim = null, phAnimBarW = 0, phHeld = false;
function stopPhAnim() { if (phAnim) { phAnim.cancel(); phAnim = null; } }
function startPhAnim() {
  stopPhAnim(); phHeld = false;
  const now = actx.currentTime, wait = Math.max(0, startCtx - now);
  const pos = startPos + Math.max(0, now - startCtx) / SEC_PER_BAR, left = BARS - pos;
  phAnimBarW = BAR_W;
  phEl.style.translate = (pos * BAR_W) + 'px 0';
  setPianoRollPlayhead((pos - prStartBar) * 4, left > 0 ? {perSec: 4 / SEC_PER_BAR, delay: wait} : undefined);
  if (left <= 0) return;
  phAnim = phEl.animate([{translate: (pos * BAR_W) + 'px 0'}, {translate: (BARS * BAR_W) + 'px 0'}], {duration: left * SEC_PER_BAR * 1000, delay: wait * 1000, easing: 'linear', fill: 'none'});
}
function renderStatic() { stopPhAnim(); phEl.style.translate = (posBars * BAR_W) + 'px 0'; setPianoRollPlayhead((posBars - prStartBar) * 4); }   // dipisah dari transform agar tidak ditimpa animasi masuk
function renderPlayhead() { if (playing && !phHeld) startPhAnim(); else renderStatic(); }
function syncTransportUI() {
  btnPlay.setAttribute('aria-label', playing ? 'Jeda' : 'Putar');
  btnPlay.querySelector('use').setAttribute('href', playing ? '#pause-icon' : '#play-icon');
}
// Posisi playhead dihitung dari jam AudioContext (bukan jam rAF), jadi selalu sinkron dengan suara audio clip
function tick() {
  if (!playing) return;
  posBars = startPos + Math.max(0, actx.currentTime - startCtx) / SEC_PER_BAR;
  if (posBars >= BARS) { posBars = BARS; pausePlay(); return; }
  if (!phHeld && BAR_W !== phAnimBarW) startPhAnim();   // zoom timeline: lebar bar berubah -> buat ulang animasi (timeline tidak auto-scroll mengikuti playhead)
  const b = Math.floor(posBars * 4 + 1e-6);   // titik ketukan di panel metronome + kedip tombol M
  if (b !== lastBeat) { lastBeat = b; metroUI.beat(b % 4); if (metro.on) metroUI.flash(); }
  playRaf = requestAnimationFrame(tick);
}
// Scheduler metronome: tiap 25 ms menjadwalkan klik ketukan yang jatuh dalam 120 ms ke depan (pakai jam AudioContext)
// Nada synth dari piano roll: antrean terurut waktu, dijadwalkan bersama klik metronome (lookahead yang sama)
let synthQ = [], synthI = 0;
// Membuat voice (Supersaw: ~25 node per nada) memakan main thread. Lookahead dibuat lebih panjang dan kerja per pump dibatasi ~3 ms:
// nada yang masih jauh ditunda ke pump berikutnya (25 ms lagi), jadi banyak nada sekaligus tidak menahan satu frame pun.
const SYNTH_AHEAD = .35;
function synthPump(ctx, ahead) {
  const t0 = performance.now();
  while (synthI < synthQ.length && synthQ[synthI].when <= ahead) {
    if (synthQ[synthI].when > ctx.currentTime + .1 && performance.now() - t0 > 3) break;
    const n = synthQ[synthI++];
    if (n.deriz) fxRack.derizPlay(n.track, n.p, n.when, n.dur, n.glides, n.fxId); else playNote(ctx, master, n.track, n.p, n.when, n.dur, n.glides);
  }
}
// Nada satu pattern (kunci nada = key) dijadwalkan ke instrumen track "track"; deriz = lewat sampler DERIZ track itu
function queueNotes(el, key, track, deriz, bs, fxId) {
  const notes = getPianoRollNotes(key); if (!notes.length) return;
  const b0 = pl(el) / BAR_W * 4, b1 = (pl(el) + pw(el)) / BAR_W * 4, from = startPos * 4;
  // slide: nada slide tidak dibunyikan ulang; suara nada sumber dipanjangkan sampai akhir nada slide dan tinggi nadanya meluncur
  notes.sort((a, b) => a.s - b.s);
  const ent = new Map(), list = [];
  notes.forEach(n => {
    const s = b0 + n.s, e = Math.min(s + n.l, b1);
    if (e <= from + 1e-6 || s >= b1) return;
    const src = slideSource(notes, n), en = src && ent.get(src);
    if (en) {
      ent.set(n, en); en.eb = Math.max(en.eb, e);
      if (s <= from) { en.p = n.p; en.cur = n.p; en.glides = []; }   // mulai main di tengah / setelah luncuran: langsung di tinggi nada akhir
      else { en.glides.push({b: s, from: en.cur, to: n.p, d: Math.min(glideBeats(n), e - s)}); en.cur = n.p; }
      return;
    }
    const e1 = {p: n.p, cur: n.p, sb: Math.max(s, from), eb: e, glides: []};
    ent.set(n, e1); list.push(e1);
  });
  list.forEach(en => synthQ.push({track, deriz, fxId, p: en.p, when: startCtx + (en.sb - from) * bs, dur: (en.eb - en.sb) * bs,
    glides: en.glides.length ? en.glides.map(g => ({when: startCtx + (g.b - from) * bs, from: g.from, to: g.to, dur: g.d * bs})) : undefined}));
}
function buildSynthQueue() {
  synthQ = []; synthI = 0;
  const bs = SEC_PER_BAR / 4;   // detik per ketukan
  const derizAll = fxRack.derizAll();
  lanesEl.querySelectorAll('.pattern[data-pr-id]').forEach(el => {
    const track = el.parentElement.dataset.track, id = el.dataset.prId;
    if (hasSynth(track)) queueNotes(el, id, track, false, bs);   // Supersaw milik track pattern ini
    for (const d of derizAll) queueNotes(el, patKey(id, d.id, track), d.track, true, bs, d.id);   // semua DERIZ (di track mana pun) yang mengisi pattern ini
  });
  synthQ.sort((a, b) => a.when - b.when);
}
function metroPump() {
  if (!playing) return;
  const ctx = actx, ahead = ctx.currentTime + .12;
  synthPump(ctx, ctx.currentTime + SYNTH_AHEAD);
  for (;;) {
    const t = startCtx + (nextBeat / 4 - startPos) * SEC_PER_BAR;
    if (t > ahead) break;
    if (metro.on && t >= ctx.currentTime - .01) metroClick(ctx, t, nextBeat % 4 === 0);
    nextBeat++;
  }
}
// Penempatan clip dalam satuan bar (bukan piksel): zoom mengubah piksel tapi tidak mengubah posisi bar, jadi tidak perlu jadwal ulang
const clipPlacements = () => [...lanesEl.querySelectorAll('.pattern[data-clip]')].map(p => ({
  track: p.parentElement.dataset.track, clip: +p.dataset.clip,
  startBar: pl(p) / BAR_W, endBar: (pl(p) + pw(p)) / BAR_W, offsetSec: +p.dataset.off || 0}));
const r3 = v => Math.round(v * 1000) / 1000;
const placementSig = () => JSON.stringify([
  clipPlacements().map(c => [c.track, c.clip, r3(c.startBar), r3(c.endBar), r3(c.offsetSec)]),
  [...lanesEl.querySelectorAll('.pattern[data-pr-id]')].map(p => [p.parentElement.dataset.track, p.dataset.prId, r3(pl(p) / BAR_W), r3(pw(p) / BAR_W)])
]);
let schedSig = '';
function scheduleClips(countIn) {
  const ctx = audio(), beat = 60 / BPM, lead = countIn ? 4 * beat : 0;
  document.querySelectorAll('.trackheader-container').forEach(c => {
    const sl = c.querySelector('input[type=range]'); if (sl) setTrackVolume(c.dataset.track, +sl.value);
  });
  startPos = posBars; startCtx = ctx.currentTime + .05 + lead;   // jeda kecil supaya penjadwalan tidak telat (+ 1 bar count-in)
  metroCancel(ctx);                                                // klik lama (tempo lama) dibatalkan
  if (countIn) for (let i = 0; i < 4; i++) metroClick(ctx, startCtx - (4 - i) * beat, i === 0);
  nextBeat = Math.ceil(startPos * 4 - 1e-6); lastBeat = -1;
  clearInterval(metroTimer); metroTimer = setInterval(metroPump, 25); metroPump();
  const clips = clipPlacements();
  schedSig = placementSig();
  playClips(ctx, master, clips, posBars, SEC_PER_BAR, startCtx);
  stopAllSynth(ctx); fxRack.derizStop(); buildSynthQueue(); synthPump(ctx, ctx.currentTime + SYNTH_AHEAD);
  startPhAnim();
}
function startPlay() {
  if (playing) return;
  if (posBars >= BARS) posBars = 0;
  startMark = posBars;   // titik start: tombol mundur akan kembali ke sini
  playing = true; scheduleClips(metro.countIn);
  playRaf = requestAnimationFrame(tick); syncTransportUI();
}
function pausePlay() {
  if (playing) posBars = Math.min(BARS, startPos + Math.max(0, actx.currentTime - startCtx) / SEC_PER_BAR);   // posisi terakhir dari jam audio (playhead bergerak lewat animasi, bukan lewat tick)
  playing = false; cancelAnimationFrame(playRaf); playRaf = 0; stopClips(actx); stopAllSynth(actx); fxRack.derizStop(); synthQ = []; clearInterval(metroTimer); metroTimer = 0; metroCancel(actx, true); metroUI.beat(-1); syncTransportUI(); phHeld = false; renderStatic();
}
const togglePlay = () => playing ? pausePlay() : startPlay();
function toStart() {
  pausePlay(); posBars = 0; startMark = 0; renderPlayhead(); syncTransportUI();
  wsEl.scrollTo({left: 0, behavior: 'smooth'});
}
function seekBy(d) {
  posBars = Math.max(0, Math.min(BARS, posBars + d)); renderPlayhead();
  if (playing) scheduleClips();   // lompat saat sedang main: suara ikut pindah
  else startMark = posBars;       // playhead digeser manual saat berhenti: posisi barunya jadi titik start
}
// Tombol mundur: kembali ke titik tempat terakhir kali Play dimulai; kalau sudah di sana (atau di sebelum itu), klik lagi = ke awal (bar 1)
let startMark = 0;
function showPlayhead() {   // geser timeline kalau playhead keluar dari layar
  const off = tlEl.offsetLeft, x = off + posBars * BAR_W, l = wsEl.scrollLeft, w = wsEl.clientWidth;
  if (x < l + off + 8 || x > l + w - 24) wsEl.scrollTo({left: Math.max(0, x - w * .3), behavior: REDUCE ? 'instant' : 'smooth'});
}
// Tap / seret penggaris piano roll: playhead pindah ke posisi itu (relatif awal pattern yang dibuka)
setPianoRollSeekHandler((beats, final) => {
  posBars = Math.max(0, Math.min(BARS, prStartBar + beats / 4));
  if (!final) { if (playing) phHeld = true; renderStatic(); return; }   // saat diseret: tahan playhead di jari (animasi berhenti), suara pindah saat dilepas
  phHeld = false; renderPlayhead();
  if (playing) scheduleClips();   // sedang main: suara ikut pindah (hanya saat jari dilepas)
  else startMark = posBars;       // berhenti: posisi baru jadi titik start
});
function rewind() {
  const to = posBars > startMark + 1e-6 ? startMark : 0;
  startMark = to;
  posBars = to; renderPlayhead(); showPlayhead();
  if (playing) scheduleClips();   // sedang main: lanjut main dari titik tujuan
}
// ===== Metronome & BPM project =====
// Ganti BPM: 1 bar jadi lebih pendek / panjang. Posisi playhead (dalam bar) tetap; audio clip mempertahankan isi audionya,
// jadi lebarnya (dalam bar) ikut berubah (dipotong kalau menabrak clip berikutnya, timeline memanjang kalau perlu).
function setBpm(v) {
  v = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v)));
  if (v === BPM) return;
  const ratio = SEC_PER_BAR / (240 / v);   // panjang bar lama / panjang bar baru
  BPM = v; SEC_PER_BAR = 240 / v;
  const clips = [...lanesEl.querySelectorAll('.pattern[data-clip]')];
  if (clips.length) {
    const need = Math.max(...clips.map(p => (pl(p) + pw(p) * ratio) / BAR_W));
    if (need > BARS) growTimeline(Math.min(MAX_BARS, Math.ceil(need) + 1));
    clips.forEach(p => {
      const st = pl(p); let hi = W;
      otherPats(p).forEach(o => { if (pl(o) > st + 1) hi = Math.min(hi, pl(o)); });
      p.style.width = Math.max(Math.min(pw(p) * ratio, hi - st), Math.min(BAR_W / 2, hi - st)) + 'px';
    });
    if (selPat) { handleSide(selPat); patBarPlace(); }
  }
  if (playing) scheduleClips();                 // tempo baru langsung terdengar, posisi tidak loncat
  undoStack = []; redoStack = []; histCur = histCapture(); histSync();   // lebar clip berubah: riwayat undo dimulai ulang
}
btnPlay.addEventListener('click', togglePlay);
const metroUI = initMetronomePanel(btnMetro, {
  getBpm: () => BPM, setBpm,
  isOn: () => metro.on,
  setOn: on => {
    metro.on = on;
    if (on && !playing) metroClick(audio(), actx.currentTime + .02, true);   // contoh bunyi saat dinyalakan
    if (!on) metroCancel(actx);
  },
  isCountIn: () => metro.countIn, setCountIn: on => { metro.countIn = on; },
});
// mundur / maju: 1 bar per klik, tahan untuk terus bergeser
function holdSeek(btn, d) {
  let to = 0, iv = 0;
  const stop = () => { clearTimeout(to); clearInterval(iv); to = iv = 0; };
  btn.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    seekBy(d); stop();
    to = setTimeout(() => { iv = setInterval(() => seekBy(d), 90); }, 380);
  });
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(ev => btn.addEventListener(ev, stop));
  btn.addEventListener('click', e => { if (e.detail === 0) seekBy(d); });   // aktivasi lewat keyboard (Enter/Space)
}
btnRew.addEventListener('click', rewind);   // juga menangani Enter / Space saat tombol difokus
holdSeek(btnFwd, 1);
// pintasan: Space = putar/jeda, panah kiri/kanan = mundur/maju
let spaceHandled = false;
document.addEventListener('keydown', e => {
  if (e.metaKey || e.altKey || typing(e.target) || (e.target.closest && e.target.closest('[role="slider"]') && e.key !== ' ')) return;
  if (e.key === ' ' || e.code === 'Space') {
    if (e.target.closest && e.target.closest('[role="slider"], input[type="range"]')) return;
    e.preventDefault(); spaceHandled = true;
    if (!e.repeat) togglePlay();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.shiftKey && !(e.target.matches && e.target.matches('input[type="range"]'))) {
    e.preventDefault(); e.key === 'ArrowLeft' ? rewind() : seekBy(1);
  }
});
document.addEventListener('keyup', e => {   // cegah Space ikut "mengklik" tombol yang sedang fokus
  if ((e.key === ' ' || e.code === 'Space') && spaceHandled) { e.preventDefault(); spaceHandled = false; }
});
renderPlayhead(); syncTransportUI();

// ===== Audio clip: upload -> decode -> masuk timeline -> bersuara =====
let toastEl = null, toastT = 0;
function toast(msg, ms = 3200) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'daw-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastT); if (ms) toastT = setTimeout(() => { toastEl.hidden = true; }, ms);
}
function growTimeline(n) {   // timeline memanjang supaya audio panjang (lagu) muat utuh
  BARS = n; sizeRuler(); paintRuler(true);
}
async function importAudio(trackId, file) {
  const ctx = audio(), laneSel = '.lane[data-track="' + trackId + '"]';
  toast('Memuat audio…', 0);
  let buf;
  try { buf = await decodeFile(ctx, file); }
  catch (err) { console.error(err); toast('File audio tidak bisa dibaca / format tidak didukung'); return; }
  const lane = lanesEl.querySelector(laneSel);
  if (!lane) { toast('', 1); return; }   // track sudah dihapus selama decode
  const durBars = buf.duration / SEC_PER_BAR;
  if (durBars > BARS) growTimeline(Math.min(MAX_BARS, Math.ceil(durBars) + 1));
  const width = Math.max(BAR_W / 2, Math.min(durBars * BAR_W, W));
  const el = createPattern(lane, {start: 0, width}, {clip: addBuffer(buf), off: 0});
  el.querySelector('.pattern__title').textContent = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Audio';
  wsEl.scrollTo({left: 0, behavior: 'smooth'});
  toast(durBars > MAX_BARS ? 'Audio dipotong: timeline maksimum ' + MAX_BARS + ' bar' : 'Audio ditambahkan ke timeline');
}
// waveform digambar ulang hanya kalau jendela audio berubah (panjang / offset), bukan saat zoom
function syncWaves() {
  lanesEl.querySelectorAll('.pattern[data-clip]').forEach(p => {
    const off = +p.dataset.off || 0, dur = pw(p) / BAR_W * SEC_PER_BAR, key = off.toFixed(3) + '|' + dur.toFixed(3);
    if (p.dataset.wk !== key) { p.dataset.wk = key; renderWave(p, +p.dataset.clip, off, dur); }
  });
}
let waveRaf = 0, resyncT = 0;
new MutationObserver(ms => {
  const hit = ms.some(m => m.type === 'childList'
    ? [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType === 1 && n.classList.contains('pattern'))
    : m.target.classList && m.target.classList.contains('pattern'));
  if (!hit) return;
  if (!waveRaf) waveRaf = requestAnimationFrame(() => { waveRaf = 0; syncWaves(); });
  // clip digeser/dihapus saat main -> jadwal ulang. Zoom hanya mengubah piksel, jadi dilewati (kalau tidak, suara putus-putus saat zoom)
  if (playing) { clearTimeout(resyncT); resyncT = setTimeout(() => { if (playing && placementSig() !== schedSig) scheduleClips(); }, 120); }
}).observe(lanesEl, {childList: true, subtree: true, attributes: true, attributeFilter: ['style']});
// switch on/off track (ungu = nyala): mati -> track hening (meter ikut nol), pattern di lane diredupkan
document.querySelector('.headers-list').addEventListener('click', e => {
  const sw = e.target.closest && e.target.closest('.trackheader__pwr'), c = sw && sw.closest('.trackheader-container');
  if (!c) return;
  const off = sw.getAttribute('aria-checked') === 'true';   // sebelumnya nyala -> sekarang mati
  sw.setAttribute('aria-checked', String(!off));
  c.classList.toggle('is-off', off);
  const lane = document.querySelector('.lane[data-track="' + c.dataset.track + '"]');
  if (lane) lane.classList.toggle('is-off', off);
  setTrackMuted(c.dataset.track, off);
});
// slider volume track -> volume audio clip (langsung terdengar saat diputar)
document.querySelector('.headers-list').addEventListener('input', e => {
  const sl = e.target.closest && e.target.closest('input[type=range]'), c = sl && sl.closest('.trackheader-container');
  if (c) setTrackVolume(c.dataset.track, +sl.value);
});

// ===== Zoom timeline =====
const LOGR = Math.log(BAR_MAX / BAR_MIN);
let paintRaf = 0;
wsEl.addEventListener('scroll', () => { if (!paintRaf) paintRaf = requestAnimationFrame(() => { paintRaf = 0; paintRuler(); }); }, {passive: true});
window.addEventListener('resize', () => paintRuler(true));
function setZoom(next, clientX) {
  next = Math.max(BAR_MIN, Math.min(BAR_MAX, next));
  if (Math.abs(next - BAR_W) < 0.01) return;
  const ratio = next / BAR_W;
  if (clientX == null) {
    const r = wsEl.getBoundingClientRect(), tl = document.querySelector('.tracklist').offsetWidth;
    clientX = r.left + tl + (r.width - tl) / 2;
  }
  const x = clientX - tlEl.getBoundingClientRect().left;   // titik di timeline yang dijaga tetap diam
  dismissAdd(true);
  BAR_W = next;
  document.documentElement.style.setProperty('--bar', BAR_W + 'px');
  document.documentElement.style.setProperty('--beat-a', BAR_W >= 56 ? .08 : 0);
  document.documentElement.style.setProperty('--sub-a', BAR_W >= 160 ? .045 : 0);
  document.documentElement.style.setProperty('--mid-a', BAR_W >= 640 ? .035 : 0);
  document.documentElement.style.setProperty('--fine-a', BAR_W >= 1280 ? .03 : 0);
  document.querySelectorAll('.pattern').forEach(p => {
    p.style.left = pl(p) * ratio + 'px';
    p.style.width = pw(p) * ratio + 'px';
  });
  sizeRuler();
  wsEl.scrollTo({left: wsEl.scrollLeft + x * (ratio - 1), behavior: 'instant'});
  paintRuler(true);
  if (selPat) handleSide(selPat);
  renderPlayhead();
}
// Zoom halus: target diperbarui, lalu BAR_W "mengejar" target tiap frame (interpolasi eksponensial)
const clampBar = v => Math.max(BAR_MIN, Math.min(BAR_MAX, v));
let zoomTarget = BAR_W, zoomAnchor = null, zoomRaf = 0;
function zoomStep() {
  const err = Math.log(zoomTarget / BAR_W);
  if (Math.abs(err) < 0.004) { setZoom(zoomTarget, zoomAnchor); zoomRaf = 0; return; }
  setZoom(BAR_W * Math.exp(err * 0.22), zoomAnchor);
  zoomRaf = requestAnimationFrame(zoomStep);
}
function zoomTo(target, clientX) {
  zoomTarget = clampBar(target); zoomAnchor = clientX;
  if (!zoomRaf) zoomRaf = requestAnimationFrame(zoomStep);
}
function zoomNow(next, clientX) {   // langsung, tanpa animasi (slider & pinch jari)
  if (zoomRaf) { cancelAnimationFrame(zoomRaf); zoomRaf = 0; }
  setZoom(next, clientX); zoomTarget = BAR_W;
}
const ZSTEP = 1.2;
// Ctrl + scroll / pinch trackpad
wsEl.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  // deltaY mouse wheel bisa ±100 per klik (terlalu besar) -> dibatasi; trackpad pinch nilainya kecil jadi tetap halus
  let dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  dy = Math.max(-24, Math.min(24, dy));
  zoomTo(zoomTarget * Math.exp(-dy * 0.008), e.clientX);
}, {passive: false});
// Pinch dua jari di layar sentuh
let pinch = null;
const tdist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
wsEl.addEventListener('touchstart', e => {
  if (e.touches.length === 2) { pinch = {d: tdist(e.touches), bar: BAR_W}; wsEl.style.overflow = 'hidden'; dismissAdd(true); }
}, {passive: true});
wsEl.addEventListener('touchmove', e => {
  if (!pinch || e.touches.length !== 2) return;
  if (e.cancelable) e.preventDefault();
  zoomNow(pinch.bar * tdist(e.touches) / pinch.d, (e.touches[0].clientX + e.touches[1].clientX) / 2);
}, {passive: false});
const endPinch = e => { if (pinch && e.touches.length < 2) { pinch = null; wsEl.style.overflow = ''; } };
wsEl.addEventListener('touchend', endPinch);
wsEl.addEventListener('touchcancel', endPinch);
// ===== Undo / Redo: riwayat pattern (buat, geser, panjangkan, salin, bagi, hapus, ubah nama) =====
const btnUndo = document.getElementById('btnUndo'), btnRedo = document.getElementById('btnRedo');
const HIST_MAX = 100, r4 = v => Math.round(v * 1e4) / 1e4;   // posisi disimpan dalam satuan bar, jadi zoom tidak dihitung sebagai perubahan
let undoStack = [], redoStack = [], histCur = null, histTimer = 0, histPressed = false;
function histCapture() {
  const ids = [], pats = {};
  lanesEl.querySelectorAll('.lane').forEach(l => {
    ids.push(l.dataset.track);
    pats[l.dataset.track] = [...l.querySelectorAll('.pattern')].map(p => ({s: r4(pl(p) / BAR_W), w: r4(pw(p) / BAR_W), t: p.querySelector('.pattern__title').textContent, c: p.dataset.clip || '', o: r4(+p.dataset.off || 0)}))
      .sort((a, b) => a.s - b.s || a.w - b.w || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  });
  return {ids: ids.join(','), pats};
}
function histPulse(btn, cls) { btn.classList.remove('is-pop', 'is-tap'); void btn.offsetWidth; btn.classList.add(cls); }
function histSync() {
  const u = !undoStack.length, r = !redoStack.length;
  if (btnUndo.disabled && !u) histPulse(btnUndo, 'is-pop');   // baru jadi aktif
  if (btnRedo.disabled && !r) histPulse(btnRedo, 'is-pop');
  btnUndo.disabled = u; btnRedo.disabled = r;
}
function histCommit() {
  histTimer = 0;
  // tunggu sampai jari dilepas & pengeditan nama selesai, supaya satu gerakan = satu langkah
  if (histPressed || document.querySelector('.pattern__title[contenteditable="true"]')) { histTimer = setTimeout(histCommit, 200); return; }
  const now = histCapture();
  if (JSON.stringify(now) === JSON.stringify(histCur)) return;
  if (now.ids !== histCur.ids) { undoStack = []; redoStack = []; }   // track ditambah / dihapus: riwayat dimulai ulang
  else { undoStack.push(histCur); if (undoStack.length > HIST_MAX) undoStack.shift(); redoStack = []; }
  histCur = now; histSync();
}
const histSchedule = () => { clearTimeout(histTimer); histTimer = setTimeout(histCommit, 250); };
function histApply(st) {
  selectPattern(null); dismissAdd(true);
  lanesEl.querySelectorAll('.lane').forEach(l => {
    const want = (st.pats[l.dataset.track] || []).map(x => ({...x, used: false}));
    [...l.querySelectorAll('.pattern')].forEach(p => {   // pattern yang sudah cocok dibiarkan, hanya yang berbeda diganti
      const s = r4(pl(p) / BAR_W), w = r4(pw(p) / BAR_W), t = p.querySelector('.pattern__title').textContent;
      const m = want.find(x => !x.used && x.s === s && x.w === w && x.t === t && x.c === (p.dataset.clip || '') && x.o === r4(+p.dataset.off || 0));
      if (m) m.used = true; else p.remove();
    });
    want.filter(x => !x.used).forEach(x => {
      const n = createPattern(l, {start: x.s * BAR_W, width: x.w * BAR_W}, x.c ? {clip: +x.c, off: x.o} : null);
      n.querySelector('.pattern__title').textContent = x.t;
    });
  });
  histCur = st;   // sudah sama dengan keadaan sekarang, jadi tidak dicatat ulang
}
function histFlush() { if (histTimer) { clearTimeout(histTimer); histCommit(); } }
function histUndo() { histFlush(); if (!undoStack.length) return; redoStack.push(histCur); histApply(undoStack.pop()); histSync(); }
function histRedo() { histFlush(); if (!redoStack.length) return; undoStack.push(histCur); histApply(redoStack.pop()); histSync(); }
const histRelevant = m => {
  if (m.type === 'childList') return [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType === 1 && (n.classList.contains('pattern') || n.classList.contains('lane')));
  const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
  return !!(t && t.closest('.pattern'));   // abaikan playhead & toolbar yang terus bergerak
};
new MutationObserver(ms => { if (ms.some(histRelevant)) histSchedule(); })
  .observe(lanesEl, {childList: true, subtree: true, attributes: true, attributeFilter: ['style'], characterData: true});
document.addEventListener('pointerdown', () => { histPressed = true; }, true);
['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => { histPressed = false; }, true));
btnUndo.addEventListener('click', () => { histPulse(btnUndo, 'is-tap'); histUndo(); });
btnRedo.addEventListener('click', () => { histPulse(btnRedo, 'is-tap'); histRedo(); });
document.addEventListener('keydown', e => { if (e.key === 'Home' && !typing(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toStart(); } });   // ke awal: tombolnya dihapus, pintasan Home tetap ada
document.addEventListener('keydown', e => {   // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z atau Ctrl+Y = redo (saat mengetik nama, biarkan undo bawaan browser)
  if (!(e.ctrlKey || e.metaKey) || e.altKey || typing(e.target)) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); e.shiftKey ? histRedo() : histUndo(); }
  else if (k === 'y') { e.preventDefault(); histRedo(); }
});
histCur = histCapture(); histSync();

initTrackMeters();   // meter level stereo di card track
