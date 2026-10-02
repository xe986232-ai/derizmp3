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
      '<header class="mp__head mp__item" style="--i:0"><h2 class="mp__title">Menu</h2></header>' +
      '<div class="mp__body">' +
        '<div class="mp__card mp__item mp__save" style="--i:1">' +
          '<button type="button" class="mp__savebtn" aria-label="Simpan project"><span>SAVE</span></button>' +
          '<p class="mp__hint">Simpan project ke browser ini.</p>' +
        '</div>' +
        '<div class="mp__card mp__item" style="--i:2">' +
          '<div class="mp__sub"><span>File project</span><button type="button" class="mp__imp">Buka .json</button></div>' +
          '<ul class="mp__files"></ul><p class="mp__hint mp__empty">Belum ada project tersimpan.</p>' +
          '<input type="file" class="mp__impfile" accept="application/json,.json" hidden>' +
        '</div>' +
      '</div>' +
    '</div>';

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
    if (open && e.key === 'Escape') { apply(false, true); btn.focus(); }
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
  panel.querySelector('.mp__savebtn')!.addEventListener('click', () => { void openOv(); });
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
