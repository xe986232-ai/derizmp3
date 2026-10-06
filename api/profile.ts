// /api/profile (pembeli yang sudah masuk)
//  GET                    -> { email, name, avatar }   (avatar = alamat foto ber-versi, atau null)
//  POST { name }          -> simpan nama tampilan (kosong = hapus)
// Foto diurus /api/avatar.
import { cleanName, sameOrigin, userOf } from './_auth.js';
import { json } from './_issue.js';
import { rest } from '../server/supabase.js';

type Prof = { display_name: string | null; avatar_updated_at: string | null };
export const avatarUrl = (t: string | null): string | null => (t ? '/api/avatar?v=' + Date.parse(t) : null);

export async function GET(req: Request): Promise<Response> {
  const uid = await userOf(req);
  if (!uid) return json({ error: 'Belum masuk.' }, 401);
  try {
    const [p, l] = await Promise.all([
      rest<Prof[]>(`profiles?user_id=eq.${uid}&select=display_name,avatar_updated_at&limit=1`),
      rest<{ email: string | null }[]>(`licenses?user_id=eq.${uid}&select=email&limit=1`),
    ]);
    return json({ email: l[0]?.email || '', name: p[0]?.display_name ?? null, avatar: avatarUrl(p[0]?.avatar_updated_at ?? null) });
  } catch (e) { console.error(e); return json({ error: 'Gagal memuat profil.' }, 500); }
}

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req) || !(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Permintaan tidak valid.' }, 400);
  const uid = await userOf(req);
  if (!uid) return json({ error: 'Belum masuk.' }, 401);
  let b: { name?: unknown };
  try { b = await req.json(); } catch { return json({ error: 'Permintaan tidak valid.' }, 400); }
  try {
    const name = cleanName(b.name);
    await rest('profiles?on_conflict=user_id', { method: 'POST', upsert: true, body: { user_id: uid, display_name: name, updated_at: new Date().toISOString() } });
    return json({ ok: true, name });
  } catch (e) { console.error(e); return json({ error: 'Gagal menyimpan nama.' }, 500); }
}
