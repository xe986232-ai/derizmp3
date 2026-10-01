// Isi panel efek: tombol "+" bulat putih (di atas saat kosong, pindah ke bawah setelah ada efek), card gelap (gaya card track)
// untuk memilih efek, dan satu card per efek. Parameter diatur dengan knob seperti knob pan di channel mixer.
// Efek disimpan per track (kunci = id track); panel selalu menampilkan efek milik track yang sedang dipilih.
// Saat ini baru ada Reverb. Efek baru cukup ditambah ke EFFECTS (ikon, nama, parameter) dan ke applyAudio().

import { setReverb, setEq, reverbSeconds, eqDb } from './audio-engine';

type FxType = 'reverb' | 'eq';
interface Fx { id: number; type: FxType; on: boolean; min: boolean; v: Record<string, number>; }
interface Param { key: string; label: string; def: number; fmt: (v: number) => string; bipolar?: boolean; }   // bipolar: arc dari tengah (seperti knob pan)
interface EffectDef { type: FxType; name: string; params: Param[]; }

const svg = (inner: string, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICON_MORE = svg('<circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none"/>', 18);

const fmtDb = (v: number): string => { const d = Math.round(eqDb(v) * 10) / 10; return (d > 0 ? '+' : '') + d.toFixed(1) + ' dB'; };

const EFFECTS: EffectDef[] = [
  {
    type: 'reverb', name: 'Reverb',
    params: [
      { key: 'mix', label: 'Mix', def: 0.3, fmt: v => Math.round(v * 100) + '%' },
      { key: 'size', label: 'Size', def: 0.4, fmt: v => reverbSeconds(v).toFixed(1) + ' s' }
    ]
  },
  {
    type: 'eq', name: 'Equalizer',
    params: [
      { key: 'low', label: 'Low', def: 0.5, bipolar: true, fmt: fmtDb },
      { key: 'mid', label: 'Mid', def: 0.5, bipolar: true, fmt: fmtDb },
      { key: 'high', label: 'High', def: 0.5, bipolar: true, fmt: fmtDb }
    ]
  }
];
const defOf = (t: FxType) => EFFECTS.find(e => e.type === t)!;

const racks = new Map<string, Fx[]>();   // id track -> efek miliknya
let cur: string | null = null, seq = 0;

function applyAudio(track: string): void {
  const rack = racks.get(track) ?? [];
  const r = rack.find(f => f.type === 'reverb'), e = rack.find(f => f.type === 'eq');
  setReverb(track, r ? { on: r.on, mix: r.v.mix, size: r.v.size } : null);
  setEq(track, e ? { on: e.on, low: e.v.low, mid: e.v.mid, high: e.v.high } : null);
}

// ---------- knob (struktur & kelas sama dengan knob pan di channel mixer, tapi satu arah: 0 → 1) ----------
const KNOB_SWEEP = 270, ARC_LEN = 75, DRAG_PX = 90;   // sapuan 270° = 75 satuan dari keliling 100; DRAG_PX = jarak drag (px) untuk menempuh 0 → 1
const knobSvg = `<svg viewBox="0 0 36 36" aria-hidden="true" class="circular-chart">` +
  `<path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke-dasharray="75, 100" class="circle-bg" style="transform-origin:18px 18px;transform:rotate(225deg)"></path>` +
  `<path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke-dashoffset="0" stroke-dasharray="0 100" class="circle primary-theme" style="transform:rotate(225deg)"></path>` +
  `<path d="M18 5.142857142857142 a 12.857142857142858 12.857142857142858 0 0 1 0 25.714285714285715 a 12.857142857142858 12.857142857142858 0 0 1 0 -25.714285714285715" fill="var(--background-tinted-press)" stroke="none" class="circle-inner"></path>` +
  `<path d="M18 5.7857142857142865 a 12.214285714285714 12.214285714285714 0 0 1 0 24.428571428571427 a 12.214285714285714 12.214285714285714 0 0 1 0 -24.428571428571427" stroke="var(--background-tinted-base)" fill="none" class="circle-inner-stroke"></path>` +
  `<path d="M 18 7.5 L 18 12" class="knob-pos" style="transform:rotate(-135deg)"></path></svg>`;

function paintKnob(el: HTMLElement, v: number, p: Param, name: string): void {
  (el.querySelector('.knob-pos') as SVGElement).style.transform = `rotate(${-KNOB_SWEEP / 2 + v * KNOB_SWEEP}deg)`;
  const arc = el.querySelector('.circle')!;
  if (p.bipolar) {   // arc dari tengah: ke kiri atau ke kanan, seperti knob pan
    const a = Math.min(v, 0.5) * ARC_LEN, b = Math.max(v, 0.5) * ARC_LEN;
    arc.setAttribute('stroke-dasharray', `0 ${a.toFixed(2)} ${(b - a).toFixed(2)} 100`);
  } else arc.setAttribute('stroke-dasharray', `${(v * ARC_LEN).toFixed(2)} 100`);
  el.setAttribute('aria-valuenow', v.toFixed(3));
  el.setAttribute('aria-valuetext', `${name} ${p.label} ${p.fmt(v)}`);
}

function cardHtml(fx: Fx, i: number): string {
  const d = defOf(fx.type);
  const cells = d.params.map(p =>
    `<div class="fxc__cell"><div class="knob fxk"><div class="knob-inner">` +
    `<div role="slider" tabindex="0" class="knob-input" data-k="${p.key}" aria-label="${d.name} ${p.label}" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${fx.v[p.key]}">` +
    `<div class="knobwheel">${knobSvg}</div></div></div></div><span class="fxc__label">${p.label}</span></div>`).join('');
  return `<section class="fxc${fx.on ? '' : ' is-off'}${fx.min ? ' is-min' : ''}" data-fx="${fx.id}" style="--i:${i}" aria-label="${d.name}">` +
    `<header class="fxc__head"><h3 class="fxc__name"><button type="button" class="fxc__title" aria-expanded="${!fx.min}" title="Klik untuk minimize / maximize">${d.name}</button></h3>` +
    `<button type="button" class="fxc__pwr" role="switch" aria-checked="${fx.on}" aria-label="${d.name} nyala / mati" title="Nyala / mati"></button>` +
    `<button type="button" class="fxc__more" aria-haspopup="menu" aria-expanded="false" aria-label="Opsi ${d.name}" title="Opsi">${ICON_MORE}</button></header>` +
    `<div class="fxc__collapse"><div class="fxc__body"><div class="fxc__knobs">${cells}</div></div></div></section>`;
}

export interface FxRack {
  show(track: string | null): void;   // tampilkan efek milik track ini (null = tidak ada track terpilih)
  drop(track: string): void;          // track dihapus: buang efeknya
  closePicker(instant?: boolean): void;
}

export function initFxRack(): FxRack {
  const addBtn = document.getElementById('fxAdd') as HTMLButtonElement;
  const list = document.getElementById('fxList')!;
  const bodyEl = addBtn.closest('.fx__body') as HTMLElement;
  const topEl = addBtn.closest('.fx__top') as HTMLElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const fxs = () => (cur ? racks.get(cur) ?? [] : []);
  const find = (el: Element | null) => {
    const id = el?.closest<HTMLElement>('.fxc')?.dataset.fx;
    return fxs().find(f => String(f.id) === id);
  };

  // Tombol "+": di atas saat belum ada efek, pindah ke bawah daftar setelah ada efek (dengan animasi geser halus)
  function layout(animate: boolean): void {
    const has = fxs().length > 0;
    if (bodyEl.classList.contains('has-fx') === has) return;
    const first = topEl.getBoundingClientRect().top;
    bodyEl.classList.toggle('has-fx', has);
    if (!animate || reduce) return;
    const dy = first - topEl.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) topEl.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.34,1.3,.64,1)' });
  }

  // ---------- tooltip putih saat knob diputar (kelas & gaya sama dengan tooltip knob pan) ----------
  const tip = document.createElement('div');
  tip.className = 'pan-tip'; tip.hidden = true; tip.setAttribute('role', 'status');
  document.body.appendChild(tip);
  let tipTimer = 0;
  const hideTip = () => { tip.hidden = true; };
  const showTip = (knob: HTMLElement, text: string, ms = 0) => {
    tip.textContent = text; tip.hidden = false;
    const r = knob.getBoundingClientRect(), w = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w.width / 2, innerWidth - w.width - 8)) + 'px';
    tip.style.top = (r.top - w.height - 8 < 8 ? r.bottom + 8 : r.top - w.height - 8) + 'px';
    clearTimeout(tipTimer);
    if (ms) tipTimer = window.setTimeout(hideTip, ms);
  };

  // ---------- card pilihan efek, muncul di dekat tombol + ----------
  let pick: HTMLElement | null = null;

  const closePicker = (instant = false) => {
    const el = pick; if (!el) return;
    pick = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
    addBtn.setAttribute('aria-expanded', 'false');
    if (instant || reduce) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9) translateY(-4px)' }],
      { duration: 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => el.remove();
  };
  const onOutside = (e: PointerEvent) => { const t = e.target as Node; if (!pick?.contains(t) && !addBtn.contains(t)) closePicker(); };
  const onResize = () => closePicker(true);
  const onKey = (e: KeyboardEvent) => {   // Esc menutup card pilihan dari mana pun fokusnya
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    closePicker(); addBtn.focus({ preventScroll: true });
  };

  const openPicker = () => {
    if (pick || !cur) return;
    closeMenu(true);
    const have = new Set(fxs().map(f => f.type));
    const el = document.createElement('div');
    el.className = 'fx-pick';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Pilih efek');
    el.innerHTML = EFFECTS.map((d, k) => {
      const used = have.has(d.type);
      return `<button type="button" role="menuitem" class="fx-pick__item" data-type="${d.type}" style="--i:${k}"${used ? ' disabled title="Sudah ditambahkan"' : ''}>` +
        `<span>${d.name}</span></button>`;
    }).join('');
    document.body.appendChild(el);
    const r = addBtn.getBoundingClientRect(), w = Math.min(220, innerWidth - 16), h = el.offsetHeight;
    el.style.width = w + 'px';
    el.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
    // buka ke bawah tombol; kalau tidak muat (tombol sekarang di bagian bawah), buka ke atas
    const below = r.bottom + 10, above = r.top - 10 - h;
    el.style.top = Math.max(8, below + h > innerHeight - 8 && above >= 8 ? above : Math.min(below, innerHeight - h - 8)) + 'px';
    el.style.transformOrigin = below + h > innerHeight - 8 && above >= 8 ? 'bottom center' : 'top center';
    pick = el;
    addBtn.setAttribute('aria-expanded', 'true');
    el.addEventListener('click', e => {
      const b = (e.target as Element).closest<HTMLButtonElement>('.fx-pick__item');
      if (!b || b.disabled) return;
      addEffect(b.dataset.type as FxType);
      closePicker();
      addBtn.focus({ preventScroll: true });
    });
    el.addEventListener('keydown', e => e.stopPropagation());   // pintasan DAW (Space, panah) tidak ikut jalan
    el.addEventListener('keyup', e => e.stopPropagation());
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    el.querySelector<HTMLButtonElement>('.fx-pick__item:not(:disabled)')?.focus({ preventScroll: true });
  };

  addBtn.addEventListener('click', () => { pick ? closePicker() : openPicker(); });

  // ---------- menu titik tiga (Delete) ----------
  let menu: HTMLElement | null = null, menuBtn: HTMLButtonElement | null = null;

  function closeMenu(instant = false): void {
    const el = menu; if (!el) return;
    menu = null;
    menuBtn?.setAttribute('aria-expanded', 'false'); menuBtn = null;
    document.removeEventListener('pointerdown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('resize', onMenuResize);
    window.removeEventListener('scroll', onMenuResize, true);
    if (instant || reduce) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9) translateY(-4px)' }],
      { duration: 150, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => el.remove();
  }
  const onMenuOutside = (e: PointerEvent) => { const t = e.target as Node; if (!menu?.contains(t) && !menuBtn?.contains(t)) closeMenu(); };
  const onMenuResize = () => closeMenu(true);
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    const b = menuBtn; closeMenu(); b?.focus({ preventScroll: true });
  };

  function openMenu(btn: HTMLButtonElement, card: HTMLElement): void {
    closePicker(true); closeMenu(true);
    const el = document.createElement('div');
    el.className = 'track-menu fx-menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = '<button type="button" role="menuitem" class="track-menu__item track-menu__item--danger">Delete</button>';
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - h - 8)) + 'px';
    el.style.transformOrigin = 'top right';
    menu = el; menuBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
    el.querySelector('button')!.addEventListener('click', () => { closeMenu(true); removeEffect(card); });
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('keyup', e => e.stopPropagation());
    document.addEventListener('pointerdown', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('resize', onMenuResize);
    window.addEventListener('scroll', onMenuResize, true);
    el.querySelector<HTMLButtonElement>('button')!.focus({ preventScroll: true });
  }

  // ---------- kartu efek ----------
  const paintAll = (card: HTMLElement, fx: Fx) => {
    const d = defOf(fx.type);
    card.querySelectorAll<HTMLElement>('.knob-input').forEach(k => {
      const p = d.params.find(x => x.key === k.dataset.k)!;
      paintKnob(k, fx.v[p.key], p, d.name);
    });
  };

  function addEffect(type: FxType): void {
    if (!cur) return;
    const d = defOf(type), v: Record<string, number> = {};
    d.params.forEach(p => { v[p.key] = p.def; });
    const fx: Fx = { id: ++seq, type, on: true, min: false, v };
    racks.set(cur, [...fxs(), fx]);
    applyAudio(cur);
    list.insertAdjacentHTML('beforeend', cardHtml(fx, 0));
    const card = list.lastElementChild as HTMLElement;
    paintAll(card, fx);
    layout(true);
    card.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }

  function removeEffect(card: HTMLElement): void {
    const fx = find(card); if (!fx || !cur) return;
    hideTip();
    racks.set(cur, fxs().filter(f => f !== fx));
    applyAudio(cur);
    if (pick) closePicker(true);
    const done = () => { card.remove(); layout(true); };
    if (reduce) { done(); return; }
    const h = card.offsetHeight, mb = parseFloat(getComputedStyle(card).marginBottom) || 0;
    card.style.overflow = 'hidden'; card.style.pointerEvents = 'none';
    card.animate([
      { height: h + 'px', marginBottom: mb + 'px', opacity: 1, transform: 'translateX(0) scale(1)' },
      { opacity: 0, transform: 'translateX(36px) scale(.94)', offset: .5 },
      { height: '0px', marginBottom: '0px', opacity: 0, transform: 'translateX(36px) scale(.94)' }
    ], { duration: 380, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }).onfinish = done;
  }

  // ---------- knob: drag (atas/kanan = naik), panah keyboard, dobel klik = reset ke nilai awal ----------
  let drag: { el: HTMLElement; fx: Fx; p: Param; sx: number; sy: number; sv: number } | null = null;
  const ctx = (el: HTMLElement) => {
    const fx = find(el); if (!fx) return null;
    const p = defOf(fx.type).params.find(x => x.key === el.dataset.k)!;
    return { fx, p };
  };
  const setVal = (el: HTMLElement, fx: Fx, p: Param, n: number) => {
    const v = Math.max(0, Math.min(1, n));
    fx.v[p.key] = v;
    paintKnob(el, v, p, defOf(fx.type).name);
    if (cur) applyAudio(cur);
    if (!tip.hidden) showTip(el, p.fmt(v));
  };

  list.addEventListener('pointerdown', e => {
    const el = (e.target as Element).closest<HTMLElement>('.knob-input'); if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const c = ctx(el); if (!c) return;
    drag = { el, fx: c.fx, p: c.p, sx: e.clientX, sy: e.clientY, sv: c.fx.v[c.p.key] };
    el.classList.add('is-dragging'); el.setPointerCapture(e.pointerId); e.preventDefault();
    el.focus({ preventScroll: true });
    showTip(el, c.p.fmt(c.fx.v[c.p.key]));
  });
  list.addEventListener('pointermove', e => {
    if (!drag) return;
    setVal(drag.el, drag.fx, drag.p, drag.sv + ((drag.sy - e.clientY) + (e.clientX - drag.sx)) / DRAG_PX);
  });
  const endDrag = () => { if (!drag) return; drag.el.classList.remove('is-dragging'); drag = null; hideTip(); };
  list.addEventListener('pointerup', endDrag);
  list.addEventListener('pointercancel', endDrag);
  list.addEventListener('lostpointercapture', endDrag);
  list.addEventListener('dblclick', e => {
    const el = (e.target as Element).closest<HTMLElement>('.knob-input'); if (!el) return;
    const c = ctx(el); if (!c) return;
    showTip(el, c.p.fmt(c.p.def), 900); setVal(el, c.fx, c.p, c.p.def);
  });
  list.addEventListener('keydown', e => {
    const el = (e.target as Element).closest<HTMLElement>('.knob-input'); if (!el) return;
    const up = e.key === 'ArrowUp' || e.key === 'ArrowRight', down = e.key === 'ArrowDown' || e.key === 'ArrowLeft';
    if (!up && !down) return;
    const c = ctx(el); if (!c) return;
    e.preventDefault(); e.stopPropagation();   // panah tidak ikut memicu mundur / maju milik DAW
    setVal(el, c.fx, c.p, Math.round((c.fx.v[c.p.key] + (up ? 0.02 : -0.02)) * 100) / 100);
    showTip(el, c.p.fmt(c.fx.v[c.p.key]), 900);
  });
  list.addEventListener('blur', e => { if ((e.target as Element).matches?.('.knob-input') && !drag) hideTip(); }, true);

  list.addEventListener('click', e => {
    const t = e.target as Element, card = t.closest<HTMLElement>('.fxc');
    if (!card) return;
    const more = t.closest<HTMLButtonElement>('.fxc__more');
    if (more) { menu && menuBtn === more ? closeMenu() : openMenu(more, card); return; }
    const pwr = t.closest<HTMLButtonElement>('.fxc__pwr');
    if (pwr) {
      const fx = find(card); if (!fx || !cur) return;
      fx.on = !fx.on;
      card.classList.toggle('is-off', !fx.on);
      pwr.setAttribute('aria-checked', String(fx.on));
      applyAudio(cur);
      return;
    }
    const title = t.closest<HTMLButtonElement>('.fxc__title');   // klik nama efek: minimize / maximize
    if (title) {
      const fx = find(card); if (!fx) return;
      fx.min = !fx.min;
      hideTip();
      card.classList.toggle('is-min', fx.min);
      title.setAttribute('aria-expanded', String(!fx.min));
    }
  });
  // Space / Enter pada tombol di panel ini jangan ikut memicu play / pause milik DAW
  const guard = (e: KeyboardEvent) => { if ((e.key === ' ' || e.code === 'Space') && (e.target as Element).closest?.('button')) e.stopPropagation(); };
  document.getElementById('fxBody')!.addEventListener('keydown', guard);
  document.getElementById('fxBody')!.addEventListener('keyup', guard);

  return {
    show(track) {
      closePicker(true); closeMenu(true); hideTip(); drag = null;
      cur = track;
      addBtn.disabled = !track;
      list.replaceChildren();
      if (!track) { layout(false); return; }
      applyAudio(track);
      list.innerHTML = fxs().map((f, i) => cardHtml(f, i)).join('');
      list.querySelectorAll<HTMLElement>('.fxc').forEach(c => { const f = find(c); if (f) paintAll(c, f); });
      layout(false);
    },
    drop(track) {
      racks.delete(track);
      setReverb(track, null); setEq(track, null);
      if (cur === track) { closePicker(true); closeMenu(true); hideTip(); cur = null; addBtn.disabled = true; list.replaceChildren(); layout(false); }
    },
    closePicker
  };
}
