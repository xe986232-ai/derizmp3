// Uji alur Shop Plugin (tebus token plugin) dengan Supabase TIRUAN (di memori). Jalankan: npx tsx tools/shop-flow-test.ts
process.env.SUPABASE_URL = 'http://sb.test'; process.env.SUPABASE_SERVICE_KEY = 'svc'; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SESSION_SECRET = 'sec-xyz';
import { hashToken } from '../server/supabase';
import { COOKIE, signSession } from '../server/session';

type L = { token_hash: string; status: string; user_id: string | null };
type P = { token_hash: string; plugin: string; status: string; user_id: string | null; claimed_at?: string };
const licenses: L[] = [], plugs: P[] = [];
const real = globalThis.fetch;
const J = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(String(input)); const body = init.body ? JSON.parse(init.body) : undefined; const m = init.method || 'GET';
  const p = u.pathname.replace('/rest/v1/', ''); const q = (k: string) => u.searchParams.get(k)?.replace(/^(eq|is)\./, '');
  const match = (r: any) => (!q('token_hash') || r.token_hash === q('token_hash')) && (!q('user_id') || (q('user_id') === 'null' ? r.user_id === null : r.user_id === q('user_id'))) && (!q('status') || r.status === q('status'));
  if (p === 'licenses') return J(licenses.filter(match).map((r) => ({ ...r, max_devices: 2, expires_at: null })));
  if (p === 'plugin_licenses') {
    const rows = plugs.filter(match);
    if (m === 'PATCH') { rows.forEach((r) => Object.assign(r, body)); return J(rows); }
    return J(rows);
  }
  return real(input, init);
}) as typeof fetch;

const { GET, POST } = await import('../api/shop');
let fail = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const cookieFor = async (uid: string) => COOKIE + '=' + encodeURIComponent(await signSession({ uid, did: 'dev', exp: Math.floor(Date.now() / 1000) + 600 }, process.env.SESSION_SECRET!));
const get = (c = '') => GET(new Request('https://x.test/api/shop', { headers: { cookie: c } }));
const redeem = (token: string, c = '') => POST(new Request('https://x.test/api/shop', { method: 'POST', headers: { cookie: c, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'redeem', token }) }));
const ownedOf = async (c: string) => ((await (await get(c)).json()) as { owned: string[] }).owned;

const A = 'u-a', B = 'u-b';
for (const u of [A, B]) licenses.push({ token_hash: 'lic-' + u, status: 'active', user_id: u });
const T1 = 'PLG-ABCD-EFGH-JKLM-NPQR', T2 = 'PLG-2222-3333-4444-5555', T3 = 'PLG-6666-7777-8888-9999', TX = 'PLG-WWWW-XXXX-YYYY-ZZZZ';
const add = async (t: string, plugin: string) => { plugs.push({ token_hash: await hashToken(t), plugin, status: 'active', user_id: null }); };
await add(T1, 'mgchord'); await add(T2, 'mgchord'); await add(T3, 'mgchord'); await add(TX, 'plugin-tak-berbayar');
const ca = await cookieFor(A), cb = await cookieFor(B);

ok('tanpa sesi: GET 401', (await get()).status === 401);
ok('tanpa sesi: tebus 401', (await redeem(T1)).status === 401);
ok('awalnya belum punya apa pun', (await ownedOf(ca)).length === 0);
ok('token ngawur ditolak 400', (await redeem('PLG-0000-0000-0000-0000', ca)).status === 400);
ok('token terlalu pendek ditolak 400', (await redeem('abc', ca)).status === 400);
ok('token plugin yang bukan plugin berbayar ditolak', (await redeem(TX, ca)).status === 400);
ok('cross-origin ditolak 403', (await POST(new Request('https://x.test/api/shop', { method: 'POST', headers: { cookie: ca, origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'redeem', token: T1 }) }))).status === 403);

const r = await redeem(T1.toLowerCase(), ca);
ok('tebus berhasil (huruf kecil juga boleh)', r.status === 200 && ((await r.json()) as { plugin: string }).plugin === 'mgchord');
ok('akun A sekarang memiliki mgchord', (await ownedOf(ca)).includes('mgchord'));
ok('akun B tidak ikut memiliki', (await ownedOf(cb)).length === 0);
ok('token yang sama tidak bisa dipakai akun lain', (await redeem(T1, cb)).status === 400);
const dup = await redeem(T2, ca);
ok('akun yang sudah punya ditolak 409', dup.status === 409);
ok('token yang ditolak itu tetap belum dipakai', plugs.find((x) => x.plugin === 'mgchord' && x.user_id === null) !== undefined && (await ownedOf(cb)).length === 0);

// balapan: dua akun menebus token yang sama bersamaan
const cc = await cookieFor('u-c'), cd = await cookieFor('u-d');
for (const u of ['u-c', 'u-d']) licenses.push({ token_hash: 'lic-' + u, status: 'active', user_id: u });
const [x, y] = await Promise.all([redeem(T3, cc), redeem(T3, cd)]);
ok('balapan: tepat satu yang berhasil', [x, y].filter((z) => z.status === 200).length === 1);

// pencabutan oleh admin
plugs.find((z) => z.user_id === A)!.status = 'revoked';
ok('dicabut: A tidak lagi memiliki mgchord', !(await ownedOf(ca)).includes('mgchord'));
ok('dicabut: A bisa menebus token baru', (await redeem(T2, ca)).status === 200 && (await ownedOf(ca)).includes('mgchord'));

licenses.find((z) => z.user_id === B)!.status = 'revoked';
ok('lisensi aplikasi dicabut: /api/shop = 401', (await get(cb)).status === 401);
process.exit(fail ? 1 : 0);
