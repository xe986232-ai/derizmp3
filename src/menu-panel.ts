// Tombol menu di pojok kanan atas (card 3D + bevel) yang membuka panel geser dari kanan, gaya sama dengan panel efek.
// Panel menimpa layar (tidak mendorong timeline). Tutup: klik tombol lagi, klik di luar panel, atau Esc.
// Saat piano roll terbuka tombolnya disembunyikan (CSS) supaya tidak menimpa tombol X piano roll, dan panel ikut menutup.

import { saveProject, loadProject, deleteProject, listProjects, projectExists, recordToJson, jsonToRecord } from './project-store';

// Jembatan ke main.ts (yang memegang data timeline): snapshot dan pemulihan project
export interface ProjectIO {
  snapshot(): { data: unknown; clips: Record<string, Blob> };
  restore(rec: { name: string; savedAt: number; data: unknown; clips: Record<string, Blob> }): Promise<void>;
  toast(msg: string, ms?: number): void;
}
let io: ProjectIO | null = null;
let onIo: (() => void) | null = null;
export function setProjectIO(v: ProjectIO): void { io = v; onIo && onIo(); }

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c] as string));
const fmtDate = (t: number) => new Date(t).toLocaleString('id-ID', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const IC_DL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>';
const IC_DEL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';

const svgi = (d: string, w = 20): string => '<svg viewBox="0 0 24 24" width="' + w + '" height="' + w + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const IC_FOLDER = svgi('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
const IC_GEAR = svgi('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>');
const IC_CHEV = svgi('<path d="M9 5l7 7-7 7"/>', 16);
const IC_BACK = svgi('<path d="M15 5l-7 7 7 7"/>', 18);

const ICON_GRID =
  '<svg class="menu-btn__ic menu-btn__ic--grid" viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="4" y="4" width="6.5" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<rect x="13.5" y="4" width="6.5" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<rect x="4" y="13.5" width="6.5" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2" fill="#9d86ff"/></svg>';
const ICON_CLOSE =
  '<svg class="menu-btn__ic menu-btn__ic--x" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

export interface MenuPanel {
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

export function initMenuPanel(): MenuPanel {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'menuBtn'; btn.className = 'menu-btn';
  btn.setAttribute('aria-controls', 'menuPanel');
  btn.innerHTML = ICON_GRID + ICON_CLOSE;

  const panel = document.createElement('aside');
  panel.id = 'menuPanel'; panel.className = 'mp'; panel.setAttribute('aria-label', 'Menu');
  panel.innerHTML =
    '<div class="mp__panel">' +
      '<header class="mp__head mp__item" style="--i:0"><button type="button" class="mp__back" aria-label="Kembali ke menu" title="Kembali" hidden>' + IC_BACK + '</button><h2 class="mp__title">Menu</h2></header>' +
      '<div class="mp__body">' +
        // halaman utama: daftar kategori
        '<nav class="mp__page" data-page="home" aria-label="Kategori menu">' +
          '<button type="button" class="mp__cat mp__item" style="--i:1" data-go="project">' + IC_FOLDER + '<span class="mp__cat__t"><b>Project</b><small>Simpan &amp; buka project</small></span>' + IC_CHEV + '</button>' +
          '<button type="button" class="mp__cat mp__item" style="--i:2" data-go="settings">' + IC_GEAR + '<span class="mp__cat__t"><b>Pengaturan</b><small>Preferensi aplikasi</small></span>' + IC_CHEV + '</button>' +
        '</nav>' +
        // kategori Project
        '<section class="mp__page" data-page="project" aria-label="Project" hidden>' +
          '<div class="mp__card mp__item mp__save" style="--i:1">' +
            '<button type="button" class="mp__savebtn" aria-label="Simpan project">' +
              '<svg class="mp__ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" pathLength="100"/></svg><span>SAVE</span></button>' +
            '<p class="mp__hint">Ketuk: simpan sebagai project baru.<br>Tahan: simpan perubahan ke project yang sedang dibuka.</p>' +
          '</div>' +
          '<div class="mp__card mp__item" style="--i:2">' +
            '<div class="mp__sub"><span>File project</span><button type="button" class="mp__imp">Buka .json</button></div>' +
            '<ul class="mp__files"></ul><p class="mp__hint mp__empty">Belum ada project tersimpan.</p>' +
            '<input type="file" class="mp__impfile" accept="application/json,.json" hidden>' +
          '</div>' +
        '</section>' +
        // kategori Pengaturan
        '<section class="mp__page" data-page="settings" aria-label="Pengaturan" hidden>' +
          '<div class="mp__card mp__item mp__set" style="--i:1">' +
            '<div class="mp__sub"><span>Waveform &amp; bar color</span></div>' +
            '<div class="mp__seg" role="radiogroup" aria-label="Waveform & bar color">' +
              '<button type="button" class="mp__segbtn" role="radio" data-wf="default"><i class="mp__sw mp__sw--default"></i>Default</button>' +
              '<button type="button" class="mp__segbtn" role="radio" data-wf="black"><i class="mp__sw mp__sw--black"></i>Black</button>' +
            '</div>' +
            '<p class="mp__hint">Warna waveform audio di timeline dan note yang terlihat dari luar piano roll.</p>' +
          '</div>' +
        '</section>' +
      '</div>' +
    '</div>';

  // ===== Pengaturan: Waveform & bar color (disimpan di browser, diterapkan lewat atribut data-wf di <html>) =====
  const WF_KEY = 'derizmp3.wfColor';
  const wfBtns = [...panel.querySelectorAll<HTMLButtonElement>('[data-wf]')];
  const setWf = (v: string, save: boolean): void => {
    const val = v === 'black' ? 'black' : 'default';
    document.documentElement.dataset.wf = val;
    wfBtns.forEach(b => { const on = b.dataset.wf === val; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
    if (save) { try { localStorage.setItem(WF_KEY, val); } catch { /* penyimpanan diblokir: tetap berlaku sampai halaman ditutup */ } }
  };
  wfBtns.forEach(b => b.addEventListener('click', () => setWf(b.dataset.wf as string, true)));
  let wfSaved = 'default';
  try { wfSaved = localStorage.getItem(WF_KEY) || 'default'; } catch { /* abaikan */ }
  setWf(wfSaved, false);

  // ===== Halaman kategori (home / project / settings) =====
  const TITLES: Record<string, string> = {home: 'Menu', project: 'Project', settings: 'Pengaturan'};
  const pages = [...panel.querySelectorAll<HTMLElement>('.mp__page')];
  const titleEl = panel.querySelector('.mp__title') as HTMLElement;
  const backBtn = panel.querySelector('.mp__back') as HTMLButtonElement;
  const bodyEl = panel.querySelector('.mp__body') as HTMLElement;
  let view = 'home';
  const go = (v: string): void => {
    if (v === view) return;
    view = v;
    pages.forEach(pg => { pg.hidden = pg.dataset.page !== v; });
    titleEl.textContent = TITLES[v] || 'Menu';
    backBtn.hidden = v === 'home';
    bodyEl.scrollTop = 0;
    const cur = pages.find(pg => pg.dataset.page === v);
    if (cur) { cur.classList.remove('is-in'); void cur.offsetWidth; cur.classList.add('is-in'); }
  };
  panel.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest('[data-go]') as HTMLElement | null;
    if (t) go(t.dataset.go as string);
  });
  backBtn.addEventListener('click', () => go('home'));

  let open = false;

  const apply = (next: boolean, animate: boolean): void => {
    open = next;
    panel.classList.toggle('mp--open', open);
    btn.classList.toggle('is-open', open);
    const label = open ? 'Tutup menu' : 'Buka menu';
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', label); btn.title = label;
    // saat tertutup, isi panel tidak boleh bisa difokus / dibaca screen reader
    if (open) { panel.removeAttribute('inert'); panel.removeAttribute('aria-hidden'); }
    else { panel.setAttribute('inert', ''); panel.setAttribute('aria-hidden', 'true'); }
    if (!open) setTimeout(() => { if (!open) go('home'); }, 480);   // kembali ke daftar kategori setelah panel selesai meluncur keluar
    void animate;
  };

  btn.addEventListener('click', () => apply(!open, true));

  document.addEventListener('pointerdown', e => {
    if (!open) return;
    const t = e.target as Node;
    if (panel.contains(t) || btn.contains(t) || (t as HTMLElement).closest?.('.svov')) return;
    apply(false, true);
  });
  document.addEventListener('keydown', e => {
    if (!open || e.key !== 'Escape') return;
    if (view !== 'home') { go('home'); return; }
    apply(false, true); btn.focus();
  });

  // piano roll terbuka -> panel menutup (tombolnya sendiri disembunyikan lewat CSS)
  const stage = document.querySelector('.stage');
  if (stage) {
    new MutationObserver(() => { if (open && document.querySelector('.pr.is-open')) apply(false, true); })
      .observe(stage, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }


  // ===== Simpan / buka project =====
  let curName = '';
  const filesEl = panel.querySelector('.mp__files') as HTMLUListElement;
  const emptyEl = panel.querySelector('.mp__empty') as HTMLElement;
  const say = (m: string, ms?: number) => io ? io.toast(m, ms) : undefined;

  const refresh = async (): Promise<void> => {
    let items: Array<{name: string; savedAt: number}> = [];
    try { items = await listProjects(); } catch { /* IndexedDB tidak tersedia */ }
    emptyEl.hidden = items.length > 0;
    filesEl.innerHTML = items.map((p, i) =>
      '<li class="mp__file" data-n="' + esc(p.name) + '" style="--i:' + i + '">' +
        '<button type="button" class="mp__open" data-act="open"><b>' + esc(p.name) + '</b><small>' + fmtDate(p.savedAt) + '</small></button>' +
        '<button type="button" class="mp__ico" data-act="dl" aria-label="Unduh .json" title="Unduh .json">' + IC_DL + '</button>' +
        '<button type="button" class="mp__ico" data-act="del" aria-label="Hapus project" title="Hapus">' + IC_DEL + '</button>' +
      '</li>').join('');
  };
  onIo = () => { void refresh(); };
  void refresh();

  // overlay nama file project
  const ov = document.createElement('div');
  ov.className = 'svov'; ov.hidden = true;
  ov.innerHTML =
    '<div class="svov__back"></div>' +
    '<div class="svov__card" role="dialog" aria-modal="true" aria-label="Simpan project">' +
      '<h3 class="svov__title">Simpan project</h3>' +
      '<label class="svov__lbl" for="svName">Nama file project</label>' +
      '<input id="svName" class="svov__in" type="text" maxlength="60" autocomplete="off" spellcheck="false">' +
      '<p class="svov__note" aria-live="polite"></p>' +
      '<div class="svov__row"><button type="button" class="svov__btn" data-a="cancel">Batal</button>' +
      '<button type="button" class="svov__btn svov__btn--ok" data-a="ok">Simpan</button></div>' +
    '</div>';
  document.body.appendChild(ov);
  const inp = ov.querySelector('.svov__in') as HTMLInputElement;
  const note = ov.querySelector('.svov__note') as HTMLElement;
  const okBtn = ov.querySelector('[data-a="ok"]') as HTMLButtonElement;
  let busy = false;

  const closeOv = (): void => { ov.hidden = true; busy = false; };
  const openOv = async (): Promise<void> => {
    if (!io) { say('Project belum siap, coba lagi sebentar'); return; }
    if (!curName) {
      let n = 1; const taken = new Set((await listProjects().catch(() => [])).map(p => p.name));
      while (taken.has('Project ' + n)) n++;
      curName = 'Project ' + n;
    }
    inp.value = curName; note.textContent = ''; okBtn.textContent = 'Simpan'; okBtn.disabled = false;
    ov.hidden = false; inp.focus(); inp.select();
    void checkExists();
  };
  const checkExists = async (): Promise<void> => {
    const n = inp.value.trim();
    const ex = n ? await projectExists(n).catch(() => false) : false;
    okBtn.textContent = ex ? 'Timpa' : 'Simpan';
    note.textContent = ex ? 'Nama ini sudah ada, file lama akan ditimpa.' : '';
  };
  const doSave = async (): Promise<void> => {
    const name = inp.value.trim().replace(/\s+/g, ' ');
    if (!name) { note.textContent = 'Nama file tidak boleh kosong.'; inp.focus(); return; }
    if (busy || !io) return;
    busy = true; okBtn.disabled = true; note.textContent = 'Menyimpan…';
    try {
      const snap = io.snapshot();
      await saveProject({name, savedAt: Date.now(), data: snap.data, clips: snap.clips});
      const back = await loadProject(name);   // baca ulang: pastikan benar-benar tersimpan
      if (!back) throw new Error('verifikasi gagal');
      curName = name;
      note.textContent = '✓ Tersimpan: ' + name;
      ov.classList.add('is-done');
      await refresh();
      setTimeout(() => { ov.classList.remove('is-done'); closeOv(); }, 900);
    } catch (err) {
      console.error(err);
      note.textContent = 'Gagal menyimpan (penyimpanan browser penuh atau diblokir).';
      busy = false; okBtn.disabled = false;
    }
  };
  // Tahan SAVE: timpa project yang sedang dibuka dengan perubahan terbaru (tanpa buat project baru).
  // Kalau belum ada project aktif, tahan = sama seperti ketuk (minta nama project baru).
  const HOLD_MS = 700;
  const saveBtn = panel.querySelector('.mp__savebtn') as HTMLButtonElement;
  let holdT = 0, held = false, quickBusy = false;
  const quickSave = async (): Promise<void> => {
    if (!io) { say('Project belum siap, coba lagi sebentar'); return; }
    if (!curName || !(await projectExists(curName).catch(() => false))) { void openOv(); return; }
    if (quickBusy) return;
    quickBusy = true;
    try {
      const snap = io.snapshot();
      await saveProject({name: curName, savedAt: Date.now(), data: snap.data, clips: snap.clips});
      if (!(await loadProject(curName))) throw new Error('verifikasi gagal');
      await refresh();
      say('✓ Perubahan tersimpan: ' + curName);
      saveBtn.classList.add('is-saved'); setTimeout(() => saveBtn.classList.remove('is-saved'), 900);
    } catch (err) { console.error(err); say('Gagal menyimpan (penyimpanan browser penuh atau diblokir).'); }
    quickBusy = false;
  };
  const cancelHold = (): void => { clearTimeout(holdT); saveBtn.classList.remove('is-holding'); };
  saveBtn.style.setProperty('--hold', HOLD_MS + 'ms');
  saveBtn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    held = false; cancelHold();
    saveBtn.classList.add('is-holding');
    holdT = window.setTimeout(() => {
      held = true; saveBtn.classList.remove('is-holding');
      if (navigator.vibrate) navigator.vibrate(30);
      void quickSave();
    }, HOLD_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => saveBtn.addEventListener(t, cancelHold));
  saveBtn.addEventListener('contextmenu', e => e.preventDefault());   // tahan di HP jangan memunculkan menu konteks
  saveBtn.addEventListener('click', () => {
    if (held) { held = false; return; }   // klik setelah tahan sudah ditangani quickSave
    void openOv();
  });
  ov.querySelector('.svov__back')!.addEventListener('pointerdown', () => { if (!busy) closeOv(); });
  ov.addEventListener('click', e => {
    const a = (e.target as HTMLElement).closest('[data-a]')?.getAttribute('data-a');
    if (a === 'cancel') closeOv(); else if (a === 'ok') void doSave();
  });
  inp.addEventListener('input', () => { void checkExists(); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); void doSave(); }
    if (e.key === 'Escape') { e.stopPropagation(); if (!busy) closeOv(); }
  });
  document.addEventListener('keydown', e => { if (!ov.hidden && e.key === 'Escape') { e.stopPropagation(); if (!busy) closeOv(); } }, true);

  // daftar file: buka / unduh / hapus
  const download = (name: string, text: string): void => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
    a.download = name.replace(/[^\w\- ]+/g, '_') + '.derizmp3.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  filesEl.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    const li = btn && btn.closest('.mp__file') as HTMLElement | null;
    if (!btn || !li || !io) return;
    const name = li.dataset.n as string, act = btn.dataset.act;
    try {
      if (act === 'open') {
        say('Membuka ' + name + '…', 0);
        const rec = await loadProject(name);
        if (!rec) { say('File tidak ditemukan'); return; }
        await io.restore(rec); curName = name;
        say('Project dibuka: ' + name); apply(false, true);
      } else if (act === 'dl') {
        const rec = await loadProject(name); if (rec) download(name, await recordToJson(rec));
      } else if (act === 'del') {
        if (btn.dataset.sure !== '1') {   // ketuk dua kali: pertama minta konfirmasi
          btn.dataset.sure = '1'; btn.classList.add('is-sure'); btn.title = 'Ketuk lagi untuk hapus';
          setTimeout(() => { btn.dataset.sure = ''; btn.classList.remove('is-sure'); btn.title = 'Hapus'; }, 2500);
          return;
        }
        await deleteProject(name); if (curName === name) curName = ''; await refresh();
      }
    } catch (err) { console.error(err); say('Gagal memproses file project'); }
  });
  const impFile = panel.querySelector('.mp__impfile') as HTMLInputElement;
  panel.querySelector('.mp__imp')!.addEventListener('click', () => impFile.click());
  impFile.addEventListener('change', async () => {
    const f = impFile.files && impFile.files[0]; impFile.value = '';
    if (!f || !io) return;
    try {
      const rec = await jsonToRecord(await f.text());
      await saveProject(rec); await refresh();
      await io.restore(rec); curName = rec.name;
      say('Project dibuka: ' + rec.name); apply(false, true);
    } catch (err) { console.error(err); say('File project tidak valid'); }
  });

  apply(false, false);
  document.body.append(panel, btn);
  requestAnimationFrame(() => panel.classList.add('mp--ready'));   // transisi baru aktif setelah keadaan awal terpasang

  return { isOpen: () => open, setOpen: v => { if (v !== open) apply(v, true); } };
}
