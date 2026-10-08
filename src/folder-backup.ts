// Cadangan project ke FOLDER pilihan user (File System Access API: showDirectoryPicker).
// Ini TAMBAHAN: IndexedDB (project-store.ts) tetap penyimpanan utama dan tidak diubah. Setiap kali project disimpan,
// salinannya ikut ditulis ke folder; kalau PWA dihapus / data browser dibersihkan, project bisa dipulihkan dari folder itu.
//
// Struktur di dalam folder pilihan user:
//   derizmp3/<Nama Project>/project.json      {app, format, name, savedAt, data, clips: {kunci: 'clips/0.wav'}, clipTypes}
//   derizmp3/<Nama Project>/clips/0.wav ...   audio clip sebagai file biasa (tidak jadi base64, jadi hemat memori)
//
// Handle folder disimpan di IndexedDB TERPISAH (derizmp3-folder), tidak menyentuh database project (derizmp3).
// Tidak semua browser mendukung (iPhone/iOS tidak; Android tergantung versi Chrome): cek folderSupported() dulu.
import type { ProjectRecord, ProjectInfo } from './project-store';

interface PermHandle { queryPermission?(o: {mode: 'read' | 'readwrite'}): Promise<PermissionState>; requestPermission?(o: {mode: 'read' | 'readwrite'}): Promise<PermissionState> }
interface FileH extends PermHandle { kind: 'file'; name: string; getFile(): Promise<File>; createWritable(): Promise<{write(d: Blob | string): Promise<void>; close(): Promise<void>; abort?(): Promise<void>}> }
interface DirH extends PermHandle {
  kind: 'directory'; name: string;
  getDirectoryHandle(n: string, o?: {create?: boolean}): Promise<DirH>;
  getFileHandle(n: string, o?: {create?: boolean}): Promise<FileH>;
  removeEntry(n: string, o?: {recursive?: boolean}): Promise<void>;
  entries(): AsyncIterable<[string, FileH | DirH]>;
}
type Picker = (o?: {mode?: 'read' | 'readwrite'; id?: string}) => Promise<DirH>;

const APP_DIR = 'derizmp3', PJSON = 'project.json', FORMAT = 2;

export const folderSupported = (): boolean => typeof window !== 'undefined' && typeof (window as unknown as {showDirectoryPicker?: Picker}).showDirectoryPicker === 'function';

// ---- simpan handle folder (IndexedDB terpisah) ----
const KDB = 'derizmp3-folder', KST = 'kv', KEY = 'dir';
function kvOpen(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(KDB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(KST)) r.result.createObjectStore(KST); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('IndexedDB gagal dibuka'));
  });
}
async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await kvOpen();
  try {
    return await new Promise<T>((res, rej) => {
      const t = db.transaction(KST, mode), q = fn(t.objectStore(KST));
      t.oncomplete = () => res(q.result);
      t.onerror = t.onabort = () => rej(t.error || new Error('transaksi gagal'));
    });
  } finally { db.close(); }
}
const getHandle = async (): Promise<DirH | null> => { try { return (await kv<DirH | undefined>('readonly', s => s.get(KEY))) || null; } catch { return null; } };

export type FolderState = {state: 'unsupported'} | {state: 'none'} | {state: 'ready' | 'need-permission'; name: string};

async function perm(h: DirH, ask: boolean): Promise<boolean> {
  const o = {mode: 'readwrite' as const};
  try {
    if (!h.queryPermission) return true;
    if ((await h.queryPermission(o)) === 'granted') return true;
    if (ask && h.requestPermission) return (await h.requestPermission(o)) === 'granted';
  } catch { /* handle rusak / folder sudah dihapus */ }
  return false;
}

export async function folderState(): Promise<FolderState> {
  if (!folderSupported()) return {state: 'unsupported'};
  const h = await getHandle();
  if (!h) return {state: 'none'};
  return {state: (await perm(h, false)) ? 'ready' : 'need-permission', name: h.name};
}

// Harus dipanggil dari ketukan user (gesture). Mengembalikan nama folder, atau null kalau dibatalkan.
export async function chooseFolder(): Promise<string | null> {
  const pick = (window as unknown as {showDirectoryPicker?: Picker}).showDirectoryPicker;
  if (!pick) throw new Error('Browser ini belum mendukung pilih folder');
  let h: DirH;
  try { h = await pick.call(window, {mode: 'readwrite', id: 'derizmp3'}); }
  catch (e) { if ((e as {name?: string}).name === 'AbortError') return null; throw e; }
  if (!(await perm(h, true))) throw new Error('Izin menulis ke folder ditolak');
  await kv('readwrite', s => s.put(h, KEY));
  return h.name;
}
// Minta izin lagi untuk folder yang sudah dipilih sebelumnya (izin biasanya hilang tiap sesi baru). Dari ketukan user.
export async function regrantFolder(): Promise<boolean> { const h = await getHandle(); return !!h && (await perm(h, true)); }
export async function forgetFolder(): Promise<void> { await kv('readwrite', s => s.delete(KEY)); }

// ---- baca / tulis ----
const safeName = (n: string): string => (n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').replace(/[. ]+$/, '').trim().slice(0, 80)) || 'Project';

async function appDir(ask: boolean, create: boolean): Promise<DirH | null> {
  const h = await getHandle();
  if (!h || !(await perm(h, ask))) return null;
  return h.getDirectoryHandle(APP_DIR, {create});
}
async function writeFile(dir: DirH, name: string, body: Blob | string): Promise<void> {
  const f = await dir.getFileHandle(name, {create: true});
  const w = await f.createWritable();   // ditulis ke file sementara, baru dipakai saat close(): file lama tidak rusak kalau gagal di tengah
  try { await w.write(body); await w.close(); } catch (e) { try { await w.abort?.(); } catch { /* abaikan */ } throw e; }
}

export type BackupResult = 'ok' | 'no-folder' | 'no-permission';

// Tulis satu project ke folder. Clip ditulis dulu, project.json terakhir (penanda lengkap).
export async function backupToFolder(rec: ProjectRecord, ask = true): Promise<BackupResult> {
  if (!folderSupported()) return 'no-folder';
  const h = await getHandle();
  if (!h) return 'no-folder';
  if (!(await perm(h, ask))) return 'no-permission';
  const root = await h.getDirectoryHandle(APP_DIR, {create: true});
  const pd = await root.getDirectoryHandle(safeName(rec.name), {create: true});
  const cd = await pd.getDirectoryHandle('clips', {create: true});
  const clips: Record<string, string> = {}, clipTypes: Record<string, string> = {};
  let i = 0;
  for (const [k, b] of Object.entries(rec.clips)) {
    const fn = (i++) + '.wav';
    await writeFile(cd, fn, b);
    clips[k] = 'clips/' + fn; clipTypes[k] = b.type || 'audio/wav';
  }
  await writeFile(pd, PJSON, JSON.stringify({app: 'derizmp3', format: FORMAT, name: rec.name, savedAt: rec.savedAt, data: rec.data, clips, clipTypes}));
  const keep = new Set(Object.values(clips).map(p => p.slice(6)));
  try { for await (const [n] of cd.entries()) if (!keep.has(n)) await cd.removeEntry(n); } catch { /* sisa file lama: tidak masalah */ }
  return 'ok';
}

async function readProjectDir(pd: DirH): Promise<ProjectRecord | null> {
  let j: {app?: string; name?: string; savedAt?: number; data?: unknown; clips?: Record<string, string>; clipTypes?: Record<string, string>};
  try { j = JSON.parse((await (await pd.getFileHandle(PJSON)).getFile().then(f => f.text())).replace(/^\uFEFF/, '')); } catch { return null; }
  if (!j || j.app !== 'derizmp3' || !j.data) return null;
  const cd = await pd.getDirectoryHandle('clips').catch(() => null);
  const clips: Record<string, Blob> = {};
  for (const [k, p] of Object.entries(j.clips || {})) {
    if (!cd) throw new Error('folder clips hilang di "' + (j.name || pd.name) + '"');
    const f = await (await cd.getFileHandle(String(p).replace(/^clips\//, ''))).getFile();
    clips[k] = new Blob([f], {type: (j.clipTypes && j.clipTypes[k]) || 'audio/wav'});
  }
  return {name: String(j.name || pd.name), savedAt: Number(j.savedAt) || 0, data: j.data, clips};
}

// Daftar project di folder (hanya nama + waktu simpan; clip belum dibaca).
export async function listFolderProjects(ask = true): Promise<ProjectInfo[] | null> {
  const root = await appDir(ask, false).catch(() => null);
  if (!root) return null;
  const out: ProjectInfo[] = [];
  for await (const [n, e] of root.entries()) {
    if (e.kind !== 'directory') continue;
    try {
      const j = JSON.parse(await (await (e as DirH).getFileHandle(PJSON)).getFile().then(f => f.text()));
      if (j && j.app === 'derizmp3') out.push({name: String(j.name || n), savedAt: Number(j.savedAt) || 0});
    } catch { /* bukan folder project */ }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
export async function loadFromFolder(name: string): Promise<ProjectRecord | null> {
  const root = await appDir(false, false).catch(() => null);
  if (!root) return null;
  const pd = await root.getDirectoryHandle(safeName(name)).catch(() => null);
  return pd ? readProjectDir(pd) : null;
}
