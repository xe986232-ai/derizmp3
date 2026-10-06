// Uji profil + foto dengan Supabase TIRUAN (REST + Auth + Storage di memori). Jalankan: npx tsx tools/profile-test.ts
process.env.SUPABASE_URL = 'http://sb.test'; process.env.SUPABASE_SERVICE_KEY = 'svc'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SESSION_SECRET = 'sec-xyz';
import { signSession } from '../server/session';
import { hashToken } from '../server/supabase';

type L = { token_hash: string; status: string; user_id: string | null; email: string | null; max_devices: number; duration_days: number | null; expires_at: string | null; claimed_at?: string };
const licenses: L[] = []; const devices: any[] = []; const profiles = new Map<string, any>(); const files = new Map<string, { bytes: Uint8Array; type: string }>(); const users = new Map<string, string>();
const real = globalThis.fetch; const J = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(String(input)); const m = init.method || 'GET'; const h = init.headers || {};
  if (u.pathname.startsWith('/storage/v1/object/avatars/')) {
    const k = u.pathname.split('/').pop()!;
    if (h.Authorization !== 'Bearer svc') return J({}, 401);
    if (m === 'POST') { files.set(k, { bytes: new Uint8Array(init.body), type: h['Content-Type'] }); return J({ Key: k }); }
    if (m === 'DELETE') { files.delete(k); return J({}); }
    const f = files.get(k); return f ? new Response(f.bytes, { headers: { 'content-type': f.type } }) : J({ error: 'not found' }, 400);
  }
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  if (u.pathname === '/auth/v1/admin/users' && m === 'POST') { const id = 'uid-' + (users.size + 1); users.set(body.email, id); return J({ id }); }
  const p = u.pathname.replace('/rest/v1/', ''); const q = (k: string) => u.searchParams.get(k)?.replace(/^(eq|is)\./, '');
  if (p === 'licenses') {
    const rows = licenses.filter((r) => (!q('token_hash') || r.token_hash === q('token_hash')) && (!q('user_id') || (q('user_id') === 'null' ? r.user_id === null : r.user_id === q('user_id'))) && (!q('status') || r.status === q('status')));
    if (m === 'PATCH') { rows.forEach((r) => Object.assign(r, body)); return J(rows); }
    return J(rows);
  }
  if (p === 'devices') { if (m === 'POST') { devices.push(body); return new Response(null, { status: 201 }); } return J(devices.filter((r) => r.token_hash === q('token_hash'))); }
  if (p.startsWith('profiles')) {
    if (m === 'POST') { if (!String(h.Prefer).includes('merge-duplicates')) return J({}, 409); profiles.set(body.user_id, { ...(profiles.get(body.user_id) || {}), ...body }); return new Response(null, { status: 201 }); }
    const r = profiles.get(q('user_id')!); return J(r ? [r] : []);
  }
  return real(input, init);
}) as typeof fetch;

const prof = await import('../api/profile'); const av = await import('../api/avatar'); const sess = await import('../api/session');
let fail = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const cookie = async (uid: string) => 'mx_s=' + encodeURIComponent(await signSession({ uid, did: 'd1', exp: Math.floor(Date.now() / 1000) + 3600 }, 'sec-xyz'));
const url = (p: string) => 'https://x.test' + p;
const req = (p: string, method: string, c: string, body?: any, type = 'application/json', extra: Record<string, string> = {}) => new Request(url(p), { method, headers: { cookie: c, ...(body !== undefined ? { 'content-type': type } : {}), ...extra }, body: body === undefined ? undefined : (type === 'application/json' ? JSON.stringify(body) : body) });

licenses.push({ token_hash: 'h1', status: 'active', user_id: 'u1', email: 'budi@x.id', max_devices: 2, duration_days: null, expires_at: null });
licenses.push({ token_hash: 'h2', status: 'revoked', user_id: 'u2', email: 'cabut@x.id', max_devices: 2, duration_days: null, expires_at: null });
const C = await cookie('u1');
const jpeg = (n: number) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); for (let i = 4; i < n; i++) b[i] = i % 251; return b; };
const png = (n: number) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47]); return b; };

ok('tanpa sesi: profil 401', (await prof.GET(req('/api/profile', 'GET', ''))).status === 401);
ok('tanpa sesi: foto GET 401', (await av.GET(req('/api/avatar', 'GET', ''))).status === 401);
ok('tanpa sesi: foto POST 401', (await av.POST(req('/api/avatar', 'POST', '', jpeg(500), 'image/jpeg'))).status === 401);
ok('sesi dengan lisensi dicabut ditolak', (await prof.GET(req('/api/profile', 'GET', await cookie('u2')))).status === 401);
let g = await (await prof.GET(req('/api/profile', 'GET', C))).json() as any;
ok('profil awal: email dari lisensi, nama & foto kosong', g.email === 'budi@x.id' && g.name === null && g.avatar === null);

let r = await prof.POST(req('/api/profile', 'POST', C, { name: '  Budi \n  Santoso\t ' }));
ok('simpan nama (dirapikan)', r.status === 200 && (await r.json() as any).name === 'Budi Santoso');
g = await (await prof.GET(req('/api/profile', 'GET', C))).json() as any;
ok('nama terbaca lagi', g.name === 'Budi Santoso');
await prof.POST(req('/api/profile', 'POST', C, { name: 'x'.repeat(100) }));
ok('nama dipotong 40 karakter', profiles.get('u1').display_name.length === 40);
await prof.POST(req('/api/profile', 'POST', C, { name: '   ' }));
ok('nama kosong = null', profiles.get('u1').display_name === null);
await prof.POST(req('/api/profile', 'POST', C, { name: 'Budi' }));
ok('Origin lain ditolak', (await prof.POST(req('/api/profile', 'POST', C, { name: 'Hack' }, 'application/json', { origin: 'https://evil.test' }))).status === 400 && profiles.get('u1').display_name === 'Budi');

ok('foto belum ada: GET 404', (await av.GET(req('/api/avatar', 'GET', C))).status === 404);
ok('foto terlalu kecil ditolak 413', (await av.POST(req('/api/avatar', 'POST', C, jpeg(20), 'image/jpeg'))).status === 413);
ok('foto > 256 KB ditolak 413', (await av.POST(req('/api/avatar', 'POST', C, jpeg(300 * 1024), 'image/jpeg'))).status === 413);
ok('bukan gambar ditolak 415 (walau header bilang jpeg)', (await av.POST(req('/api/avatar', 'POST', C, new TextEncoder().encode('<html><script>alert(1)</script></html>'.padEnd(200, ' ')), 'image/jpeg'))).status === 415);
ok('Origin lain ditolak (foto)', (await av.POST(req('/api/avatar', 'POST', C, jpeg(500), 'image/jpeg', { origin: 'https://evil.test' }))).status === 400);
const J1 = jpeg(5000);
r = await av.POST(req('/api/avatar', 'POST', C, J1, 'image/jpeg'));
ok('unggah JPEG 200 + alamat ber-versi', r.status === 200 && /^\/api\/avatar\?v=\d+$/.test((await r.json() as any).avatar));
ok('file masuk storage dengan nama = id akun', files.get('u1')?.type === 'image/jpeg' && files.get('u1')!.bytes.length === 5000);
ok('nama tidak hilang setelah unggah foto', profiles.get('u1').display_name === 'Budi');
g = await (await prof.GET(req('/api/profile', 'GET', C))).json() as any;
const gr = await av.GET(req(g.avatar, 'GET', C));
ok('GET foto = byte yang sama, immutable karena ber-versi', gr.status === 200 && gr.headers.get('content-type') === 'image/jpeg' && gr.headers.get('cache-control')!.includes('immutable') && (await gr.arrayBuffer()).byteLength === 5000);
ok('GET foto tanpa ?v= cache pendek', (await av.GET(req('/api/avatar', 'GET', C))).headers.get('cache-control')!.includes('max-age=300'));
await av.POST(req('/api/avatar', 'POST', C, png(3000), 'image/jpeg'));
ok('jenis ditentukan dari isi (PNG walau header jpeg)', files.get('u1')?.type === 'image/png');
ok('pengguna lain tidak bisa melihat foto ini', (await av.GET(req('/api/avatar', 'GET', await cookie('u3')))).status === 401);   // u3 tak punya lisensi
r = await av.DELETE(req('/api/avatar', 'DELETE', C));
g = await (await prof.GET(req('/api/profile', 'GET', C))).json() as any;
ok('hapus foto: file hilang, avatar null, nama tetap', r.status === 200 && !files.has('u1') && g.avatar === null && g.name === 'Budi');

// nama saat aktivasi token
const TOKEN = 'MLVX-ABCD-EFGH-JKLM-NPQR';
licenses.push({ token_hash: await hashToken(TOKEN), status: 'active', user_id: null, email: null, max_devices: 2, duration_days: null, expires_at: null });
r = await sess.POST(new Request(url('/api/session'), { method: 'POST', body: JSON.stringify({ action: 'redeem', email: 'siti@x.id', password: 'password1', token: TOKEN, name: '  Siti  ' }) }));
ok('aktivasi dengan nama: berhasil + profil tersimpan', r.status === 200 && profiles.get('uid-1')?.display_name === 'Siti');
const TOKEN2 = 'MLVX-2222-3333-4444-5555';
licenses.push({ token_hash: await hashToken(TOKEN2), status: 'active', user_id: null, email: null, max_devices: 2, duration_days: null, expires_at: null });
r = await sess.POST(new Request(url('/api/session'), { method: 'POST', body: JSON.stringify({ action: 'redeem', email: 'tono@x.id', password: 'password1', token: TOKEN2 }) }));
ok('aktivasi tanpa nama tetap berhasil', r.status === 200 && !profiles.has('uid-2'));
console.log(fail ? `\n${fail} GAGAL` : '\nSemua lulus'); process.exit(fail ? 1 : 0);
