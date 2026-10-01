// Isi panel efek: tombol "+" bulat putih di atas, card putih untuk memilih efek, dan satu card per efek di bawahnya.
// Efek disimpan per track (kunci = id track); panel selalu menampilkan efek milik track yang sedang dipilih.
// Saat ini baru ada Reverb. Efek baru cukup ditambah ke EFFECTS (ikon, nama, parameter) dan ke applyAudio().

import { setReverb, reverbSeconds } from './audio-engine';

type FxType = 'reverb';
interface Fx { id: number; type: FxType; on: boolean; v: Record<string, number>; }
interface Param { key: string; label: string; def: number; fmt: (v: number) => string; }
interface EffectDef { type: FxType; name: string; icon: string; params: Param[]; }

const svg = (inner: string, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICON_REVERB = svg('<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M10 8.6a5 5 0 0 1 0 6.8M13.8 5.8a9.2 9.2 0 0 1 0 12.4M17.6 3.2a13 13 0 0 1 0 17.6"/>');
const ICON_POWER = svg('<path d="M12 3v8M7.4 6.6a7 7 0 1 0 9.2 0"/>', 15);
const ICON_CLOSE = svg('<path d="M6 6l12 12M18 6L6 18"/>', 15);

const EFFECTS: EffectDef[] = [
  {
    type: 'reverb', name: 'Reverb', icon: ICON_REVERB,
    params: [
      { key: 'mix', label: 'Mix', def: 0.3, fmt: v => Math.round(v * 100) + '%' },
      { key: 'size', label: 'Size', def: 0.4, fmt: v => reverbSeconds(v).toFixed(1) + ' s' }
    ]
  }
];
const defOf = (t: FxType) => EFFECTS.find(e => e.type === t)!;

const racks = new Map<string, Fx[]>();   // id track -> efek miliknya
let cur: string | null = null, seq = 0;

function applyAudio(track: string): void {
  const r = (racks.get(track) ?? []).find(f => f.type === 'reverb');
  setReverb(track, r ? { on: r.on, mix: r.v.mix, size: r.v.size } : null);
}

const fillOf = (inp: HTMLInputElement) => inp.style.setProperty('--p', ((+inp.value - +inp.min) / (+inp.max - +inp.min) * 100) + '%');

function cardHtml(fx: Fx, i: number): string {
  const d = defOf(fx.type);
  const rows = d.params.map(p => {
    const v = fx.v[p.key];
    return `<label class="fxc__row"><span class="fxc__label">${p.label}</span><output class="fxc__val">${p.fmt(v)}</output>` +
      `<input class="fxs" type="range" min="0" max="100" step="1" value="${Math.round(v * 100)}" data-k="${p.key}" aria-label="${d.name} ${p.label}"></label>`;
  }).join('');
  return `<section class="fxc${fx.on ? '' : ' is-off'}" data-fx="${fx.id}" style="--i:${i}" aria-label="${d.name}">` +
    `<header class="fxc__head"><span class="fxc__icon">${d.icon}</span><h3 class="fxc__name">${d.name}</h3>` +
    `<button type="button" class="fxc__pwr" role="switch" aria-checked="${fx.on}" aria-label="${d.name} nyala / mati" title="Nyala / mati"></button>` +
    `<button type="button" class="fxc__del" aria-label="Hapus ${d.name}" title="Hapus efek">${ICON_CLOSE}</button></header>` +
    `<div class="fxc__body">${rows}</div></section>`;
}

export interface FxRack {
  show(track: string | null): void;   // tampilkan efek milik track ini (null = tidak ada track terpilih)
  drop(track: string): void;          // track dihapus: buang efeknya
  closePicker(instant?: boolean): void;
}

export function initFxRack(): FxRack {
  const addBtn = document.getElementById('fxAdd') as HTMLButtonElement;
  const list = document.getElementById('fxList')!;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const fxs = () => (cur ? racks.get(cur) ?? [] : []);
  const find = (el: Element | null) => {
    const id = el?.closest<HTMLElement>('.fxc')?.dataset.fx;
    return fxs().find(f => String(f.id) === id);
  };

  // ---------- card pilihan efek (putih), muncul di bawah tombol + ----------
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
    const have = new Set(fxs().map(f => f.type));
    const el = document.createElement('div');
    el.className = 'fx-pick';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Pilih efek');
    el.innerHTML = EFFECTS.map((d, k) => {
      const used = have.has(d.type);
      return `<button type="button" role="menuitem" class="fx-pick__item" data-type="${d.type}" style="--i:${k}"${used ? ' disabled title="Sudah ditambahkan"' : ''}>` +
        `<span class="fx-pick__icon">${d.icon}</span><span>${d.name}</span></button>`;
    }).join('');
    document.body.appendChild(el);
    const r = addBtn.getBoundingClientRect(), w = Math.min(220, innerWidth - 16), h = el.offsetHeight;
    el.style.width = w + 'px';
    el.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(r.bottom + 10, innerHeight - h - 8)) + 'px';
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

  // ---------- kartu efek ----------
  function addEffect(type: FxType): void {
    if (!cur) return;
    const d = defOf(type), v: Record<string, number> = {};
    d.params.forEach(p => { v[p.key] = p.def; });
    const fx: Fx = { id: ++seq, type, on: true, v };
    racks.set(cur, [...fxs(), fx]);
    applyAudio(cur);
    list.insertAdjacentHTML('beforeend', cardHtml(fx, 0));
    const card = list.lastElementChild as HTMLElement;
    card.querySelectorAll<HTMLInputElement>('.fxs').forEach(fillOf);
    card.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }

  function removeEffect(card: HTMLElement): void {
    const fx = find(card); if (!fx || !cur) return;
    racks.set(cur, fxs().filter(f => f !== fx));
    applyAudio(cur);
    if (pick) closePicker(true);
    if (reduce) { card.remove(); return; }
    const h = card.offsetHeight, mb = parseFloat(getComputedStyle(card).marginBottom) || 0;
    card.style.overflow = 'hidden'; card.style.pointerEvents = 'none';
    card.animate([
      { height: h + 'px', marginBottom: mb + 'px', opacity: 1, transform: 'translateX(0) scale(1)' },
      { opacity: 0, transform: 'translateX(36px) scale(.94)', offset: .5 },
      { height: '0px', marginBottom: '0px', opacity: 0, transform: 'translateX(36px) scale(.94)' }
    ], { duration: 380, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }).onfinish = () => card.remove();
  }

  list.addEventListener('input', e => {
    const inp = e.target as HTMLInputElement;
    if (!inp.matches?.('.fxs')) return;
    const fx = find(inp); if (!fx || !cur) return;
    const p = defOf(fx.type).params.find(x => x.key === inp.dataset.k)!;
    fx.v[p.key] = +inp.value / 100;
    fillOf(inp);
    inp.parentElement!.querySelector('.fxc__val')!.textContent = p.fmt(fx.v[p.key]);
    applyAudio(cur);
  });
  list.addEventListener('click', e => {
    const t = e.target as Element, card = t.closest<HTMLElement>('.fxc');
    if (!card) return;
    if (t.closest('.fxc__del')) { removeEffect(card); return; }
    const pwr = t.closest<HTMLButtonElement>('.fxc__pwr');
    if (pwr) {
      const fx = find(card); if (!fx || !cur) return;
      fx.on = !fx.on;
      card.classList.toggle('is-off', !fx.on);
      pwr.setAttribute('aria-checked', String(fx.on));
      applyAudio(cur);
    }
  });
  // Space / Enter pada tombol di panel ini jangan ikut memicu play / pause milik DAW
  const guard = (e: KeyboardEvent) => { if ((e.key === ' ' || e.code === 'Space') && (e.target as Element).closest?.('button')) e.stopPropagation(); };
  document.getElementById('fxBody')!.addEventListener('keydown', guard);
  document.getElementById('fxBody')!.addEventListener('keyup', guard);

  return {
    show(track) {
      closePicker(true);
      cur = track;
      addBtn.disabled = !track;
      list.replaceChildren();
      if (!track) return;
      applyAudio(track);
      list.innerHTML = fxs().map((f, i) => cardHtml(f, i)).join('');
      list.querySelectorAll<HTMLInputElement>('.fxs').forEach(fillOf);
    },
    drop(track) {
      racks.delete(track);
      setReverb(track, null);
      if (cur === track) { closePicker(true); cur = null; addBtn.disabled = true; list.replaceChildren(); }
    },
    closePicker
  };
}
