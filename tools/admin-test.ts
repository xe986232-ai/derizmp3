// Uji API dashboard admin dengan Supabase TIRUAN (di memori). Jalankan: npx tsx tools/admin-test.ts
process.env.SUPABASE_URL = 'http://sb.test'; process.env.SUPABASE_SERVICE_KEY = 'svc'; process.env.SESSION_SECRET = 'sec-xyz'; process.env.ADMIN_PASSWORD = 'adm-pass-123';
import { hashToken } from '../server/supabase';

type L = { token_hash: string; status: string; user_id: string | null; email: string | null; max_devices: number; duration_days: number | null; expires_at: string | null; note: string | null; created_at: string; claimed_at: string | null };
const licenses: L[] = []; const plugs: any[] = []; let devices: { token_hash: string; device_id: string; last_seen: string; created_at: string }[] = [];
const real = globalThis.fetch; const J = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(String(input)); const body = init.body ? JSON.parse(init.body) : undefined; const m = init.method || 'GET';
  const p = u.pathname.replace('/rest/v1/', ''); const q = (k: string) => u.searchParams.get(k)?.replace(/^(eq|is)\./, '');
  const ret = (rows: unknown[]) => (String(init.headers?.Prefer).includes('representation') ? J(rows) : new Response(null, { status: 204 }));
  if (p === 'plugin_licenses') {
    if (m === 'POST') { plugs.push(...body.map((b: any) => ({ user_id: null, status: 'active', source: 'token', claimed_at: null, created_at: new Date().toISOString(), ...b }))); return new Response(null, { status: 201 }); }
    const rows = plugs.filter((r) => (!q('token_hash') || r.token_hash === q('token_hash')) && (!q('user_id') || (q('user_id') === 'null' ? r.user_id === null : r.user_id === q('user_id'))));
    if (m === 'PATCH') { rows.forEach((r) => Object.assign(r, body)); return ret(rows); }
    if (m === 'DELETE') { rows.forEach((r) => plugs.splice(plugs.indexOf(r), 1)); return ret(rows); }
    return J(rows);
  }
  if (p === 'licenses' && u.searchParams.get('user_id')?.startsWith('in.')) {   // pencarian email pemilik token plugin
    const ids = u.searchParams.get('user_id')!.slice(4, -1).split(','); return J(licenses.filter((r) => r.user_id && ids.includes(r.user_id)).map((r) => ({ user_id: r.user_id, email: r.email })));
  }
  if (p === 'licenses') {
    if (m === 'POST') { licenses.push(...body.map((b: any) => ({ user_id: null, email: null, status: 'active', expires_at: null, claimed_at: null, created_at: new Date().toISOString(), ...b }))); return new Response(null, { status: 201 }); }
    const rows = licenses.filter((r) => (!q('token_hash') || r.token_hash === q('token_hash')) && (!q('user_id') || (q('user_id') === 'null' ? r.user_id === null : r.user_id === q('user_id'))));
    if (m === 'PATCH') { rows.forEach((r) => Object.assign(r, body)); return ret(rows); }
    if (m === 'DELETE') { rows.forEach((r) => licenses.splice(licenses.indexOf(r), 1)); return ret(rows); }
    return J(rows.map((r) => ({ ...r, devices: devices.filter((d) => d.token_hash === r.token_hash) })));
  }
  if (p === 'devices' && m === 'DELETE') { devices = devices.filter((d) => d.token_hash !== q('token_hash')); return new Response(null, { status: 204 }); }
  return real(input, init);
}) as typeof fetch;

const { GET, POST } = await import('../api/admin');
let fail = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const post = (b: object, cookie = '', extra: Record<string, string> = {}) => POST(new Request('https://x.test/api/admin', { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...extra }, body: JSON.stringify(b) }));
const get = (cookie = '') => GET(new Request('https://x.test/api/admin', { headers: { cookie } }));

ok('tanpa login: GET 401', (await get()).status === 401);
ok('tanpa login: create 401', (await post({ action: 'create', count: 1, devices: 2 })).status === 401);
ok('password salah 401', (await post({ action: 'login', password: 'salah' })).status === 401);
const lr = await post({ action: 'login', password: 'adm-pass-123' });
ok('password benar 200 + cookie mx_a', lr.status === 200 && lr.headers.getSetCookie().join().includes('mx_a='));
const C = lr.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
ok('cookie palsu ditolak', (await get('mx_a=abc.def')).status === 401);
ok('Origin lain ditolak', (await post({ action: 'create', count: 1, devices: 2 }, C, { origin: 'https://evil.test' })).status === 403);
ok('content-type bukan json ditolak', (await POST(new Request('https://x.test/api/admin', { method: 'POST', headers: { cookie: C, 'content-type': 'text/plain' }, body: '{}' }))).status === 400);

ok('create jumlah ngawur 400', (await post({ action: 'create', count: 0, devices: 2 }, C)).status === 400);
ok('create hari ngawur 400', (await post({ action: 'create', count: 1, devices: 2, days: 'abc' }, C)).status === 400);
const cr = await post({ action: 'create', count: 3, devices: 2, days: 30, note: 'Order #1' }, C); const cj = await cr.json() as { tokens: string[] };
ok('create 3 token format MLVX-XXXX-XXXX-XXXX-XXXX', cr.status === 200 && cj.tokens.length === 3 && cj.tokens.every((t) => /^MLVX(-[2-9A-HJ-NP-Z]{4}){4}$/.test(t)));
ok('token unik', new Set(cj.tokens).size === 3);
ok('hash di database cocok dengan hashToken (token bisa dipakai di /api/session)', licenses[0].token_hash === await hashToken(cj.tokens[0]) && licenses[0].duration_days === 30 && licenses[0].note === 'Order #1');
ok('token asli tidak tersimpan sebagai teks polos di database', !JSON.stringify(licenses).includes(cj.tokens[0]) && licenses.every((l: any) => typeof l.token_enc === 'string' && l.token_enc.length > 20));
ok('ciphertext beda tiap token', new Set(licenses.map((l: any) => l.token_enc)).size === licenses.length);
const lifetime = await (await post({ action: 'create', count: 1, devices: 1 }, C)).json() as { tokens: string[] };
ok('tanpa hari = seumur hidup (null)', licenses[3].duration_days === null && !!lifetime.tokens[0]);

const list = await (await get(C)).json() as { licenses: any[] };
ok('list 4 lisensi, tanpa user_id bocor', list.licenses.length === 4 && list.licenses.every((l) => l.user_id === undefined && l.claimed === false));
ok('list: has_token true, token_enc / token asli tidak ikut dikirim', list.licenses.every((l) => l.has_token === true && l.token_enc === undefined) && !JSON.stringify(list).includes(cj.tokens[0]));
const id = licenses[0].token_hash;

// ikon mata / salin: aksi reveal
ok('reveal tanpa login 401', (await post({ action: 'reveal', id }, '')).status === 401);
ok('reveal id ngawur 400', (await post({ action: 'reveal', id: 'x' }, C)).status === 400);
ok('reveal id tidak ada 404', (await post({ action: 'reveal', id: 'a'.repeat(64) }, C)).status === 404);
const rv = await post({ action: 'reveal', id }, C); const rj = await rv.json() as { token: string };
ok('reveal mengembalikan token asli yang sama + no-store', rv.status === 200 && rj.token === cj.tokens[0] && rv.headers.get('cache-control') === 'no-store');
ok('reveal token ke-2 dan ke-3 juga cocok', (await (await post({ action: 'reveal', id: licenses[1].token_hash }, C)).json() as { token: string }).token === cj.tokens[1] && (await (await post({ action: 'reveal', id: licenses[2].token_hash }, C)).json() as { token: string }).token === cj.tokens[2]);
const swapped = licenses[1].token_enc; (licenses[1] as any).token_enc = licenses[0].token_enc;
ok('ciphertext dipindah ke baris lain tidak bisa dibuka (AAD = hash)', (await post({ action: 'reveal', id: licenses[1].token_hash }, C)).status === 500);
(licenses[1] as any).token_enc = swapped;
const saved = (licenses[3] as any).token_enc; (licenses[3] as any).token_enc = null;
ok('token lama tanpa token_enc: reveal 404, list has_token false', (await post({ action: 'reveal', id: licenses[3].token_hash }, C)).status === 404 && (await (await get(C)).json() as { licenses: any[] }).licenses.some((l) => l.has_token === false));
(licenses[3] as any).token_enc = saved;
// SESSION_SECRET diganti: login ulang dengan rahasia baru, token lama tidak bisa dibuka (galat jelas, tidak bocor)
const secSaved = process.env.SESSION_SECRET; process.env.SESSION_SECRET = 'sec-lain';
const C2 = (await post({ action: 'login', password: 'adm-pass-123' })).headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
const rv2 = await post({ action: 'reveal', id }, C2);
ok('SESSION_SECRET berubah: reveal gagal 500 dengan pesan, tanpa token', rv2.status === 500 && !JSON.stringify(await rv2.json()).includes(cj.tokens[0]));
process.env.SESSION_SECRET = secSaved;
ok('SESSION_SECRET dikembalikan: reveal normal lagi', (await post({ action: 'reveal', id }, C)).status === 200);
ok('revoke', (await post({ action: 'revoke', id }, C)).status === 200 && licenses[0].status === 'revoked');
ok('restore', (await post({ action: 'restore', id }, C)).status === 200 && licenses[0].status === 'active');
ok('id ngawur 400', (await post({ action: 'revoke', id: 'x' }, C)).status === 400);
ok('id tidak ada 404', (await post({ action: 'revoke', id: 'a'.repeat(64) }, C)).status === 404);
ok('update catatan + perangkat', (await post({ action: 'update', id, note: 'Budi', max_devices: 3 }, C)).status === 200 && licenses[0].note === 'Budi' && licenses[0].max_devices === 3);
ok('update perangkat 99 ditolak', (await post({ action: 'update', id, max_devices: 99 }, C)).status === 400);
ok('ubah masa berlaku sebelum aktif', (await post({ action: 'update', id, duration_days: 90 }, C)).status === 200 && licenses[0].duration_days === 90);
ok('perpanjang token belum aktif ditolak 409', (await post({ action: 'update', id, extend_days: 30 }, C)).status === 409);

// simulasi token sudah dipakai pembeli
const used = licenses[1]; Object.assign(used, { user_id: 'uid-1', email: 'a@x.id', claimed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 10 * 864e5).toISOString() });
devices.push({ token_hash: used.token_hash, device_id: 'dev-12345678-aaaa', last_seen: new Date().toISOString(), created_at: new Date().toISOString() });
const before = new Date(used.expires_at!).getTime();
ok('perpanjang 30 hari dari tanggal berakhir', (await post({ action: 'update', id: used.token_hash, extend_days: 30 }, C)).status === 200 && Math.abs(new Date(used.expires_at!).getTime() - (before + 30 * 864e5)) < 1000);
ok('ubah masa berlaku setelah aktif ditolak 409', (await post({ action: 'update', id: used.token_hash, duration_days: 5 }, C)).status === 409);
const l2 = await (await get(C)).json() as { licenses: any[] };
const lu = l2.licenses.find((l) => l.email === 'a@x.id');
ok('list: claimed + perangkat (id dipendekkan)', lu.claimed === true && lu.devices.length === 1 && lu.devices[0].id === 'dev-1234');
ok('hapus token yang sudah dipakai ditolak 409', (await post({ action: 'delete', id: used.token_hash }, C)).status === 409 && licenses.includes(used));
ok('reset perangkat', (await post({ action: 'reset_devices', id: used.token_hash }, C)).status === 200 && devices.length === 0);
ok('hapus token belum dipakai', (await post({ action: 'delete', id }, C)).status === 200 && licenses.length === 3);
// ---- token plugin ----
ok('tanpa login: p_create 401', (await post({ action: 'p_create', plugin: 'mgchord', count: 1 })).status === 401);
ok('p_create plugin tak dikenal 400', (await post({ action: 'p_create', plugin: 'nggak-ada', count: 1 }, C)).status === 400);
ok('p_create jumlah ngawur 400', (await post({ action: 'p_create', plugin: 'mgchord', count: 0 }, C)).status === 400);
const pr = await post({ action: 'p_create', plugin: 'mgchord', count: 2, note: 'Order #9' }, C); const pj = await pr.json() as { tokens: string[] };
ok('p_create 2 token format PLG-XXXX-XXXX-XXXX-XXXX', pr.status === 200 && pj.tokens.length === 2 && pj.tokens.every((t) => /^PLG(-[2-9A-HJ-NP-Z]{4}){4}$/.test(t)));
ok('hash token plugin cocok dengan hashToken (bisa ditebus di /api/shop)', plugs[0].token_hash === await hashToken(pj.tokens[0]) && plugs[0].plugin === 'mgchord' && plugs[0].note === 'Order #9');
ok('token plugin asli tidak tersimpan polos', !JSON.stringify(plugs).includes(pj.tokens[0]) && plugs.every((x) => typeof x.token_enc === 'string' && x.token_enc.length > 20));
const pid = plugs[0].token_hash;
const prv = await (await post({ action: 'p_reveal', id: pid }, C)).json() as { token: string };
ok('p_reveal membuka token asli', prv.token === pj.tokens[0]);
const pl1 = await (await get(C)).json() as { plugins: any[]; plugin_ids: string[] };
ok('GET: daftar plugin + id plugin berbayar, tanpa user_id / token_enc bocor', pl1.plugins.length === 2 && pl1.plugin_ids.includes('mgchord') && pl1.plugins.every((x) => x.user_id === undefined && x.token_enc === undefined && x.claimed === false && x.has_token === true));
Object.assign(plugs[1], { user_id: 'uid-1', claimed_at: new Date().toISOString() });
const pl2 = await (await get(C)).json() as { plugins: any[] };
ok('GET: token ditebus menampilkan email pemilik', pl2.plugins.find((x) => x.claimed)?.email === 'a@x.id');
ok('p_delete token ditebus ditolak 409', (await post({ action: 'p_delete', id: plugs[1].token_hash }, C)).status === 409 && plugs.length === 2);
ok('p_update mengubah catatan', (await post({ action: 'p_update', id: plugs[1].token_hash, note: 'Budi lunas' }, C)).status === 200 && plugs[1].note === 'Budi lunas');
ok('p_update tanpa note 400', (await post({ action: 'p_update', id: plugs[1].token_hash }, C)).status === 400);
ok('p_update id tak ada 404', (await post({ action: 'p_update', id: 'c'.repeat(64), note: 'x' }, C)).status === 404);
ok('p_revoke mencabut', (await post({ action: 'p_revoke', id: plugs[1].token_hash }, C)).status === 200 && plugs[1].status === 'revoked');
ok('p_restore mengaktifkan lagi', (await post({ action: 'p_restore', id: plugs[1].token_hash }, C)).status === 200 && plugs[1].status === 'active');
ok('p_delete token belum ditebus', (await post({ action: 'p_delete', id: pid }, C)).status === 200 && plugs.length === 1);
ok('p_revoke id tak ada 404', (await post({ action: 'p_revoke', id: 'b'.repeat(64) }, C)).status === 404);
ok('logout menghapus cookie', (await post({ action: 'logout' }, C)).headers.getSetCookie().join().includes('Max-Age=0'));
console.log(fail ? `\n${fail} GAGAL` : '\nSemua lulus'); process.exit(fail ? 1 : 0);
