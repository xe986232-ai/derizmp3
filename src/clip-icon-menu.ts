// Tahan icon di header pattern -> muncul card putih berisi menu (animasi masuk + keluar).
// Audio clip (icon microphone): menu "Sesuaikan Tempo" dan "Sesuaikan Pitch". Pattern nada (icon piano): menu "Sync all sample" (toggle).
// Pitch: isi semitone (-12..+12, 0 = nada asli), durasi clip tetap; bisa digabung dengan Tempo (keduanya dihitung dari audio asli).
// Tempo: isi BPM asli audio clip (mis. vokal 126), lalu clip di-stretch (pitch tetap) mengikuti BPM project (mis. 130).
// Icon-nya pseudo-element CSS (.pattern__head::before), jadi tidak bisa diberi listener sendiri:
// area icon dihitung dari posisi sentuhan relatif ke kiri header (padding 8px + icon 13px + toleransi jari).
// Tutup card: ketuk di luar, Esc, scroll, atau selesai stretch.

const ICON_ZONE = 8 + 13 + 7;   // px dari tepi kiri header: padding + lebar icon + toleransi
const HOLD_MS = 450;            // lama menahan
const HOLD_SLOP = 10;           // px maksimum bergeser selama menahan (lebih dari ini = batal)
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MENU_LABEL = 'Sesuaikan Tempo';   // menyamakan tempo audio clip dengan BPM project
const PITCH_LABEL = 'Sesuaikan Pitch';   // menggeser nada audio clip tanpa mengubah durasi
const PITCH_MIN = -12, PITCH_MAX = 12;   // semitone (sama dengan CLIP_PITCH_MIN/MAX di time-stretch.ts)
const PATTERN_MENU_LABEL = 'Sync all sample';   // pattern nada: semua sample DERIZ di pattern ini ikut BPM project

export interface ClipIconMenuHooks {
  onOpen?(pattern: HTMLElement): void;     // card muncul (main.ts menyembunyikan menu bulat)
  onClose?(): void;                        // card ditutup
  getProjectBpm(): number;                 // BPM project sekarang
  getClipBpm(pattern: HTMLElement): number | null;   // BPM yang pernah diisi untuk clip ini (null = belum)
  applyTempo(pattern: HTMLElement, bpm: number): Promise<void>;   // stretch clip; lempar Error(pesan) kalau gagal
  getClipPitch(pattern: HTMLElement): number;   // semitone yang sedang terpasang di clip ini (0 = normal)
  applyPitch(pattern: HTMLElement, semitones: number): Promise<void>;   // geser nada clip; lempar Error(pesan) kalau gagal
  onPatternMenu?(pattern: HTMLElement): void;   // item "Sync all sample" diketuk (nyala / mati)
  isPatternSynced?(pattern: HTMLElement): boolean;   // Sync all sample sedang nyala di pattern ini (item diberi tanda centang)
}

export function initClipIconMenu(lanesEl: HTMLElement, hooks: ClipIconMenuHooks): void {
  let card: HTMLDivElement | null = null;
  let timer = 0, pending = false, fired = false;
  let sx = 0, sy = 0;

  const iconHead = (t: EventTarget | null): HTMLElement | null =>
    t instanceof Element ? t.closest('.pattern:not([data-au-id]) .pattern__head') as HTMLElement | null : null;   // audio clip + pattern nada (Automation Clip tidak)

  const close = (instant = false): void => {
    const c = card; if (!c) return;
    card = null;
    hooks.onClose && hooks.onClose();
    c.style.pointerEvents = 'none';
    if (instant || REDUCE) { c.remove(); return; }
    c.animate(
      [{opacity: 1, transform: 'scale(1) translateY(0)'}, {opacity: 0, transform: 'scale(.85) translateY(-6px)'}],
      {duration: 140, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards'}
    ).onfinish = () => c.remove();
  };

  const fmt = (v: number): string => String(Math.round(v * 100) / 100);

  const open = (icon: DOMRect, pattern: HTMLElement): void => {
    close(true);
    const c = document.createElement('div');
    c.className = 'clip-card'; c.setAttribute('role', 'menu');
    let below = true;

    const place = (): void => {   // taruh di bawah icon (atau di atas kalau tidak muat), tetap di dalam layar
      const w = c.offsetWidth, h = c.offsetHeight;
      below = icon.bottom + 6 + h <= innerHeight - 8 || icon.top - 6 - h < 8;
      const top = below ? icon.bottom + 6 : icon.top - 6 - h;
      const left = Math.max(8, Math.min(icon.left, innerWidth - w - 8));
      c.style.left = left + 'px';
      c.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + 'px';
      c.style.transformOrigin = (icon.left + icon.width / 2 - left) + 'px ' + (below ? '0' : h + 'px');   // tumbuh dari icon
    };

    // --- tampilan 2: form angka (Tempo = BPM vocal, Pitch = semitone) ---
    interface FormCfg {
      title: string; value: string; min: number; max: number; msg: string;
      step?: number;                       // ada = tombol - / + di kiri-kanan input (keypad desimal iOS tidak punya tanda minus)
      hint?: string;
      apply(n: number): Promise<void>;
    }
    const formView = (cfg: FormCfg): HTMLElement => {
      const v = document.createElement('div'); v.className = 'clip-card__tempo';
      const title = document.createElement('label'); title.className = 'clip-card__title'; title.textContent = cfg.title;
      const inp = document.createElement('input');
      inp.className = 'clip-card__input'; inp.type = 'text'; inp.inputMode = 'decimal'; inp.autocomplete = 'off';
      inp.id = 'clipFormInput'; title.htmlFor = inp.id;
      inp.value = cfg.value;
      const go = document.createElement('button'); go.type = 'button'; go.className = 'clip-card__go'; go.textContent = 'Terapkan';
      const err = document.createElement('div'); err.className = 'clip-card__err'; err.setAttribute('role', 'alert'); err.hidden = true;
      const parse = (): number | null => {
        const n = parseFloat(inp.value.replace(',', '.').replace('\u2212', '-'));
        return isFinite(n) && n >= cfg.min && n <= cfg.max ? Math.round(n * 100) / 100 : null;
      };

      const showErr = (msg: string): void => { err.textContent = msg; err.hidden = false; if (card === c) place(); };
      const clearErr = (): void => { if (!err.hidden) { err.hidden = true; if (card === c) place(); } };

      const steppers: HTMLButtonElement[] = [];
      let field: HTMLElement = inp;
      if (cfg.step) {
        const step = cfg.step;
        const mk = (dir: 1 | -1): HTMLButtonElement => {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'clip-card__step';
          b.textContent = dir > 0 ? '+' : '\u2212'; b.setAttribute('aria-label', (dir > 0 ? 'Naik ' : 'Turun ') + step);
          b.addEventListener('click', () => {
            clearErr();
            const base = parse() ?? 0;
            inp.value = fmt(Math.max(cfg.min, Math.min(cfg.max, base + dir * step)));
          });
          steppers.push(b); return b;
        };
        field = document.createElement('div'); field.className = 'clip-card__row';
        field.append(mk(-1), inp, mk(1));
      }
      v.append(title, field);
      if (cfg.hint) { const h = document.createElement('div'); h.className = 'clip-card__hint'; h.textContent = cfg.hint; v.appendChild(h); }
      v.append(go, err);

      let busy = false;
      const lock = (on: boolean): void => { inp.disabled = go.disabled = on; steppers.forEach(b => { b.disabled = on; }); };
      const submit = async (): Promise<void> => {
        if (busy) return;
        const n = parse();
        if (n === null) {
          showErr(cfg.msg);
          inp.classList.remove('is-shake'); void inp.offsetWidth; inp.classList.add('is-shake'); inp.focus();
          return;
        }
        busy = true; lock(true); clearErr();
        go.replaceChildren(Object.assign(document.createElement('span'), {className: 'clip-card__spin'}));
        try {
          await cfg.apply(n);
          close();
        } catch (e) {
          busy = false; lock(false); go.textContent = 'Terapkan';
          showErr((e as Error).message || 'Gagal memproses audio');
          if (card === c) inp.focus();
        }
      };
      go.addEventListener('click', submit);
      inp.addEventListener('input', clearErr);
      inp.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();   // ketikan tidak boleh sampai ke pintasan keyboard DAW (spasi = play, tombol piano, dst)
        if (e.key === 'Enter') { e.preventDefault(); void submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      inp.addEventListener('keyup', (e: KeyboardEvent) => e.stopPropagation());
      return v;
    };
    const tempoView = (): HTMLElement => formView({
      title: 'Masukkan BPM vocal', value: fmt(hooks.getClipBpm(pattern) ?? hooks.getProjectBpm()),
      min: 20, max: 400, msg: 'BPM harus antara 20 dan 400', apply: n => hooks.applyTempo(pattern, n),
    });
    const pitchView = (): HTMLElement => formView({
      title: 'Pitch clip (semitone)', value: fmt(hooks.getClipPitch(pattern)),
      min: PITCH_MIN, max: PITCH_MAX, step: 1, hint: '\u221212 sampai +12 \u00b7 0 = nada asli',
      msg: 'Pitch harus antara \u221212 dan +12', apply: n => hooks.applyPitch(pattern, n),
    });

    const inner = document.createElement('div'); inner.className = 'clip-card__in';
    c.appendChild(inner);
    const showView = (make: () => HTMLElement): void => {
      const w0 = c.offsetWidth, h0 = c.offsetHeight;
      const v = make();
      inner.replaceChildren(v);
      place();
      const w1 = c.offsetWidth, h1 = c.offsetHeight;
      if (!REDUCE) {
        c.animate([{width: w0 + 'px', height: h0 + 'px'}, {width: w1 + 'px', height: h1 + 'px'}], {duration: 200, easing: 'cubic-bezier(.2,.9,.3,1)'});
        v.animate([{opacity: 0}, {opacity: 1}], {duration: 160, delay: 50, easing: 'ease-out', fill: 'backwards'});
      }
      const inp = v.querySelector('input') as HTMLInputElement;
      inp.focus({preventScroll: true}); inp.select();
    };

    // --- tampilan 1: menu ---
    if (pattern.dataset.clip) {
      const item = (text: string, view: () => HTMLElement, val = ''): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'clip-card__item'; b.setAttribute('role', 'menuitem');
        b.append(text);
        if (val) { const s = document.createElement('span'); s.className = 'clip-card__val'; s.textContent = val; b.appendChild(s); }
        b.addEventListener('click', () => showView(view));
        return b;
      };
      const pv = hooks.getClipPitch(pattern);
      inner.append(item(MENU_LABEL, tempoView), item(PITCH_LABEL, pitchView, pv ? (pv > 0 ? '+' : '\u2212') + fmt(Math.abs(pv)) : ''));
    } else {
      const it = document.createElement('button');
      it.type = 'button'; it.className = 'clip-card__item'; it.setAttribute('role', 'menuitemcheckbox');
      it.textContent = PATTERN_MENU_LABEL;
      it.setAttribute('aria-checked', String(!!(hooks.isPatternSynced && hooks.isPatternSynced(pattern))));
      it.addEventListener('click', () => { hooks.onPatternMenu && hooks.onPatternMenu(pattern); close(); });
      inner.appendChild(it);
    }
    document.body.appendChild(c);
    place();
    card = c;
    hooks.onOpen && hooks.onOpen(pattern);
    if (!REDUCE) {
      const dy = below ? -6 : 6;
      c.animate(
        [{opacity: 0, transform: 'scale(.82) translateY(' + dy + 'px)'}, {opacity: 1, transform: 'scale(1) translateY(0)'}],
        {duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.25)'}
      );
    }
  };

  const cancel = (): void => { clearTimeout(timer); pending = false; };

  lanesEl.addEventListener('pointerdown', (e: PointerEvent) => {
    cancel(); fired = false;
    if (e.button > 0) return;
    const head = iconHead(e.target);
    if (!head) return;
    const r = head.getBoundingClientRect();
    if (e.clientX - r.left > ICON_ZONE) return;
    const pattern = head.parentElement as HTMLElement;
    pending = true; sx = e.clientX; sy = e.clientY;
    timer = window.setTimeout(() => {
      pending = false; fired = true;
      open(new DOMRect(r.left + 8, r.top, 13, r.height), pattern);
    }, HOLD_MS);
  });
  document.addEventListener('pointermove', (e: PointerEvent) => {
    if (pending && Math.hypot(e.clientX - sx, e.clientY - sy) > HOLD_SLOP) cancel();
  });
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  // tahan lama di layar sentuh bisa memunculkan menu bawaan browser: dimatikan untuk area icon
  lanesEl.addEventListener('contextmenu', (e: Event) => { if ((pending || fired) && iconHead(e.target)) e.preventDefault(); });

  document.addEventListener('pointerdown', (e: PointerEvent) => {
    if (card && !card.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') close(); });
  document.addEventListener('scroll', e => {
    if (card && !card.contains(e.target as Node)) close(true);   // scroll di dalam card sendiri (mis. input) tidak menutupnya
  }, {capture: true, passive: true});
}
