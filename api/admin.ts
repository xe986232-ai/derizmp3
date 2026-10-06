// /api/admin : API dashboard admin lisensi (dipakai /admin). Dijaga password admin (env ADMIN_PASSWORD) + cookie sesi sendiri (mx_a).
//  GET                                     daftar lisensi + perangkat
//  POST { action: 'login', password }      masuk admin
//  POST { action: 'logout' }               keluar
//  POST { action: 'create', count, devices, days, note }       buat token (token asli hanya dikirim SEKALI di respons ini)
//  POST { action: 'revoke' | 'restore' | 'reset_devices' | 'delete', id }
//  POST { action: 'update', id, note?, max_devices?, extend_days?, duration_days? }
//  POST { action: 'p_create', plugin, count, note }            buat token PLUGIN (Shop Plugin), token asli hanya dikirim sekali
//  POST { action: 'p_reveal' | 'p_revoke' | 'p_restore' | 'p_delete', id }   kelola token plugin (p_delete hanya yang belum ditebus)
//  POST { action: 'p_update', id, note }                        ubah catatan token plugin
// Token plugin juga dibuat OTOMATIS saat pembeli menekan Beli di Shop Plugin (/api/shop 'buy', source 'order', buyer_id terisi):
// muncul di daftar token plugin dengan nama akun pembeli; admin menyerahkan tokennya (ikon mata/salin) dan hanya akun itu yang bisa menebus.
//  POST { action: 'reveal', id }           buka token asli satu lisensi (untuk ikon mata / tombol salin di dashboard)
// id = token_hash. Token asli disimpan TERENKRIPSI (AES-GCM, kunci turunan SESSION_SECRET) di kolom token_enc, tidak pernah ikut
// dalam daftar GET; hanya aksi 'reveal' (wajib sesi admin) yang membukanya. Token yang dibuat sebelum fitur ini hanya punya hash.
import { clearCookie, getCookie, setCookie, signSession, verifySession } from '../server/session.js';
import { rest, sha256hex } from '../server/supabase.js';
import { PAID_PLUGINS, isPaidPlugin } from '../server/plugins.js';
import { json } from './_issue.js';
import { ALPHA, newPluginToken, seal, unseal } from '../server/vault.js';

const ACOOKIE = 'mx_a', ASEC = 8 * 3600;   // sesi admin 8 jam
const ID = /^[0-9a-f]{64}$/;
const newToken = (): string => {
  const c = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => ALPHA[x & 31]);   // 32 huruf => x & 31 tanpa bias; 16 x 5 bit = 80 bit
  return 'MLVX-' + [0, 1, 2, 3].map((i) => c.slice(i * 4, i * 4 + 4).join('')).join('-');
};

type Row = { token_hash: string; token_enc?: string | null; status: string; user_id: string | null; email: string | null; max_devices: number; duration_days: number | null; expires_at: string | null; note: string | null; created_at: string; claimed_at: string | null; devices?: { device_id: string; last_seen: string; created_at: string }[] };

type PRow = { token_hash: string; token_enc: string | null; plugin: string; status: string; source: string; user_id: string | null; buyer_id: string | null; note: string | null; created_at: string; claimed_at: string | null };
const secretOf = (): string => process.env.SESSION_SECRET + ':admin';   // beda dari rahasia sesi pembeli, jadi cookie pembeli tidak pernah sah sebagai admin
const ready = (): boolean => !!process.env.ADMIN_PASSWORD && !!process.env.SESSION_SECRET;
const isAdmin = async (req: Request): Promise<boolean> => (await verifySession(getCookie(req, ACOOKIE), secretOf()))?.uid === 'admin';

async function samePassword(a: string, b: string): Promise<boolean> {   // pembandingan waktu-konstan lewat hash
  const [x, y] = await Promise.all([sha256hex(a), sha256hex(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

const int = (v: unknown, min: number, max: number): number | null => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const clean = (v: unknown): string | null => { const s = String(v ?? '').trim().slice(0, 200); return s || null; };

export async function GET(req: Request): Promise<Response> {
  if (!ready()) return json({ error: 'ADMIN_PASSWORD / SESSION_SECRET belum diisi di server.' }, 503);
  if (!(await isAdmin(req))) return json({ error: 'Belum masuk.' }, 401);
  try {
    const rows = await rest<Row[]>('licenses?select=token_hash,token_enc,status,user_id,email,max_devices,duration_days,expires_at,note,created_at,claimed_at,devices(device_id,last_seen,created_at)&order=created_at.desc&limit=2000');
    const pl = await rest<PRow[]>('plugin_licenses?select=token_hash,token_enc,plugin,status,source,user_id,buyer_id,note,created_at,claimed_at&order=created_at.desc&limit=2000');
    const uids = [...new Set(pl.flatMap((r) => [r.user_id, r.buyer_id]).filter((x): x is string => !!x))];
    const mails = uids.length ? await rest<{ user_id: string; email: string | null }[]>(`licenses?user_id=in.(${uids.join(',')})&select=user_id,email`) : [];
    const mailOf = new Map(mails.map((m) => [m.user_id, m.email]));
    const plugins = pl.map((r) => ({ token_hash: r.token_hash, plugin: r.plugin, status: r.status, source: r.source, note: r.note, created_at: r.created_at, claimed_at: r.claimed_at, claimed: !!r.user_id, email: r.user_id ? mailOf.get(r.user_id) ?? null : null, buyer_email: r.buyer_id ? mailOf.get(r.buyer_id) ?? '(akun dihapus)' : null, has_token: !!r.token_enc }));
    return json({ plugin_ids: PAID_PLUGINS, plugins, licenses: rows.map((r) => ({ ...r, token_enc: undefined, has_token: !!r.token_enc, user_id: undefined, claimed: !!r.user_id, devices: (r.devices || []).map((d) => ({ id: d.device_id.slice(0, 8), last_seen: d.last_seen })) })) });
  } catch (e) { console.error(e); return json({ error: 'Gagal membaca database.' }, 500); }
}

export async function POST(req: Request): Promise<Response> {
  if (!ready()) return json({ error: 'ADMIN_PASSWORD / SESSION_SECRET belum diisi di server.' }, 503);
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(req.url).host) return json({ error: 'Asal permintaan ditolak.' }, 403);   // lapis tambahan di atas SameSite=Lax
  if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Permintaan tidak valid.' }, 400);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: 'Permintaan tidak valid.' }, 400); }

  if (b.action === 'login') {
    if (await samePassword(String(b.password || ''), process.env.ADMIN_PASSWORD!)) {
      const s = await signSession({ uid: 'admin', did: 'admin', exp: Math.floor(Date.now() / 1000) + ASEC }, secretOf());
      return json({ ok: true }, 200, [setCookie(ACOOKIE, s, ASEC)]);
    }
    await new Promise((r) => setTimeout(r, 800));   // memperlambat tebak-tebakan password
    return json({ error: 'Password salah.' }, 401);
  }
  if (b.action === 'logout') return json({ ok: true }, 200, [clearCookie(ACOOKIE)]);
  if (!(await isAdmin(req))) return json({ error: 'Belum masuk.' }, 401);

  try {
    if (b.action === 'create') {
      const count = int(b.count, 1, 500), devices = int(b.devices, 1, 20);
      const days = b.days === null || b.days === '' || b.days === undefined ? null : int(b.days, 1, 3650);
      if (count === null || devices === null || (b.days !== null && b.days !== '' && b.days !== undefined && days === null)) return json({ error: 'Jumlah (1-500), perangkat (1-20), atau hari (1-3650) tidak valid.' }, 400);
      const note = clean(b.note);
      const tokens = Array.from({ length: count }, newToken);
      const hashes = await Promise.all(tokens.map((t) => sha256hex(t.replace(/[^A-Z0-9]/g, ''))));   // sama dengan hashToken (normalisasi huruf besar tanpa tanda hubung)
      const encs = await Promise.all(tokens.map((t, i) => seal(t, hashes[i])));
      await rest('licenses', { method: 'POST', body: hashes.map((h, i) => ({ token_hash: h, token_enc: encs[i], max_devices: devices, duration_days: days, note })) });
      return json({ ok: true, tokens });
    }

    if (b.action === 'p_create') {
      const plugin = String(b.plugin || ''), count = int(b.count, 1, 500);
      if (!isPaidPlugin(plugin)) return json({ error: 'Plugin tidak dikenal.' }, 400);
      if (count === null) return json({ error: 'Jumlah harus 1-500.' }, 400);
      const note = clean(b.note);
      const tokens = Array.from({ length: count }, newPluginToken);
      const hashes = await Promise.all(tokens.map((t) => sha256hex(t.replace(/[^A-Z0-9]/g, ''))));
      const encs = await Promise.all(tokens.map((t, i) => seal(t, hashes[i])));
      await rest('plugin_licenses', { method: 'POST', body: hashes.map((h, i) => ({ token_hash: h, token_enc: encs[i], plugin, note })) });
      return json({ ok: true, tokens });
    }

    const id = String(b.id || '');
    if (!ID.test(id)) return json({ error: 'ID lisensi tidak valid.' }, 400);
    const q = `token_hash=eq.${id}`;

    if (b.action === 'p_reveal') {
      const cur = (await rest<PRow[]>(`plugin_licenses?${q}&select=token_hash,token_enc&limit=1`))[0];
      if (!cur) return json({ error: 'Token plugin tidak ditemukan.' }, 404);
      if (!cur.token_enc) return json({ error: 'Token ini tidak punya salinan terenkripsi.' }, 404);
      const token = await unseal(cur.token_enc, cur.token_hash);
      return token ? json({ ok: true, token }) : json({ error: 'Token tidak bisa dibuka. Kemungkinan SESSION_SECRET di server pernah diganti.' }, 500);
    }
    if (b.action === 'p_update') {
      if (!('note' in b)) return json({ error: 'Tidak ada yang diubah.' }, 400);
      const r = await rest<unknown[]>('plugin_licenses?' + q, { method: 'PATCH', returnRows: true, body: { note: clean(b.note) } });
      return r.length ? json({ ok: true }) : json({ error: 'Token plugin tidak ditemukan.' }, 404);
    }
    if (b.action === 'p_revoke' || b.action === 'p_restore') {
      try {
        const r = await rest<unknown[]>('plugin_licenses?' + q, { method: 'PATCH', returnRows: true, body: { status: b.action === 'p_revoke' ? 'revoked' : 'active' } });
        return r.length ? json({ ok: true }) : json({ error: 'Token plugin tidak ditemukan.' }, 404);
      } catch (e) { console.error(e); return json({ error: 'Gagal mengaktifkan. Kemungkinan akun itu sudah punya plugin ini atau sudah ada pesanan aktif lain untuk plugin yang sama.' }, 409); }
    }
    if (b.action === 'p_delete') {   // hanya yang belum ditebus; yang sudah dipakai cukup dicabut
      const r = await rest<unknown[]>(`plugin_licenses?${q}&user_id=is.null`, { method: 'DELETE', returnRows: true });
      return r.length ? json({ ok: true }) : json({ error: 'Hanya token yang belum ditebus yang bisa dihapus. Untuk yang sudah dipakai, gunakan Cabut.' }, 409);
    }

    if (b.action === 'reveal') {
      const cur = (await rest<Row[]>(`licenses?${q}&select=token_hash,token_enc&limit=1`))[0];
      if (!cur) return json({ error: 'Lisensi tidak ditemukan.' }, 404);
      if (!cur.token_enc) return json({ error: 'Token ini dibuat sebelum penyimpanan token ada, jadi hanya hash-nya yang tersimpan.' }, 404);
      const token = await unseal(cur.token_enc, cur.token_hash);
      if (!token) return json({ error: 'Token tidak bisa dibuka. Kemungkinan SESSION_SECRET di server pernah diganti.' }, 500);
      return json({ ok: true, token });
    }

    if (b.action === 'revoke' || b.action === 'restore') {
      const r = await rest<unknown[]>('licenses?' + q, { method: 'PATCH', returnRows: true, body: { status: b.action === 'revoke' ? 'revoked' : 'active' } });
      return r.length ? json({ ok: true }) : json({ error: 'Lisensi tidak ditemukan.' }, 404);
    }
    if (b.action === 'reset_devices') {
      await rest('devices?' + q, { method: 'DELETE' });
      return json({ ok: true });
    }
    if (b.action === 'delete') {   // hanya token yang belum dipakai; yang sudah punya akun cukup dicabut (revoke)
      const r = await rest<unknown[]>(`licenses?${q}&user_id=is.null`, { method: 'DELETE', returnRows: true });
      return r.length ? json({ ok: true }) : json({ error: 'Hanya token yang belum diaktifkan yang bisa dihapus. Untuk yang sudah dipakai, gunakan Cabut.' }, 409);
    }
    if (b.action === 'update') {
      const cur = (await rest<Row[]>(`licenses?${q}&select=token_hash,user_id,expires_at,duration_days&limit=1`))[0];
      if (!cur) return json({ error: 'Lisensi tidak ditemukan.' }, 404);
      const patch: Record<string, unknown> = {};
      if ('note' in b) patch.note = clean(b.note);
      if ('max_devices' in b) { const n = int(b.max_devices, 1, 20); if (n === null) return json({ error: 'Perangkat harus 1-20.' }, 400); patch.max_devices = n; }
      if ('extend_days' in b) {
        const n = int(b.extend_days, 1, 3650);
        if (n === null) return json({ error: 'Perpanjangan harus 1-3650 hari.' }, 400);
        if (!cur.expires_at) return json({ error: 'Lisensi ini seumur hidup atau belum diaktifkan, tidak ada tanggal berakhir untuk diperpanjang.' }, 409);
        patch.expires_at = new Date(Math.max(Date.now(), new Date(cur.expires_at).getTime()) + n * 864e5).toISOString();   // dihitung dari tanggal berakhir (atau sekarang kalau sudah lewat)
      }
      if ('duration_days' in b) {
        if (cur.user_id) return json({ error: 'Masa berlaku hanya bisa diubah sebelum token diaktifkan. Pakai Perpanjang untuk yang sudah aktif.' }, 409);
        const n = b.duration_days === null || b.duration_days === '' ? null : int(b.duration_days, 1, 3650);
        if (b.duration_days !== null && b.duration_days !== '' && n === null) return json({ error: 'Hari harus 1-3650.' }, 400);
        patch.duration_days = n;
      }
      if (!Object.keys(patch).length) return json({ error: 'Tidak ada yang diubah.' }, 400);
      await rest('licenses?' + q, { method: 'PATCH', body: patch });
      return json({ ok: true });
    }
    return json({ error: 'Aksi tidak dikenal.' }, 400);
  } catch (e) { console.error(e); return json({ error: 'Terjadi kesalahan di server.' }, 500); }
}
