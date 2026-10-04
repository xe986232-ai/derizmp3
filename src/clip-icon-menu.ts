// Tahan icon microphone di header pattern audio clip -> muncul card putih berisi menu "Tempo" (animasi masuk + keluar).
// Tempo: isi BPM asli audio clip (mis. vokal 126), lalu clip di-stretch (pitch tetap) mengikuti BPM project (mis. 130).
// Icon-nya pseudo-element CSS (.pattern__head::before), jadi tidak bisa diberi listener sendiri:
// area icon dihitung dari posisi sentuhan relatif ke kiri header (padding 8px + icon 13px + toleransi jari).
// Tutup card: ketuk di luar, Esc, scroll, atau selesai stretch.

const ICON_ZONE = 8 + 13 + 7;   // px dari tepi kiri header: padding + lebar icon + toleransi
const HOLD_MS = 450;            // lama menahan
const HOLD_SLOP = 10;           // px maksimum bergeser selama menahan (lebih dari ini = batal)
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MENU_LABEL = 'Sesuaikan Tempo';   // menyamakan tempo audio clip dengan BPM project
const svg = (d: string): string => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const IC_METRO = svg('<path d="M9.6 3h4.8l3.4 18H6.2z"/><path d="M12 16.5L16.2 7"/><path d="M9.8 16.5h4.4"/>');
const IC_MINUS = svg('<path d="M6 12h12"/>');
const IC_PLUS = svg('<path d="M12 6v12M6 12h12"/>');

export interface ClipIconMenuHooks {
  onOpen?(pattern: HTMLElement): void;     // card muncul (main.ts menyembunyikan menu bulat)
  onClose?(): void;                        // card ditutup
  getProjectBpm(): number;                 // BPM project sekarang
  getClipBpm(pattern: HTMLElement): number | null;   // BPM yang pernah diisi untuk clip ini (null = belum)
  applyTempo(pattern: HTMLElement, bpm: number): Promise<void>;   // stretch clip; lempar Error(pesan) kalau gagal
}

export function initClipIconMenu(lanesEl: HTMLElement, hooks: ClipIconMenuHooks): void {
  let card: HTMLDivElement | null = null;
  let timer = 0, pending = false, fired = false;
  let sx = 0, sy = 0;

  const iconHead = (t: EventTarget | null): HTMLElement | null =>
    t instanceof Element ? t.closest('.pattern[data-clip] .pattern__head') as HTMLElement | null : null;

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
      below = icon.bottom + 8 + h <= innerHeight - 8 || icon.top - 8 - h < 8;
      const top = below ? icon.bottom + 8 : icon.top - 8 - h;
      const left = Math.max(8, Math.min(icon.left - 12, innerWidth - w - 8));
      c.style.left = left + 'px';
      c.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + 'px';
      const ax = Math.max(18, Math.min(icon.left + icon.width / 2 - left, w - 18));   // panah menunjuk tepat ke icon
      c.style.setProperty('--ax', ax + 'px'); c.dataset.side = below ? 'b' : 't';
      c.style.transformOrigin = ax + 'px ' + (below ? '0' : h + 'px');   // tumbuh dari icon
    };

    // --- tampilan 2: input BPM ---
    const tempoView = (): HTMLElement => {
      const v = document.createElement('div'); v.className = 'clip-card__tempo';
      const title = document.createElement('div'); title.className = 'clip-card__title'; title.textContent = 'Masukkan BPM vocal';
      const stepper = document.createElement('div'); stepper.className = 'clip-card__stepper';
      const mkStep = (label: string, ic: string): HTMLButtonElement => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'clip-card__step'; b.setAttribute('aria-label', label); b.innerHTML = ic; return b;
      };
      const minus = mkStep('Kurangi 1 BPM', IC_MINUS), plus = mkStep('Tambah 1 BPM', IC_PLUS);
      const field = document.createElement('div'); field.className = 'clip-card__field';
      const inp = document.createElement('input');
      inp.className = 'clip-card__input'; inp.type = 'text'; inp.inputMode = 'decimal'; inp.autocomplete = 'off';
      inp.setAttribute('aria-label', 'BPM vocal');
      inp.value = fmt(hooks.getClipBpm(pattern) ?? hooks.getProjectBpm());
      const unit = document.createElement('span'); unit.className = 'clip-card__unit'; unit.textContent = 'BPM';
      field.append(inp, unit); stepper.append(minus, field, plus);
      const go = document.createElement('button'); go.type = 'button'; go.className = 'clip-card__go'; go.textContent = 'Terapkan';
      const err = document.createElement('div'); err.className = 'clip-card__err'; err.setAttribute('role', 'alert'); err.hidden = true;
      v.append(title, stepper, go, err);

      const showErr = (msg: string): void => {
        err.textContent = msg; err.hidden = false;
        if (card === c) place();
        if (!REDUCE) err.animate([{opacity: 0, transform: 'translateY(-4px)'}, {opacity: 1, transform: 'none'}], {duration: 180, easing: 'ease-out'});
      };
      const clearErr = (): void => { if (!err.hidden) { err.hidden = true; if (card === c) place(); } };
      const nudge = (d: number): void => {
        const cur = parseFloat(inp.value.replace(',', '.'));
        inp.value = fmt(Math.max(20, Math.min(400, (isFinite(cur) ? cur : hooks.getProjectBpm()) + d))); clearErr();
      };
      minus.addEventListener('click', () => nudge(-1));
      plus.addEventListener('click', () => nudge(1));

      let busy = false;
      const submit = async (): Promise<void> => {
        if (busy) return;
        const bpm = parseFloat(inp.value.replace(',', '.'));
        if (!isFinite(bpm) || bpm < 20 || bpm > 400) {
          showErr('BPM harus antara 20 dan 400');
          field.classList.remove('is-shake'); void field.offsetWidth; field.classList.add('is-shake'); inp.focus();
          return;
        }
        busy = true; inp.disabled = minus.disabled = plus.disabled = go.disabled = true; clearErr();
        go.replaceChildren(Object.assign(document.createElement('span'), {className: 'clip-card__spin'}));
        try {
          await hooks.applyTempo(pattern, bpm);
          close();
        } catch (e) {
          busy = false; inp.disabled = minus.disabled = plus.disabled = go.disabled = false; go.textContent = 'Terapkan';
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
        else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1); }
      });
      inp.addEventListener('keyup', (e: KeyboardEvent) => e.stopPropagation());
      return v;
    };

    const inner = document.createElement('div'); inner.className = 'clip-card__in';
    c.appendChild(inner);
    const showTempo = (): void => {
      const w0 = c.offsetWidth, h0 = c.offsetHeight;
      const v = tempoView();
      inner.replaceChildren(v);
      place();
      const w1 = c.offsetWidth, h1 = c.offsetHeight;
      if (!REDUCE) {
        c.animate([{width: w0 + 'px', height: h0 + 'px'}, {width: w1 + 'px', height: h1 + 'px'}], {duration: 240, easing: 'cubic-bezier(.2,.9,.3,1)'});
        v.animate([{opacity: 0, transform: 'translateY(6px) scale(.97)'}, {opacity: 1, transform: 'none'}], {duration: 210, delay: 60, easing: 'ease-out', fill: 'backwards'});
      }
      const inp = v.querySelector('input') as HTMLInputElement;
      inp.focus({preventScroll: true}); inp.select();
    };

    // --- tampilan 1: menu ---
    const it = document.createElement('button');
    it.type = 'button'; it.className = 'clip-card__item'; it.setAttribute('role', 'menuitem');
    const ico = document.createElement('span'); ico.className = 'clip-card__ico'; ico.innerHTML = IC_METRO;
    it.append(ico, document.createTextNode(MENU_LABEL));
    it.addEventListener('click', showTempo);
    inner.appendChild(it);
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
