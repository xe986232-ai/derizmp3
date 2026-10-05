// Gerbang versi full (Vercel Routing Middleware). Berjalan SEBELUM file apa pun dikirim:
// tanpa sesi valid, kode aplikasi tidak pernah sampai ke browser. Hanya halaman login + file kecil PWA yang publik.
import { COOKIE, getCookie, verifySession } from './server/session';

export const config = { matcher: '/((?!api/).*)' };   // /api/* dijaga fungsinya sendiri

const PUBLIC = (p: string): boolean =>
  p === '/login' || p === '/login.html' || p === '/manifest.webmanifest' || p.startsWith('/icons/');   // manifest diambil browser tanpa cookie, jadi harus publik

export default async function middleware(req: Request): Promise<Response> {
  if (process.env.LICENSE_GATE !== 'on') return next();   // gerbang hanya aktif di project full (isi env LICENSE_GATE=on); project demo lolos begitu saja
  const url = new URL(req.url);
  if (PUBLIC(url.pathname)) return next();
  const s = await verifySession(getCookie(req, COOKIE), process.env.SESSION_SECRET);
  if (s) return next();
  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html') || req.headers.get('sec-fetch-dest') === 'document';
  if (!isPage) return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });   // JS/CSS/worker: 401, bukan redirect
  const back = url.pathname + url.search;
  return Response.redirect(new URL('/login' + (back !== '/' ? '?next=' + encodeURIComponent(back) : ''), url), 302);
}

// "lanjutkan ke file aslinya" (sama dengan next() dari @vercel/functions, ditulis langsung supaya tanpa dependensi tambahan)
const next = (): Response => new Response(null, { headers: { 'x-middleware-next': '1' } });
