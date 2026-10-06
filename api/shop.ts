// /api/shop : kepemilikan plugin berbayar (Manage Plugin).
//  GET                              -> { owned: ['mgchord', ...], pending: [...] } plugin berbayar yang dimiliki / sudah dipesan (menunggu token dari admin)
//  POST { action: 'buy', plugin }   -> pesan plugin: server membuat token OTOMATIS (source 'order', buyer_id = akun ini) dan menyimpannya terenkripsi.
//                                      Token TIDAK dikirim ke pembeli; muncul di dashboard admin, pembeli memintanya ke admin. -> { ok, pending, owned }
//  POST { action: 'redeem', token } -> tebus token plugin; sukses -> { ok, plugin, owned }
// Token hasil pesanan dikunci ke akun yang memesan (buyer_id): akun lain tidak bisa menebusnya. 1 token = 1 plugin = 1 akun.
// Token manual dari /admin ("Token plugin") tanpa buyer_id tetap bisa ditebus akun mana pun.
import { sameOrigin, userOf } from './_auth.js';
import { json } from './_issue.js';
import { hashToken, ownedPlugins, pendingPlugins, rest } from '../server/supabase.js';
import { newPluginToken, seal } from '../server/vault.js';
import { isPaidPlugin } from '../server/plugins.js';

export async function GET(req: Request): Promise<Response> {
  const uid = await userOf(req);
  if (!uid) return json({ error: 'Belum masuk.' }, 401);
  try { const [owned, pending] = await Promise.all([ownedPlugins(uid), pendingPlugins(uid)]); return json({ owned, pending }); }
  catch (e) { console.error(e); return json({ error: 'Gagal membaca data plugin.' }, 500); }
}

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return json({ error: 'Asal permintaan ditolak.' }, 403);
  const uid = await userOf(req);
  if (!uid) return json({ error: 'Belum masuk.' }, 401);
  let b: { action?: string; token?: string; plugin?: string };
  try { b = await req.json(); } catch { return json({ error: 'Permintaan tidak valid.' }, 400); }

  if (b.action === 'buy') {
    const plugin = String(b.plugin || '');
    if (!isPaidPlugin(plugin)) return json({ error: 'Plugin tidak dikenal.' }, 400);
    try {
      const owned = await ownedPlugins(uid);
      if (owned.includes(plugin)) return json({ error: 'Akun ini sudah memiliki plugin tersebut.' }, 409);
      let pending = await pendingPlugins(uid);
      if (!pending.includes(plugin)) {   // belum ada pesanan: buat token otomatis, kunci ke akun ini
        const token = newPluginToken(), th = await hashToken(token);
        try {
          await rest('plugin_licenses', { method: 'POST', body: { token_hash: th, token_enc: await seal(token, th), plugin, source: 'order', buyer_id: uid, note: 'Pesanan dari Manage Plugin' } });
        } catch (e) {   // dua tekanan Beli bersamaan: indeks unik menolak yang kedua; kalau pesanan sudah ada anggap sukses
          pending = await pendingPlugins(uid);
          if (!pending.includes(plugin)) throw e;
        }
        pending = await pendingPlugins(uid);
      }
      return json({ ok: true, pending, owned });
    } catch (e) { console.error(e); return json({ error: 'Terjadi kesalahan di server. Coba lagi sebentar.' }, 500); }
  }
  if (b.action !== 'redeem') return json({ error: 'Aksi tidak dikenal.' }, 400);

  const raw = String(b.token || '');
  const BAD = async (): Promise<Response> => { await new Promise((r) => setTimeout(r, 600)); return json({ error: 'Token tidak valid atau sudah dipakai.' }, 400); };   // satu pesan untuk semua kegagalan; jeda memperlambat tebak-tebakan
  if (raw.replace(/[^A-Za-z0-9]/g, '').length < 12 || raw.length > 64) return BAD();

  try {
    const th = await hashToken(raw);
    const found = (await rest<{ plugin: string; user_id: string | null; buyer_id: string | null; status: string }[]>(`plugin_licenses?token_hash=eq.${th}&select=plugin,user_id,buyer_id,status&limit=1`))[0];
    if (!found || found.user_id || found.status !== 'active' || !isPaidPlugin(found.plugin)) return BAD();

    // token hasil pesanan hanya milik akun yang memesan (pesan khusus aman: yang sampai di sini sudah tahu token lengkapnya)
    if (found.buyer_id && found.buyer_id !== uid) return json({ error: 'Token ini dikunci untuk akun lain dan tidak bisa dipakai di akun ini.' }, 403);

    const owned = await ownedPlugins(uid);
    if (owned.includes(found.plugin)) return json({ error: 'Akun ini sudah memiliki plugin tersebut. Token tidak dipakai.' }, 409);

    // klaim atomik: PATCH hanya kena baris yang masih kosong, jadi dua orang yang menebus token yang sama tidak mungkin sama-sama berhasil
    const claimed = await rest<{ plugin: string }[]>(`plugin_licenses?token_hash=eq.${th}&user_id=is.null&status=eq.active&or=(buyer_id.is.null,buyer_id.eq.${uid})`, {
      method: 'PATCH', returnRows: true, body: { user_id: uid, claimed_at: new Date().toISOString() },
    });
    if (!claimed.length) return BAD();
    return json({ ok: true, plugin: claimed[0].plugin, owned: await ownedPlugins(uid), pending: await pendingPlugins(uid) });
  } catch (e) { console.error(e); return json({ error: 'Terjadi kesalahan di server. Coba lagi sebentar.' }, 500); }
}
