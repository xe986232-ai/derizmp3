// Pembantu Supabase (REST + Auth) untuk fungsi /api. Kunci service hanya ada di server (env), tidak pernah dikirim ke browser.
const env = (k: string): string => { const v = process.env[k]; if (!v) throw new Error('Env belum diisi: ' + k); return v; };

export async function sha256hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Token dinormalisasi (huruf besar, tanpa tanda hubung/spasi) lalu di-hash: database tidak menyimpan token asli.
export const hashToken = (t: string): Promise<string> => sha256hex(t.toUpperCase().replace(/[^A-Z0-9]/g, ''));

export async function rest<T = unknown>(path: string, init: { method?: string; body?: unknown; returnRows?: boolean; upsert?: boolean } = {}): Promise<T> {
  const k = env('SUPABASE_SERVICE_KEY');
  const r = await fetch(env('SUPABASE_URL') + '/rest/v1/' + path, {
    method: init.method || 'GET',
    headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', Prefer: (init.upsert ? 'resolution=merge-duplicates,' : '') + (init.returnRows ? 'return=representation' : 'return=minimal') },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const t = await r.text();
  return (t ? JSON.parse(t) : null) as T;
}

export async function passwordLogin(email: string, password: string): Promise<string | null> {
  const r = await fetch(env('SUPABASE_URL') + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: env('SUPABASE_ANON_KEY'), 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!r.ok) return null;
  return ((await r.json()) as { user?: { id?: string } }).user?.id ?? null;
}

export async function createUser(email: string, password: string): Promise<{ id: string } | { error: 'exists' | 'failed' }> {
  const k = env('SUPABASE_SERVICE_KEY');
  const r = await fetch(env('SUPABASE_URL') + '/auth/v1/admin/users', {
    method: 'POST', headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (r.ok) return { id: ((await r.json()) as { id: string }).id };
  return { error: r.status === 422 ? 'exists' : 'failed' };
}

export async function deleteUser(id: string): Promise<void> {
  const k = env('SUPABASE_SERVICE_KEY');
  await fetch(env('SUPABASE_URL') + '/auth/v1/admin/users/' + id, { method: 'DELETE', headers: { apikey: k, Authorization: 'Bearer ' + k } }).catch(() => undefined);
}

export type License = { token_hash: string; status: string; max_devices: number; expires_at: string | null };
export const licenseOk = (l: License | undefined): l is License => !!l && l.status === 'active' && (!l.expires_at || new Date(l.expires_at).getTime() > Date.now());
export const licenseOf = async (uid: string): Promise<License | undefined> =>
  (await rest<License[]>(`licenses?user_id=eq.${uid}&select=token_hash,status,max_devices,expires_at&limit=1`))[0];

// ---- Storage (bucket privat 'avatars', hanya bisa diakses dengan kunci service dari server) ----
const sbHeaders = (extra: Record<string, string> = {}): Record<string, string> => { const k = env('SUPABASE_SERVICE_KEY'); return { apikey: k, Authorization: 'Bearer ' + k, ...extra }; };
const obj = (path: string): string => env('SUPABASE_URL') + '/storage/v1/object/avatars/' + path;

export async function avatarPut(path: string, bytes: Uint8Array, type: string): Promise<void> {
  const r = await fetch(obj(path), { method: 'POST', headers: sbHeaders({ 'Content-Type': type, 'x-upsert': 'true' }), body: bytes as unknown as BodyInit });
  if (!r.ok) throw new Error('Storage ' + r.status + ': ' + (await r.text()).slice(0, 200));
}
export async function avatarGet(path: string): Promise<Response | null> {
  const r = await fetch(obj(path), { headers: sbHeaders() });
  return r.ok ? r : null;   // belum ada foto (404 / 400 "not found") = null
}
export async function avatarDelete(path: string): Promise<void> {
  await fetch(obj(path), { method: 'DELETE', headers: sbHeaders() }).catch(() => undefined);
}
