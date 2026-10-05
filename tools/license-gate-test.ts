// Uji gerbang: sesi valid / palsu / kedaluwarsa / dimodifikasi, dan perilaku middleware. Jalankan: npx tsx tools/license-gate-test.ts
import { signSession, verifySession, COOKIE } from '../server/session';
import middleware from '../middleware';

process.env.SESSION_SECRET = 'test-secret-123';
let fail = 0; const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const now = () => Math.floor(Date.now() / 1000);
const good = await signSession({ uid: 'u1', did: 'd1', exp: now() + 100 }, process.env.SESSION_SECRET);
const old = await signSession({ uid: 'u1', did: 'd1', exp: now() - 5 }, process.env.SESSION_SECRET);
const other = await signSession({ uid: 'u1', did: 'd1', exp: now() + 100 }, 'secret-lain');
const [body, sig] = good.split('.');
const forged = btoa(JSON.stringify({ uid: 'admin', did: 'x', exp: now() + 999999 })).replace(/=+$/, '') + '.' + sig;

ok('sesi valid diterima', !!(await verifySession(good, process.env.SESSION_SECRET)));
ok('sesi kedaluwarsa ditolak', !(await verifySession(old, process.env.SESSION_SECRET)));
ok('tanda tangan secret lain ditolak', !(await verifySession(other, process.env.SESSION_SECRET)));
ok('isi dipalsukan (tanda tangan lama) ditolak', !(await verifySession(forged, process.env.SESSION_SECRET)));
ok('tanpa cookie ditolak', !(await verifySession(null, process.env.SESSION_SECRET)));
ok('tanpa SESSION_SECRET di server = tolak semua', !(await verifySession(good, undefined)));

const req = (path: string, cookie?: string, accept = 'text/html') => new Request('https://x.test' + path, { headers: { accept, ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) } });
const pass = (r: Response) => r.headers.get('x-middleware-next') === '1';
ok('halaman tanpa sesi -> redirect /login', (await middleware(req('/'))).status === 302 && (await middleware(req('/'))).headers.get('location') === 'https://x.test/login');
ok('redirect membawa ?next=', (await middleware(req('/?p=1&q=2'))).headers.get('location')?.includes('next=') === true);
ok('JS tanpa sesi -> 401 (bukan kode)', (await middleware(req('/assets/main-abc.js', undefined, '*/*'))).status === 401);
ok('/login publik', pass(await middleware(req('/login'))));
ok('manifest publik', pass(await middleware(req('/manifest.webmanifest', undefined, '*/*'))));
ok('/icons publik', pass(await middleware(req('/icons/x.png', undefined, '*/*'))));
ok('sesi valid -> lanjut ke aplikasi', pass(await middleware(req('/', good))));
ok('sesi valid -> aset lanjut', pass(await middleware(req('/assets/main-abc.js', good, '*/*'))));
ok('sesi palsu -> redirect', (await middleware(req('/', forged))).status === 302);
ok('sesi kedaluwarsa -> redirect', (await middleware(req('/', old))).status === 302);
process.exit(fail ? 1 : 0);
