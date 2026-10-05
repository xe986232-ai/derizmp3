// Uji alur akun dengan Supabase TIRUAN (di memori). Jalankan: npx tsx tools/license-flow-test.ts
process.env.SUPABASE_URL = 'http://sb.test'; process.env.SUPABASE_SERVICE_KEY = 'svc'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SESSION_SECRET = 'sec-xyz';
import { hashToken } from '../server/supabase';

type L = { token_hash: string; status: string; user_id: string | null; email: string | null; max_devices: number; duration_days: number | null; expires_at: string | null; claimed_at?: string };
const licenses: L[] = []; const devices: { token_hash: string; device_id: string; last_seen?: string }[] = []; const users = new Map<string, { id: string; pw: string }>();
const real = globalThis.fetch;
const J = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(String(input)); const body = init.body ? JSON.parse(init.body) : undefined; const m = init.method || 'GET';
  if (u.pathname === '/auth/v1/admin/users' && m === 'POST') { if (users.has(body.email)) return J({}, 422); const id = 'uid-' + (users.size + 1); users.set(body.email, { id, pw: body.password }); return J({ id }); }
  if (u.pathname.startsWith('/auth/v1/admin/users/') && m === 'DELETE') { const id = u.pathname.split('/').pop(); for (const [e, v] of users) if (v.id === id) users.delete(e); return J({}); }
  if (u.pathname === '/auth/v1/token') { const x = users.get(body.email); return x && x.pw === body.password ? J({ user: { id: x.id } }) : J({}, 400); }
  const p = u.pathname.replace('/rest/v1/', ''); const q = (k: string) => u.searchParams.get(k)?.replace(/^(eq|is)\./, '');
  if (p === 'licenses') {
    let rows = licenses.filter((r) => (!q('token_hash') || r.token_hash === q('token_hash')) && (!q('user_id') || (q('user_id') === 'null' ? r.user_id === null : r.user_id === q('user_id'))) && (!q('status') || r.status === q('status')));
    if (m === 'PATCH') { rows.forEach((r) => Object.assign(r, body)); return J(rows); }
    return J(rows);
  }
  if (p === 'devices') {
    if (m === 'POST') { devices.push(body); return new Response(null, { status: 201 }); }
    const rows = devices.filter((r) => r.token_hash === q('token_hash') && (!q('device_id') || r.device_id === q('device_id')));
    if (m === 'PATCH') { rows.forEach((r) => Object.assign(r, body)); return new Response(null, { status: 204 }); }
    return J(rows);
  }
  return real(input, init);
}) as typeof fetch;

const { POST } = await import('../api/session'); const { GET: me } = await import('../api/me');
let fail = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const TOKEN = 'MLVX-ABCD-EFGH-JKLM-NPQR', TOKEN2 = 'MLVX-2222-3333-4444-5555';
licenses.push({ token_hash: await hashToken(TOKEN), status: 'active', user_id: null, email: null, max_devices: 2, duration_days: 30, expires_at: null });
licenses.push({ token_hash: await hashToken(TOKEN2), status: 'active', user_id: null, email: null, max_devices: 2, duration_days: null, expires_at: null });

const call = (b: object, cookie = '') => POST(new Request('https://x.test/api/session', { method: 'POST', headers: { cookie }, body: JSON.stringify(b) }));
const cookiesOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const meCall = (c: string) => me(new Request('https://x.test/api/me', { headers: { cookie: c } }));

let r = await call({ action: 'redeem', email: 'a@x.id', password: 'password1', token: 'MLVX-0000-0000-0000-0000' });
ok('token ngawur ditolak', r.status === 400);
// dua orang balapan memakai token yang sama
const [r1, r2] = await Promise.all([call({ action: 'redeem', email: 'a@x.id', password: 'password1', token: TOKEN }), call({ action: 'redeem', email: 'b@x.id', password: 'password2', token: TOKEN.toLowerCase() })]);
ok('tepat satu dari dua pemakai token berhasil', [r1, r2].filter((x) => x.status === 200).length === 1);
ok('akun yang kalah dibatalkan (tidak ada akun yatim)', users.size === 1);
const winner = r1.status === 200 ? r1 : r2; const email = r1.status === 200 ? 'a@x.id' : 'b@x.id', pw = r1.status === 200 ? 'password1' : 'password2';
ok('token terkunci ke akun + masa berlaku diisi', licenses[0].user_id !== null && !!licenses[0].expires_at);
ok('cookie sesi diterbitkan', cookiesOf(winner).includes('mx_s=') && cookiesOf(winner).includes('mx_d='));
ok('token yang sama tidak bisa dipakai akun kedua', (await call({ action: 'redeem', email: 'c@x.id', password: 'password3', token: TOKEN })).status === 400);
ok('/api/me sesi sah = 200', (await meCall(cookiesOf(winner))).status === 200);

ok('login password salah = 401', (await call({ action: 'login', email, password: 'salahsalah' })).status === 401);
const dev1 = cookiesOf(winner);   // perangkat 1 (dari aktivasi)
const dev2 = cookiesOf(await call({ action: 'login', email, password: pw }));   // perangkat 2 (tanpa cookie mx_d -> perangkat baru)
ok('perangkat ke-2 boleh', dev2.includes('mx_s='));
const r3 = await call({ action: 'login', email, password: pw });
ok('perangkat ke-3 ditolak (batas 2)', r3.status === 403);
ok('perangkat lama login lagi tetap boleh', (await call({ action: 'login', email, password: pw }, dev1)).status === 200);

devices.length = 0;   // admin reset-devices
ok('setelah reset, sesi lama kena 401 (perangkat dihapus)', (await meCall(dev1)).status === 401);
licenses[0].status = 'revoked';
ok('dicabut: /api/me = 401', (await meCall(dev2)).status === 401);
ok('dicabut: login ditolak 403', (await call({ action: 'login', email, password: pw })).status === 403);
licenses[0].status = 'active'; licenses[0].expires_at = new Date(Date.now() - 1000).toISOString();
ok('kedaluwarsa: login ditolak 403', (await call({ action: 'login', email, password: pw })).status === 403);
ok('password pendek ditolak', (await call({ action: 'login', email, password: '123' })).status === 400);
process.exit(fail ? 1 : 0);
