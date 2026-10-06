// /api/shop : kepemilikan plugin berbayar (Shop Plugin).
//  GET                              -> { owned: ['mgchord', ...] } plugin berbayar yang dimiliki akun ini
//  POST { action: 'redeem', token } -> tebus token plugin; sukses -> { ok, plugin, owned }
// Token plugin dibuat admin lewat /admin ("Token plugin"). 1 token = 1 plugin = 1 akun.
import { sameOrigin, userOf } from './_auth.js';
import { json } from './_issue.js';
import { hashToken, ownedPlugins, rest } from '../server/supabase.js';
import { isPaidPlugin } from '../server/plugins.js';

export async function GET(req: Request): Promise<Response> {
  const uid = await userOf(req);
  if (!uid) return json({ error: 'Belum masuk.' }, 401);
  try { return json({ owned: await ownedPlugins(uid) }); }
  catch (e) { console.error(e); return json({ error: 'Gagal membaca data plugin.' }, 500); }
}

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return json({ error: 'Asal permintaan ditolak.' }, 403);
  const uid = await userOf(req);
  if (!uid) return json({ error: 'Belum masuk.' }, 401);
  let b: { action?: string; token?: string };
  try { b = await req.json(); } catch { return json({ error: 'Permintaan tidak valid.' }, 400); }
  if (b.action !== 'redeem') return json({ error: 'Aksi tidak dikenal.' }, 400);

  const raw = String(b.token || '');
  const BAD = async (): Promise<Response> => { await new Promise((r) => setTimeout(r, 600)); return json({ error: 'Token tidak valid atau sudah dipakai.' }, 400); };   // satu pesan untuk semua kegagalan; jeda memperlambat tebak-tebakan
  if (raw.replace(/[^A-Za-z0-9]/g, '').length < 12 || raw.length > 64) return BAD();

  try {
    const th = await hashToken(raw);
    const found = (await rest<{ plugin: string; user_id: string | null; status: string }[]>(`plugin_licenses?token_hash=eq.${th}&select=plugin,user_id,status&limit=1`))[0];
    if (!found || found.user_id || found.status !== 'active' || !isPaidPlugin(found.plugin)) return BAD();

    const owned = await ownedPlugins(uid);
    if (owned.includes(found.plugin)) return json({ error: 'Akun ini sudah memiliki plugin tersebut. Token tidak dipakai.' }, 409);

    // klaim atomik: PATCH hanya kena baris yang masih kosong, jadi dua orang yang menebus token yang sama tidak mungkin sama-sama berhasil
    const claimed = await rest<{ plugin: string }[]>(`plugin_licenses?token_hash=eq.${th}&user_id=is.null&status=eq.active`, {
      method: 'PATCH', returnRows: true, body: { user_id: uid, claimed_at: new Date().toISOString() },
    });
    if (!claimed.length) return BAD();
    return json({ ok: true, plugin: claimed[0].plugin, owned: await ownedPlugins(uid) });
  } catch (e) { console.error(e); return json({ error: 'Terjadi kesalahan di server. Coba lagi sebentar.' }, 500); }
}
