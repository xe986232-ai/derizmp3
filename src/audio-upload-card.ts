// Card upload audio: muncul setelah memilih "Audio clip" di menu Tambahkan track.
// Tampilan saja untuk sekarang: file yang dipilih disimpan di trackAudioFiles
// (kunci = id track) supaya tahap berikutnya (decode, waveform, playback) tinggal membacanya.

const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|m4a|aac|flac|opus|weba|webm)$/i;
const ACCEPT = 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus';

export const trackAudioFiles = new Map<number, File>();

let current: { close: (instant?: boolean) => void } | null = null;

const isAudio = (f: File) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);
const fmtSize = (b: number) =>
  b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / (1024 * 1024)).toFixed(1) + ' MB';

const ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_UP = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 16V5M7 10l5-5 5 5M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_NOTE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="18" r="2.4" fill="currentColor"/><circle cx="17" cy="16" r="2.4" fill="currentColor"/></svg>';

function q<T extends Element>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error('Elemen tidak ditemukan: ' + sel);
  return el;
}

export function openAudioUploadCard(trackId: number): void {
  if (current) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const trackName = document.getElementById('track-name-' + trackId)?.textContent ?? 'Audio clip';

  const backdrop = document.createElement('div');
  backdrop.className = 'upl-backdrop';
  backdrop.innerHTML = `
    <div class="upl-card" role="dialog" aria-modal="true" aria-labelledby="uplTitle" tabindex="-1">
      <div class="upl-head upl-s" style="--i:0">
        <div class="upl-head__text">
          <h2 class="upl-title" id="uplTitle">Tambah audio</h2>
          <p class="upl-sub"></p>
        </div>
        <button type="button" class="upl-x" aria-label="Tutup">${ICON_X}</button>
      </div>
      <div class="upl-zone upl-s" style="--i:1">
        <span class="upl-zone__icon">${ICON_UP}</span>
        <span class="upl-zone__title">Tarik &amp; lepas file di sini</span>
        <span class="upl-zone__or">atau</span>
        <button type="button" class="upl-pick">Pilih file</button>
        <span class="upl-zone__hint">MP3, WAV, OGG, M4A, FLAC</span>
      </div>
      <p class="upl-error" role="alert" hidden></p>
      <div class="upl-file">
        <div class="upl-file__in">
          <div class="upl-file__row">
            <span class="upl-file__icon">${ICON_NOTE}</span>
            <span class="upl-file__meta"><span class="upl-file__name"></span><span class="upl-file__size"></span></span>
            <button type="button" class="upl-file__rm" aria-label="Hapus file">${ICON_X}</button>
          </div>
        </div>
      </div>
      <div class="upl-actions upl-s" style="--i:2">
        <button type="button" class="upl-btn upl-btn--ghost" data-act="cancel">Batal</button>
        <button type="button" class="upl-btn upl-btn--solid" data-act="done" disabled>Selesai</button>
      </div>
      <input type="file" class="upl-input" accept="${ACCEPT}" hidden>
    </div>`;

  const card = q<HTMLElement>(backdrop, '.upl-card');
  const zone = q<HTMLElement>(backdrop, '.upl-zone');
  const input = q<HTMLInputElement>(backdrop, '.upl-input');
  const errEl = q<HTMLElement>(backdrop, '.upl-error');
  const fileEl = q<HTMLElement>(backdrop, '.upl-file');
  const nameEl = q<HTMLElement>(backdrop, '.upl-file__name');
  const sizeEl = q<HTMLElement>(backdrop, '.upl-file__size');
  const doneBtn = q<HTMLButtonElement>(backdrop, '[data-act="done"]');
  q<HTMLElement>(backdrop, '.upl-sub').textContent = 'Untuk track: ' + trackName;

  let file: File | null = null;
  let closed = false;

  const close = (instant = false) => {
    if (closed) return;
    closed = true; current = null;
    const finish = () => { backdrop.remove(); prevFocus?.isConnected && prevFocus.focus({ preventScroll: true }); };
    if (instant || reduce) { finish(); return; }
    backdrop.classList.add('is-closing');
    setTimeout(finish, 220);
  };
  current = { close };

  const showError = (msg: string) => {
    errEl.textContent = msg; errEl.hidden = false;
    errEl.classList.remove('is-shake'); void errEl.offsetWidth; errEl.classList.add('is-shake');
  };
  const clearError = () => { errEl.hidden = true; errEl.textContent = ''; };
  const setFile = (f: File) => {
    if (!isAudio(f)) { showError('Format tidak didukung. Pilih file audio (MP3, WAV, OGG, M4A, atau FLAC).'); return; }
    clearError();
    file = f;
    nameEl.textContent = f.name; sizeEl.textContent = fmtSize(f.size);
    fileEl.classList.remove('is-on'); void fileEl.offsetWidth; fileEl.classList.add('is-on');
    doneBtn.disabled = false;
  };
  const clearFile = () => {
    file = null; input.value = '';
    fileEl.classList.remove('is-on');
    doneBtn.disabled = true;
  };

  // pilih lewat dialog file
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { const f = input.files?.[0]; if (f) setFile(f); });
  // tarik & lepas
  let depth = 0;
  zone.addEventListener('dragenter', e => { e.preventDefault(); depth++; zone.classList.add('is-over'); });
  zone.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('is-over'); } });
  zone.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; zone.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0]; if (f) setFile(f);
  });
  // file yang dilepas di luar area tidak boleh membuka file di tab
  backdrop.addEventListener('dragover', e => e.preventDefault());
  backdrop.addEventListener('drop', e => e.preventDefault());

  q<HTMLElement>(backdrop, '.upl-file__rm').addEventListener('click', clearFile);
  q<HTMLElement>(backdrop, '.upl-x').addEventListener('click', () => close());
  q<HTMLElement>(backdrop, '[data-act="cancel"]').addEventListener('click', () => close());
  doneBtn.addEventListener('click', () => {
    if (!file) return;
    trackAudioFiles.set(trackId, file);
    close();
  });
  backdrop.addEventListener('pointerdown', e => { if (e.target === backdrop) close(); });

  // keyboard: Esc menutup, Tab berputar di dalam card, dan pintasan DAW (Space, panah, dll.) tidak ikut jalan
  card.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...card.querySelectorAll<HTMLElement>('button:not([disabled])')].filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  card.addEventListener('keyup', e => e.stopPropagation());

  document.body.appendChild(backdrop);
  card.focus({ preventScroll: true });
}
