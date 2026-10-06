// /api/avatar (pembeli yang sudah masuk). Foto disimpan di bucket privat Supabase 'avatars' (satu file per akun) dan hanya disajikan lewat sini.
//  GET              -> gambar (404 kalau belum ada)
//  POST  <bytes>    -> unggah (Content-Type image/jpeg|png|webp, maks 256 KB; browser sudah memperkecilnya jadi 256x256)
//  DELETE           -> hapus foto
import { sameOrigin, userOf } from './_auth.js';
import { avatarUrl } from './profile.js';
import { json } from './_issue.js';
import { avatarDelete, avatarGet, avatarPut, rest } from '../server/supabase.js';

const MAX = 256 * 1024;
// Jenis file ditentukan dari isinya (magic bytes), bukan dari header yang dikirim klien.
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const uid = await userOf(req);
  if (!uid) return new Response('Unauthorized', { status: 401 });
  try {
    const r = await avatarGet(uid);
    if (!r) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const versioned = new URL(req.url).searchParams.has('v');   // alamat ber-versi berubah tiap ganti foto, jadi aman di-cache lama
    return new Response(r.body, { headers: { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': versioned ? 'private, max-age=31536000, immutable' : 'private, max-age=300' } });
  } catch (e) { console.error(e); return new Response('Error', { status: 500 }); }
}

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return json({ error: 'Permintaan tidak valid.' }, 400);
  const uid = await userOf(req);
  if (!uid) return json({ error: 'Belum masuk.' }, 401);
  try {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length < 100 || bytes.length > MAX) return json({ error: 'Ukuran foto harus di bawah 256 KB.' }, 413);
    const type = sniff(bytes);
    if (!type) return json({ error: 'Format foto harus JPG, PNG, atau WebP.' }, 415);
    await avatarPut(uid, bytes, type);
    const now = new Date().toISOString();
    await rest('profiles?on_conflict=user_id', { method: 'POST', upsert: true, body: { user_id: uid, avatar_updated_at: now, updated_at: now } });
    return json({ ok: true, avatar: avatarUrl(now) });
  } catch (e) { console.error(e); return json({ error: 'Gagal mengunggah foto.' }, 500); }
}

export async function DELETE(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return json({ error: 'Permintaan tidak valid.' }, 400);
  const uid = await userOf(req);
  if (!uid) return json({ error: 'Belum masuk.' }, 401);
  try {
    await avatarDelete(uid);
    await rest('profiles?on_conflict=user_id', { method: 'POST', upsert: true, body: { user_id: uid, avatar_updated_at: null, updated_at: new Date().toISOString() } });
    return json({ ok: true });
  } catch (e) { console.error(e); return json({ error: 'Gagal menghapus foto.' }, 500); }
}
