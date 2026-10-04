// Tahan icon microphone di header pattern audio clip -> muncul card putih berisi menu "Tempo" (animasi masuk + keluar).
// Tempo: isi BPM asli audio clip (mis. vokal 126), lalu clip di-stretch (pitch tetap) mengikuti BPM project (mis. 130).
// Icon-nya pseudo-element CSS (.pattern__head::before), jadi tidak bisa diberi listener sendiri:
// area icon dihitung dari posisi sentuhan relatif ke kiri header (padding 8px + icon 13px + toleransi jari).
// Tutup card: ketuk di luar, Esc, scroll, atau selesai stretch.

const ICON_ZONE = 8 + 13 + 7;   // px dari tepi kiri header: padding + lebar icon + toleransi
const HOLD_MS = 450;            // lama menahan
const HOLD_SLOP = 10;           // px maksimum bergeser selama menahan (lebih dari ini = batal)
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

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
      below = icon.bottom + 6 + h <= innerHeight - 8 || icon.top - 6 - h < 8;
      const top = below ? icon.bottom + 6 : icon.top - 6 - h;
      c.style.left = Math.max(8, Math.min(icon.left, innerWidth - w - 8)) + 'px';
      c.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + 'px';
      c.style.transformOrigin = (icon.left + icon.width / 2 - c.offsetLeft) + 'px ' + (below ? '0' : h + 'px');   // tumbuh dari icon
    };

    // --- tampilan 2: input BPM ---
    const tempoView = (): HTMLElement => {
      const projectBpm = hooks.getProjectBpm();
      const v = document.createElement('div'); v.className = 'clip-card__tempo';
      const lbl = document.createElement('label'); lbl.className = 'clip-card__lbl'; lbl.textContent = 'BPM audio ini';
      const row = document.createElement('div'); row.className = 'clip-card__row';
      const inp = document.createElement('input');
      inp.className = 'clip-card__input'; inp.type = 'text'; inp.inputMode = 'decimal'; inp.autocomplete = 'off';
      inp.id = 'clipTempoInput'; lbl.htmlFor = inp.id;
      inp.value = fmt(hooks.getClipBpm(pattern) ?? projectBpm);
      const go = document.createElement('button'); go.type = 'button'; go.className = 'clip-card__go'; go.textContent = 'Stretch';
      const hint = document.createElement('div'); hint.className = 'clip-card__hint';
      const idle = 'Diselaraskan ke ' + fmt(projectBpm) + ' BPM project';
      hint.textContent = idle;
      row.append(inp, go); v.append(lbl, row, hint);

      let busy = false;
      const submit = async (): Promise<void> => {
        if (busy) return;
        const bpm = parseFloat(inp.value.replace(',', '.'));
        if (!isFinite(bpm) || bpm < 20 || bpm > 400) {
          hint.textContent = 'Isi BPM antara 20 dan 400'; hint.className = 'clip-card__hint is-err';
          inp.classList.remove('is-shake'); void inp.offsetWidth; inp.classList.add('is-shake'); inp.focus();
          return;
        }
        busy = true; inp.disabled = true; go.disabled = true;
        go.replaceChildren(Object.assign(document.createElement('span'), {className: 'clip-card__spin'}));
        hint.textContent = 'Memproses…'; hint.className = 'clip-card__hint';
        try {
          await hooks.applyTempo(pattern, bpm);
          close();
        } catch (err) {
          busy = false; inp.disabled = false; go.disabled = false; go.textContent = 'Stretch';
          hint.textContent = (err as Error).message || 'Gagal memproses audio'; hint.className = 'clip-card__hint is-err';
          if (card === c) { place(); inp.focus(); }
        }
      };
      go.addEventListener('click', submit);
      inp.addEventListener('input', () => { if (hint.className.includes('is-err')) { hint.textContent = idle; hint.className = 'clip-card__hint'; } });
      inp.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();   // ketikan tidak boleh sampai ke pintasan keyboard DAW (spasi = play, tombol piano, dst)
        if (e.key === 'Enter') { e.preventDefault(); void submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      inp.addEventListener('keyup', (e: KeyboardEvent) => e.stopPropagation());
      return v;
    };

    const showTempo = (): void => {
      const w0 = c.offsetWidth, h0 = c.offsetHeight;
      const v = tempoView();
      c.replaceChildren(v);
      place();
      const w1 = c.offsetWidth, h1 = c.offsetHeight;
      if (!REDUCE) {
        c.animate([{width: w0 + 'px', height: h0 + 'px'}, {width: w1 + 'px', height: h1 + 'px'}], {duration: 210, easing: 'cubic-bezier(.2,.9,.3,1)'});
        v.animate([{opacity: 0, transform: 'translateY(5px)'}, {opacity: 1, transform: 'none'}], {duration: 190, delay: 50, easing: 'ease-out', fill: 'backwards'});
      }
      const inp = v.querySelector('input') as HTMLInputElement;
      inp.focus({preventScroll: true}); inp.select();
    };

    // --- tampilan 1: menu ---
    const it = document.createElement('button');
    it.type = 'button'; it.className = 'clip-card__item'; it.setAttribute('role', 'menuitem');
    it.textContent = 'Tempo';
    it.addEventListener('click', showTempo);
    c.appendChild(it);
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
