-- Jalankan sekali di Supabase: SQL Editor -> New query -> paste -> Run.
-- Akses hanya lewat kunci service (server). RLS aktif tanpa policy = anon/authenticated tidak bisa membaca apa pun.

create table if not exists public.licenses (
  token_hash    text primary key,                 -- sha256(token); token asli tidak disimpan
  status        text not null default 'active' check (status in ('active', 'revoked')),
  user_id       uuid unique references auth.users(id) on delete set null,   -- terisi saat token diaktifkan: 1 token = 1 akun
  email         text,
  max_devices   int  not null default 2,
  duration_days int,                              -- null = seumur hidup; angka = masa berlaku sejak diaktifkan
  expires_at    timestamptz,
  note          text,                             -- mis. nama pembeli / nomor order
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz
);

create table if not exists public.devices (
  token_hash text not null references public.licenses(token_hash) on delete cascade,
  device_id  text not null,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (token_hash, device_id)
);

alter table public.licenses enable row level security;
alter table public.devices  enable row level security;
