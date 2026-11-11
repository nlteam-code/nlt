// Daily reminder to clients who have not activated their NLT app profile.
// Called once a day by pg_cron (see supabase/sql/activation_reminders.sql).
// One email per client per Sofia calendar day, until clients.user_id is set.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY  – API key from resend.com
//   CRON_SECRET     – any long random string; pg_cron sends it in the x-cron-secret header
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const FROM = "New Level Training <gym@newleveltraining.bg>";
const REPLY_TO = "gym@newleveltraining.bg";
const SUBJECT = "Профилът ти в NLT те очаква 💪";
const MAX_SEND = 60; // never send more than this in one run
const MAX_ROWS = 80; // if more candidates than this, something is wrong → send nothing

type Client = { id: string; name: string | null; email: string | null };

export function sofiaDate(d = new Date()): string {
  // YYYY-MM-DD in Europe/Sofia
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function firstName(name: string | null): string {
  const n = (name ?? "").trim();
  if (!n) return "";
  const first = n.split(/\s+/)[0];
  // Odd/company-like names (digits, very short, symbols) → use full name
  if (!/^[\p{L}][\p{L}'’-]+$/u.test(first)) return n;
  return first;
}

export function validEmail(e: string | null): boolean {
  const s = (e ?? "").trim();
  return s.indexOf("@") > 0 && s.includes(".") && !/\s/.test(s);
}

export function buildText(name: string, email: string): string {
  return `Здравей, ${name}!

Профилът ти в приложението на New Level Training е готов. Остава само да го активираш – отнема под минута.

С приложението можеш:
• да се записваш и отписваш от часове директно от телефона – по всяко време;
• да виждаш колко посещения ти остават и докога е абонаментът ти;
• да следиш плащанията си на едно място;
• да проследяваш прогреса си – тегло и измервания;
• да получаваш хранителния си план (ако работим заедно и по храненето).

Как да активираш профила си:
1. Отвори app.newleveltraining.bg
2. Натисни „Първо влизане или забравена парола“ и въведи имейла си (${email})
3. Ще получиш код по имейл – въведи го и си задай парола.

Ако имаш въпрос, просто отговори на това писмо.

До скоро в залата!
Екипът на New Level Training`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildHtml(text: string): string {
  const body = escapeHtml(text)
    .replace("app.newleveltraining.bg", '<a href="https://app.newleveltraining.bg">app.newleveltraining.bg</a>')
    .replace(/\n/g, "<br>");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">${body}</div>`;
}

async function sendEmail(apiKey: string, to: string, text: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject: SUBJECT, text, html: buildHtml(text) }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id?: string };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response("forbidden", { status: 403 });
  }
  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  const apiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!dryRun && !apiKey) return Response.json({ error: "RESEND_API_KEY missing" }, { status: 500 });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Same rule as before: not activated, not massage-only, Active/Paused, plausible email
  const { data, error } = await db
    .from("clients")
    .select("id, name, email")
    .is("user_id", null)
    .or("massage_only.is.null,massage_only.eq.false")
    .in("status", ["Active", "Paused"])
    .order("name");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const candidates = (data as Client[])
    .map((c) => ({ ...c, email: (c.email ?? "").trim() }))
    .filter((c) => validEmail(c.email));

  if (candidates.length > MAX_ROWS) {
    return Response.json({ error: `too many candidates (${candidates.length}), nothing sent` }, { status: 409 });
  }

  const today = sofiaDate();
  const sent: string[] = [];
  const skipped: string[] = [];
  const failed: { name: string | null; error: string }[] = [];

  for (const c of candidates) {
    if (sent.length >= MAX_SEND) break;
    const name = firstName(c.name) || c.email;

    if (dryRun) {
      sent.push(`${c.name} <${c.email}>`);
      continue;
    }

    // Claim today's slot first; unique (client_id, sent_on) guarantees once per day
    const { error: insErr } = await db
      .from("activation_reminder_log")
      .insert({ client_id: c.id, email: c.email, sent_on: today });
    if (insErr) {
      if (insErr.code === "23505") skipped.push(c.name ?? c.email);
      else failed.push({ name: c.name, error: insErr.message });
      continue;
    }

    try {
      const r = await sendEmail(apiKey, c.email, buildText(name, c.email));
      await db.from("activation_reminder_log").update({ provider_id: r.id ?? null })
        .eq("client_id", c.id).eq("sent_on", today);
      sent.push(c.name ?? c.email);
    } catch (e) {
      // release the slot so a later run today can retry
      await db.from("activation_reminder_log").delete().eq("client_id", c.id).eq("sent_on", today);
      failed.push({ name: c.name, error: String(e) });
    }
  }

  return Response.json({ date: today, dry_run: dryRun, sent_count: sent.length, sent, skipped_count: skipped.length, skipped, failed });
});
