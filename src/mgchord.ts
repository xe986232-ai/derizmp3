// MGCHORD: pembuat chord progression ala ChordJam. Jendela plugin (dibuka dari halaman Plugin di panel efek, seperti MPCS):
//   Scale / Scale Type / Octave / Chord Type -> Voices (5 suara, geser oktaf, invert) + Velocity + gaya main (Block / Strum / Arp)
//   -> baris chord (blok merah, klik untuk pilih & ubah derajat / panjang) -> Piano Roll View (hasil nada) -> keyboard.
// Tombol "Pattern" mengirim nada ke pattern yang sedang dipilih di timeline; tombol MIDI mengunduh file .mid.
// Inti teori ada di mgchord-theory.ts (murni, dites lewat tools/mgchord-test.ts).

import {
  CHORD_TYPE_NAMES, NOTE_NAMES, PRESETS, ROMAN, SCALE_NAMES, STYLES, VOICES,
  buildNotes, chordAt, defaultVoicing, midiName, randomProgression, slotsOf, toMidi, totalBeats, voice,
  type OutNote, type PlayStyle, type Rhythm, type Settings, type Slot, type Voicing,
} from './mgchord-theory';

// Jembatan ke main.ts: tempo project + kirim nada ke pattern terpilih (mengembalikan pesan kalau gagal, null kalau berhasil)
export interface MgBridge { bpm(): number; send(notes: { p: number; s: number; l: number; v: number }[], beats: number): string | null }
let bridge: MgBridge | null = null;
export const setMgchordBridge = (b: MgBridge): void => { bridge = b; };

interface Saved { st: Settings; vc: Voicing; rh: Rhythm; slots: Slot[]; sel: number; preset: number }
export type MgchordSaved = Saved;
const initial = (): Saved => {
  const p = PRESETS[0];
  return {
    st: { root: 0, scale: p.scale, octave: 0, chordType: 'Diatonic 9th' }, vc: defaultVoicing(),
    rh: { style: 'Block', rate: 0.5, strum: 0.12 }, slots: slotsOf(p), sel: 0, preset: 0,
  };
};
let S: Saved = initial();
let root: HTMLElement | null = null;
let openFn: (() => void) | null = null, refreshFn: (() => void) | null = null;

export const mgchordExport = (): MgchordSaved | null => (root ? JSON.parse(JSON.stringify(S)) : null);
export function mgchordImport(saved?: MgchordSaved | null): void {   // dipanggil saat membuka project (null = kembali ke bawaan)
  const base = initial();
  if (saved && saved.st && Array.isArray(saved.slots) && saved.slots.length) {
    S = { ...base, ...saved, st: { ...base.st, ...saved.st }, vc: { ...base.vc, ...saved.vc }, rh: { ...base.rh, ...saved.rh } };
    S.sel = Math.min(Math.max(0, S.sel | 0), S.slots.length - 1);
  } else S = base;
  refreshFn?.();
}
export function openMgchord(): void { if (!root) build(); openFn?.(); }

const svg = (inner: string, size = 16): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON = {
  play: svg('<path d="M8 5l12 7-12 7z" fill="currentColor" stroke="none"/>', 18),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>', 18),
  dice: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/>', 30),
  dl: svg('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>', 15),
  send: svg('<path d="M4 12h13M12 6l6 6-6 6"/>', 15),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 14),
  prev: svg('<path d="M15 6l-6 6 6 6"/>', 14),
  next: svg('<path d="M9 6l6 6-6 6"/>', 14),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 14),
  minus: svg('<path d="M5 12h14"/>', 14),
};
const mod = (n: number, m: number): number => ((n % m) + m) % m;
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const LENS = [1, 2, 3, 4, 6, 8, 12, 16];   // pilihan panjang chord (ketukan)
const MAX_BEATS = 64;                      // 16 bar
const BLACK_PC = new Set([1, 3, 6, 8, 10]);
const KEY_LO = 60, KEY_HI = 86;            // keyboard C4..D6, seperti ChordJam

const romanOf = (deg: number, iv: number[]): string => { const r = ROMAN[mod(deg, 7)]; return iv[1] === 3 ? r.toLowerCase() : r; };
const fmtLen = (b: number): string => (b % 4 === 0 ? b / 4 + ' bar' : b + ' beat');
const opts = (list: string[], cur: string): string => list.map(x => `<option${x === cur ? ' selected' : ''}>${x}</option>`).join('');

// ---------- suara preview (sederhana: saw + triangle -> lowpass), AudioContext sendiri ----------
let actx: AudioContext | null = null, out: GainNode | null = null;
function ac(): AudioContext {
  if (!actx) {
    const A = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    actx = new A({ latencyHint: 'interactive' });
    out = actx.createGain(); out.gain.value = 0.42;
    const comp = actx.createDynamicsCompressor(); out.connect(comp); comp.connect(actx.destination);
  }
  if (actx.state === 'suspended') void actx.resume();
  return actx;
}
function tone(c: AudioContext, dest: AudioNode, midi: number, when: number, dur: number, vel: number): void {
  const f = 440 * 2 ** ((midi - 69) / 12), g = c.createGain(), lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 900 + vel * 3200; lp.Q.value = 0.7;
  const o1 = c.createOscillator(), o2 = c.createOscillator();
  o1.type = 'sawtooth'; o2.type = 'triangle'; o1.frequency.value = f; o2.frequency.value = f; o1.detune.value = -4; o2.detune.value = 5;
  const peak = 0.16 * (0.25 + 0.75 * vel * vel) / Math.sqrt(VOICES), end = when + Math.max(0.06, dur);
  g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(peak, when + 0.012);
  g.gain.setTargetAtTime(peak * 0.62, when + 0.02, 0.35);
  g.gain.setTargetAtTime(0.0001, end, 0.09);
  o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(dest);
  o1.start(when); o2.start(when); o1.stop(end + 0.6); o2.stop(end + 0.6);
  o2.onended = () => { g.disconnect(); lp.disconnect(); };
}

function build(): void {
  const el = document.createElement('div');
  el.className = 'mgc'; el.hidden = true;
  const voiceRows = [5, 4, 3, 2, 1].map(n =>
    `<div class="mgc__vrow" data-v="${n - 1}"><button type="button" class="mgc__vdot" data-a="von" aria-pressed="true" aria-label="Voice ${n}">${n}</button>` +
    `<div class="mgc__seg" role="group" aria-label="Oktaf voice ${n}">${[-12, 0, 12].map(s => `<button type="button" data-a="vshift" data-s="${s}">${s > 0 ? '+' + s : s}</button>`).join('')}</div></div>`).join('');
  const velRows = [5, 4, 3, 2, 1].map(n => `<div class="mgc__vbar" data-v="${n - 1}" role="slider" tabindex="0" aria-label="Velocity voice ${n}" aria-valuemin="0" aria-valuemax="100"><i></i></div>`).join('');
  el.innerHTML =
    '<div class="mgc__back"></div>' +
    '<div class="mgc__win" role="dialog" aria-modal="true" aria-label="MGCHORD" tabindex="-1">' +
      '<header class="mgc__head">' +
        '<span class="mgc__logo"><i aria-hidden="true"></i><b>mgchord</b></span>' +
        `<button type="button" class="mgc__play" data-a="play" aria-label="Putar preview" title="Putar / henti preview (Spasi)">${ICON.play}</button>` +
        '<output class="mgc__bpm" title="Tempo project"></output>' +
        `<div class="mgc__preset"><button type="button" data-a="pprev" aria-label="Preset sebelumnya">${ICON.prev}</button><span class="mgc__pname"></span><button type="button" data-a="pnext" aria-label="Preset berikutnya">${ICON.next}</button></div>` +
        `<button type="button" class="mgc__hb" data-a="midi" title="Download MIDI" aria-label="Download MIDI">${ICON.dl}<span>MIDI</span></button>` +
        `<button type="button" class="mgc__hb mgc__hb--go" data-a="send" title="Kirim nada ke pattern yang dipilih di timeline" aria-label="Kirim ke pattern">${ICON.send}<span>Pattern</span></button>` +
        '<button type="button" class="mgc__hb" data-a="reset" title="Kembalikan semua ke bawaan">Reset</button>' +
        `<button type="button" class="mgc__x" data-a="close" aria-label="Tutup" title="Tutup (Esc)">${ICON.close}</button>` +
      '</header>' +
      '<div class="mgc__body">' +
      '<div class="mgc__row1">' +
        `<label class="mgc__sel"><span>Scale</span><select data-k="root">${opts(NOTE_NAMES, NOTE_NAMES[S.st.root])}</select></label>` +
        `<label class="mgc__sel"><span>Scale Type</span><select data-k="scale">${opts(SCALE_NAMES, S.st.scale)}</select></label>` +
        '<div class="mgc__oct"><span>Octave</span><button type="button" data-a="oct-" aria-label="Oktaf turun">' + ICON.minus + '</button><output></output><button type="button" data-a="oct+" aria-label="Oktaf naik">' + ICON.plus + '</button></div>' +
        `<button type="button" class="mgc__dice" data-a="dice" aria-label="Acak progression" title="Acak progression">${ICON.dice}</button>` +
        `<label class="mgc__sel mgc__sel--r"><span>Chord Type</span><select data-k="chordType">${opts(CHORD_TYPE_NAMES, S.st.chordType)}</select></label>` +
      '</div>' +
      '<div class="mgc__mid">' +
        '<section class="mgc__panel"><h4>Voices</h4>' +
          `<div class="mgc__inv"><span>Invert</span><button type="button" data-a="inv-" aria-label="Invert turun">${ICON.minus}</button><output></output><button type="button" data-a="inv+" aria-label="Invert naik">${ICON.plus}</button></div>` +
          voiceRows + '</section>' +
        `<section class="mgc__panel"><h4>Velocity</h4><div class="mgc__vels">${velRows}</div></section>` +
        '<section class="mgc__panel"><h4>Style</h4>' +
          `<div class="mgc__seg mgc__seg--wrap" role="group" aria-label="Gaya main">${STYLES.map(s => `<button type="button" data-a="style" data-s="${s}">${s}</button>`).join('')}</div>` +
          '<div class="mgc__sub mgc__sub--arp"><span>Rate</span><div class="mgc__seg">' + [[1, '1/4'], [0.5, '1/8'], [0.25, '1/16']].map(([r, l]) => `<button type="button" data-a="rate" data-s="${r}">${l}</button>`).join('') + '</div></div>' +
          '<div class="mgc__sub mgc__sub--strum"><span>Strum</span><div class="mgc__seg">' + [[0.06, 'Tight'], [0.12, 'Mid'], [0.25, 'Loose']].map(([r, l]) => `<button type="button" data-a="strum" data-s="${r}">${l}</button>`).join('') + '</div></div>' +
          '<p class="mgc__hint">Block = semua nada bersamaan. Strum = nada dipetik berurutan. Arp = nada diulang satu per satu.</p></section>' +
      '</div>' +
      '<section class="mgc__seq">' +
        '<div class="mgc__bar"><b>Progression</b><output class="mgc__len"></output><span class="mgc__sp"></span>' +
          `<span class="mgc__sel-name"></span>` +
          `<button type="button" data-a="deg-" aria-label="Derajat turun" title="Derajat chord turun">${ICON.prev}</button><span class="mgc__tag">Degree</span><button type="button" data-a="deg+" aria-label="Derajat naik" title="Derajat chord naik">${ICON.next}</button>` +
          `<button type="button" data-a="len-" aria-label="Pendekkan" title="Pendekkan chord">${ICON.prev}</button><span class="mgc__tag">Length</span><button type="button" data-a="len+" aria-label="Panjangkan" title="Panjangkan chord">${ICON.next}</button>` +
          `<button type="button" data-a="add" aria-label="Tambah chord" title="Tambah chord di akhir">${ICON.plus}</button><button type="button" data-a="del" aria-label="Hapus chord" title="Hapus chord terpilih">${ICON.minus}</button></div>` +
        '<div class="mgc__lane" role="listbox" aria-label="Chord progression"></div>' +
        '<div class="mgc__roll"><span class="mgc__rt">Piano Roll View</span><canvas class="mgc__cv" role="img" aria-label="Piano roll hasil chord"></canvas></div>' +
      '</section>' +
      '<div class="mgc__kbrow"><div class="mgc__pill" aria-live="polite"></div><div class="mgc__kb" role="group" aria-label="Keyboard"></div></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  root = el;

  const win = el.querySelector<HTMLElement>('.mgc__win')!;
  const $ = <T extends HTMLElement>(q: string): T => el.querySelector<T>(q)!;
  const lane = $('.mgc__lane'), cv = $<HTMLCanvasElement>('.mgc__cv'), kb = $('.mgc__kb'), pill = $('.mgc__pill'), g = cv.getContext('2d')!;
  let notes: OutNote[] = [], playing = false, phBeat = -1, raf = 0, prevFocus: Element | null = null;

  // ---------- keyboard ----------
  const whites: number[] = [], blacks: number[] = [];
  for (let p = KEY_LO; p <= KEY_HI; p++) (BLACK_PC.has(p % 12) ? blacks : whites).push(p);
  kb.innerHTML = whites.map(p => `<button type="button" class="mgc__k" data-p="${p}" aria-label="${midiName(p)}"><span>${p % 12 === 0 ? midiName(p) : ''}</span></button>`).join('') +
    blacks.map(p => { const wi = whites.filter(w => w < p).length; return `<button type="button" class="mgc__k mgc__k--b" data-p="${p}" aria-label="${midiName(p)}" style="left:calc(${(wi / whites.length) * 100}% - ${100 / whites.length * 0.3}%);width:${100 / whites.length * 0.6}%"></button>`; }).join('');
  const keyEls = new Map<number, HTMLElement>();
  kb.querySelectorAll<HTMLElement>('.mgc__k').forEach(k => keyEls.set(+k.dataset.p!, k));
  const fold = (p: number): number => { let q = p; while (q < KEY_LO) q += 12; while (q > KEY_HI) q -= 12; return q; };

  // ---------- render ----------
  const selChord = () => chordAt(S.st, S.slots[S.sel].deg);
  function recompute(): void { notes = buildNotes(S.st, S.slots, S.vc, S.rh); }
  function renderLane(): void {
    const tot = totalBeats(S.slots);
    lane.innerHTML = S.slots.map((sl, i) => {
      const c = chordAt(S.st, sl.deg);
      return `<button type="button" role="option" class="mgc__ch${i === S.sel ? ' is-sel' : ''}" data-i="${i}" aria-selected="${i === S.sel}" style="flex:${sl.beats} 1 0"><b>${c.name}</b><small>${romanOf(sl.deg, c.iv)}</small></button>`;
    }).join('');
    $('.mgc__len').textContent = tot / 4 + (tot === 4 ? ' bar' : ' bars') + ' · ' + S.slots.length + ' chord';
    const c = selChord(), sl = S.slots[S.sel];
    $('.mgc__sel-name').textContent = `${c.name} · ${romanOf(sl.deg, c.iv)} · ${fmtLen(sl.beats)}`;
  }
  function renderKeys(): void {
    const lit = new Set(voice(selChord(), S.vc).map(n => fold(n.p)));
    keyEls.forEach((k, p) => k.classList.toggle('is-lit', lit.has(p)));
    pill.textContent = selChord().name;
  }
  function renderControls(): void {
    el.querySelectorAll<HTMLSelectElement>('select[data-k]').forEach(s => {
      const k = s.dataset.k!; s.value = k === 'root' ? NOTE_NAMES[S.st.root] : String((S.st as unknown as Record<string, unknown>)[k]);
    });
    $('.mgc__oct output').textContent = (S.st.octave > 0 ? '+' : '') + S.st.octave;
    $('.mgc__inv output').textContent = String(S.vc.invert);
    el.querySelectorAll<HTMLElement>('.mgc__vrow').forEach(r => {
      const i = +r.dataset.v!;
      r.classList.toggle('is-off', !S.vc.on[i]);
      r.querySelector('.mgc__vdot')!.setAttribute('aria-pressed', String(S.vc.on[i]));
      r.querySelectorAll<HTMLElement>('[data-s]').forEach(b => b.classList.toggle('is-on', +b.dataset.s! === S.vc.shift[i]));
    });
    el.querySelectorAll<HTMLElement>('.mgc__vbar').forEach(b => {
      const i = +b.dataset.v!, v = S.vc.vel[i];
      b.classList.toggle('is-off', !S.vc.on[i]);
      b.querySelector<HTMLElement>('i')!.style.width = Math.round(v * 100) + '%'; b.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    });
    el.querySelectorAll<HTMLElement>('[data-a="style"]').forEach(b => b.classList.toggle('is-on', b.dataset.s === S.rh.style));
    el.querySelectorAll<HTMLElement>('[data-a="rate"]').forEach(b => b.classList.toggle('is-on', +b.dataset.s! === S.rh.rate));
    el.querySelectorAll<HTMLElement>('[data-a="strum"]').forEach(b => b.classList.toggle('is-on', +b.dataset.s! === S.rh.strum));
    win.dataset.style = S.rh.style;
    $('.mgc__pname').textContent = S.preset >= 0 ? PRESETS[S.preset].name : 'Custom';
    $('.mgc__bpm').textContent = (bridge ? bridge.bpm() : 120).toFixed(2);
  }

  // Piano Roll View: grid bar / ketukan, blok nada (alpha = velocity), chord terpilih disorot, playhead
  function drawRoll(): void {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, W = Math.floor(r.width), H = Math.floor(r.height);
    if (W < 20 || H < 20) return;
    if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) { cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const KW = 40, tot = totalBeats(S.slots), x0 = KW, pw = W - KW, ppb = pw / tot;
    let lo = 127, hi = 0; for (const n of notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    if (hi < lo) { lo = 48; hi = 72; }
    lo -= 2; hi += 2; while (hi - lo < 14) { lo--; hi++; }
    const rows = hi - lo + 1, rh = H / rows;
    const yOf = (p: number): number => (hi - p) * rh;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#17152e'; g.fillRect(0, 0, W, H);
    for (let p = lo; p <= hi; p++) { g.fillStyle = BLACK_PC.has(p % 12) ? 'rgba(0,0,0,.28)' : 'rgba(255,255,255,.025)'; g.fillRect(x0, yOf(p), pw, rh); }
    let t = 0;   // sorot chord terpilih + garis batas chord
    S.slots.forEach((sl, i) => {
      if (i === S.sel) { g.fillStyle = 'rgba(124,92,255,.16)'; g.fillRect(x0 + t * ppb, 0, sl.beats * ppb, H); }
      t += sl.beats;
    });
    for (let b = 0; b <= tot; b++) {
      g.strokeStyle = b % 4 === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.07)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(x0 + b * ppb) + .5, 0); g.lineTo(Math.round(x0 + b * ppb) + .5, H); g.stroke();
    }
    t = 0; g.strokeStyle = 'rgba(255,77,109,.7)'; g.setLineDash([3, 3]);
    for (const sl of S.slots) { if (t > 0) { g.beginPath(); g.moveTo(Math.round(x0 + t * ppb) + .5, 0); g.lineTo(Math.round(x0 + t * ppb) + .5, H); g.stroke(); } t += sl.beats; }
    g.setLineDash([]);
    for (const n of notes) {
      const x = x0 + n.s * ppb, w = Math.max(2, n.l * ppb - 1), y = yOf(n.p) + 1;
      g.fillStyle = n.slot === S.sel ? '#9d86ff' : '#6a4fe0'; g.globalAlpha = 0.35 + 0.65 * n.v;
      g.beginPath(); g.roundRect(x, y, w, Math.max(2, rh - 2), Math.min(3, rh / 2)); g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = '#100f24'; g.fillRect(0, 0, KW, H);   // kolom tuts di kiri
    g.font = '600 9px system-ui,sans-serif'; g.textBaseline = 'middle';
    for (let p = lo; p <= hi; p++) {
      const blk = BLACK_PC.has(p % 12);
      g.fillStyle = blk ? '#2a2850' : '#d9d6f2'; g.fillRect(0, yOf(p) + 0.5, blk ? KW * 0.62 : KW - 1, rh - 1);
      if (p % 12 === 0 && rh >= 8) { g.fillStyle = '#2a2850'; g.fillText(midiName(p), KW - 24, yOf(p) + rh / 2); }
    }
    if (phBeat >= 0) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0 + phBeat * ppb, 0); g.lineTo(x0 + phBeat * ppb, H); g.stroke(); }
  }
  const renderAll = (): void => { recompute(); renderControls(); renderLane(); renderKeys(); drawRoll(); };
  refreshFn = () => { S.sel = clamp(S.sel, 0, S.slots.length - 1); if (!el.hidden) renderAll(); };
  const changed = (): void => { S.preset = S.preset >= 0 && matchesPreset() ? S.preset : -1; renderAll(); };
  const matchesPreset = (): boolean => { const p = PRESETS[S.preset]; return !!p && p.scale === S.st.scale && p.slots.length === S.slots.length && p.slots.every((d, i) => d === S.slots[i].deg && S.slots[i].beats === 4); };

  // ---------- preview ----------
  let bus: GainNode | null = null, t0 = 0, spb = 0.5, sched = 0, timer = 0;
  const playChord = (i: number): void => {
    const c = ac(), t = c.currentTime + 0.02, vn = voice(chordAt(S.st, S.slots[i].deg), S.vc);
    const b = c.createGain(); b.connect(out!); vn.forEach((n, k) => tone(c, b, n.p, t + (S.rh.style === 'Strum' ? k * S.rh.strum * 0.5 : 0), 1.1, n.v));
    setTimeout(() => b.disconnect(), 2500);
  };
  const startPlay = (): void => {
    const c = ac(); spb = 60 / (bridge ? bridge.bpm() : 120);
    bus = c.createGain(); bus.connect(out!); t0 = c.currentTime + 0.06; sched = 0; playing = true;
    el.querySelector('.mgc__play')!.innerHTML = ICON.stop; el.querySelector('.mgc__play')!.classList.add('is-on');
    const pump = (): void => {
      const tot = totalBeats(S.slots), until = (c.currentTime + 0.25 - t0) / spb;
      for (let pass = Math.floor(sched / tot); pass <= Math.floor(until / tot); pass++) {
        for (const n of notes) {
          const s = pass * tot + n.s;
          if (s >= sched - 1e-9 && s < until) tone(c, bus!, n.p, t0 + s * spb, n.l * spb, n.v);
        }
      }
      sched = Math.max(sched, until);
    };
    pump(); timer = window.setInterval(pump, 50);
    const frame = (): void => {
      if (!playing) return;
      phBeat = ((ac().currentTime - t0) / spb) % totalBeats(S.slots); if (phBeat < 0) phBeat = 0;
      drawRoll(); raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };
  const stopPlay = (): void => {
    if (!playing) return;
    playing = false; clearInterval(timer); cancelAnimationFrame(raf); phBeat = -1;
    if (bus && actx) { bus.gain.setTargetAtTime(0, actx.currentTime, 0.03); const b = bus; setTimeout(() => b.disconnect(), 400); }
    bus = null;
    el.querySelector('.mgc__play')!.innerHTML = ICON.play; el.querySelector('.mgc__play')!.classList.remove('is-on');
    drawRoll();
  };

  // ---------- aksi ----------
  const slot = (): Slot => S.slots[S.sel];
  const newChord = (d: number): void => { const tot = totalBeats(S.slots); if (tot + 4 > MAX_BEATS) return; S.slots.push({ deg: mod(d, 7), beats: 4 }); S.sel = S.slots.length - 1; };
  const actions: Record<string, (b: HTMLElement) => void> = {
    close: () => close(),
    play: () => (playing ? stopPlay() : startPlay()),
    reset: () => { stopPlay(); S = initial(); changed(); },
    pprev: () => loadPreset(mod(S.preset - 1, PRESETS.length)),
    pnext: () => loadPreset(mod(S.preset + 1, PRESETS.length)),
    'oct-': () => { S.st.octave = clamp(S.st.octave - 1, -2, 2); changed(); },
    'oct+': () => { S.st.octave = clamp(S.st.octave + 1, -2, 2); changed(); },
    'inv-': () => { S.vc.invert = clamp(S.vc.invert - 1, 0, 3); changed(); },
    'inv+': () => { S.vc.invert = clamp(S.vc.invert + 1, 0, 3); changed(); },
    von: b => { const i = +b.closest<HTMLElement>('.mgc__vrow')!.dataset.v!; S.vc.on[i] = !S.vc.on[i]; changed(); },
    vshift: b => { const i = +b.closest<HTMLElement>('.mgc__vrow')!.dataset.v!; S.vc.shift[i] = +b.dataset.s!; changed(); },
    style: b => { S.rh.style = b.dataset.s as PlayStyle; changed(); },
    rate: b => { S.rh.rate = +b.dataset.s!; changed(); },
    strum: b => { S.rh.strum = +b.dataset.s!; changed(); },
    'deg-': () => { slot().deg = mod(slot().deg - 1, 7); changed(); playChord(S.sel); },
    'deg+': () => { slot().deg = mod(slot().deg + 1, 7); changed(); playChord(S.sel); },
    'len-': () => setLen(-1),
    'len+': () => setLen(1),
    add: () => { newChord(S.slots[S.slots.length - 1].deg + 4); changed(); },
    del: () => { if (S.slots.length > 1) { S.slots.splice(S.sel, 1); S.sel = Math.min(S.sel, S.slots.length - 1); changed(); } },
    dice: () => {   // total dibulatkan ke bar penuh
      S.slots = randomProgression(clamp(Math.round(totalBeats(S.slots) / 4) * 4, 8, MAX_BEATS)); S.sel = 0; S.preset = -1; changed(); playChord(0); },
    midi: () => { const bpm = bridge ? bridge.bpm() : 120; download(toMidi(notes, bpm), 'mgchord-' + chordAt(S.st, 0).name.replace('#', 's') + '.mid'); toastMsg('MIDI diunduh'); },
    send: () => {
      const msg = bridge ? bridge.send(notes.map(n => ({ p: n.p, s: n.s, l: n.l, v: n.v })), totalBeats(S.slots)) : 'Plugin belum tersambung ke timeline';
      toastMsg(msg ?? 'Nada dikirim ke pattern');
    },
  };
  function setLen(dir: number): void {
    const cur = LENS.indexOf(slot().beats), idx = clamp((cur < 0 ? LENS.findIndex(l => l >= slot().beats) : cur) + dir, 0, LENS.length - 1);
    const nb = LENS[idx], tot = totalBeats(S.slots) - slot().beats + nb;
    if (tot > MAX_BEATS) return;
    slot().beats = nb; changed();
  }
  function loadPreset(i: number): void {
    const p = PRESETS[i]; S.preset = i; S.st.scale = p.scale; S.slots = slotsOf(p); S.sel = 0; renderAll();
    if (playing) { /* nada baru ikut terjadwal otomatis */ }
  }
  const toastMsg = (m: string): void => {
    const t = document.createElement('div'); t.className = 'mgc__toast'; t.setAttribute('role', 'status'); t.textContent = m; win.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  };
  const download = (data: Uint8Array, name: string): void => {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/midi' })), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  el.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-a]'); if (b && actions[b.dataset.a!]) { actions[b.dataset.a!](b); return; }
    const ch = t.closest<HTMLElement>('.mgc__ch'); if (ch) { S.sel = +ch.dataset.i!; renderLane(); renderKeys(); drawRoll(); playChord(S.sel); return; }
    const k = t.closest<HTMLElement>('.mgc__k'); if (k) { const c = ac(), bb = c.createGain(); bb.connect(out!); tone(c, bb, +k.dataset.p!, c.currentTime + 0.01, 0.8, 0.75); setTimeout(() => bb.disconnect(), 2000); return; }
    if (t.closest('.mgc__back')) close();
  });
  el.addEventListener('change', e => {
    const s = e.target as HTMLSelectElement; if (!s.dataset.k) return;
    if (s.dataset.k === 'root') S.st.root = Math.max(0, NOTE_NAMES.indexOf(s.value));
    else if (s.dataset.k === 'scale') S.st.scale = s.value; else S.st.chordType = s.value;
    changed();
  });
  // klik di piano roll = pilih chord di posisi itu
  cv.addEventListener('pointerdown', e => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left - 40; if (x < 0) return;
    const beat = x / ((r.width - 40) / totalBeats(S.slots)); let t = 0;
    for (let i = 0; i < S.slots.length; i++) { t += S.slots[i].beats; if (beat < t) { S.sel = i; renderLane(); renderKeys(); drawRoll(); playChord(i); return; } }
  });
  // bar velocity: seret
  el.querySelectorAll<HTMLElement>('.mgc__vbar').forEach(b => {
    const set = (ev: PointerEvent): void => { const r = b.getBoundingClientRect(), i = +b.dataset.v!; S.vc.vel[i] = clamp((ev.clientX - r.left) / r.width, 0.05, 1); changed(); };
    b.style.touchAction = 'none'; let dr = false;
    b.addEventListener('pointerdown', ev => { dr = true; b.setPointerCapture(ev.pointerId); set(ev); ev.preventDefault(); });
    b.addEventListener('pointermove', ev => { if (dr) set(ev); });
    b.addEventListener('pointerup', () => { dr = false; }); b.addEventListener('pointercancel', () => { dr = false; });
    b.addEventListener('keydown', ev => {
      const i = +b.dataset.v!, d = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? 0.05 : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -0.05 : 0;
      if (d) { S.vc.vel[i] = clamp(S.vc.vel[i] + d, 0.05, 1); changed(); ev.preventDefault(); }
    });
  });
  win.addEventListener('keydown', e => {
    e.stopPropagation();   // pintasan DAW (Spasi, panah) tidak ikut jalan selagi jendela terbuka
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === ' ' && !(e.target as HTMLElement).matches('button, select, [role="slider"]')) { actions.play(win); e.preventDefault(); }
  });
  win.addEventListener('keyup', e => e.stopPropagation());
  new ResizeObserver(() => { if (!el.hidden) drawRoll(); }).observe(cv);

  function close(): void {
    stopPlay(); el.hidden = true; document.body.classList.remove('mgc-open');
    if (prevFocus instanceof HTMLElement && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
  }
  openFn = () => {
    prevFocus = document.activeElement; el.hidden = false; document.body.classList.add('mgc-open');
    renderAll(); win.focus({ preventScroll: true }); requestAnimationFrame(drawRoll);
  };
}
