-- Daily activation reminders (NLT). Run once in Supabase → SQL Editor.
-- Before running: replace PASTE_CRON_SECRET_HERE with the same value you put in the CRON_SECRET function secret.

-- 1) Log: one row per client per Sofia day (prevents double sends)
create table if not exists public.activation_reminder_log (
  id          bigint generated always as identity primary key,
  client_id   uuid not null references public.clients(id) on delete cascade,
  email       text not null,
  sent_on     date not null,
  sent_at     timestamptz not null default now(),
  provider_id text,
  unique (client_id, sent_on)
);
alter table public.activation_reminder_log enable row level security;
-- no policies: only the service role (the edge function) can read/write

-- 2) Extensions for scheduling HTTP calls
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 3) Store the secret in Vault (not in plain text in the cron job)
select vault.create_secret('PASTE_CRON_SECRET_HERE', 'activation_reminders_cron_secret');

-- 4) Schedule: every day at 08:40 UTC (= 10:40 Sofia in winter, 11:40 in summer)
select cron.schedule(
  'activation-reminders-daily',
  '40 8 * * *',
  $$
  select net.http_post(
    url     := 'https://krshyauillsrgoqzyjgc.supabase.co/functions/v1/activation-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'activation_reminders_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Useful later:
--   select * from activation_reminder_log order by sent_at desc limit 50;      -- who got what
--   select * from cron.job_run_details order by start_time desc limit 5;        -- did the job run
--   select cron.unschedule('activation-reminders-daily');                      -- stop it
