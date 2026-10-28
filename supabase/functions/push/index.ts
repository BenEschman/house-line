// Delivers a House Line notification to every device the user turned push on for.
// Called by the database (private.push_send) with {id} and the shared x-hook-secret.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Config = { public: string; private: string; hook: string; subject: string };
let config: Config | null = null;
async function getConfig(): Promise<Config> {
  if (config) return config;
  const { data, error } = await sb.rpc("push_config");
  if (error || !data?.private) throw new Error("push config unavailable: " + (error?.message ?? "missing keys"));
  webpush.setVapidDetails(data.subject, data.public, data.private);
  config = data as Config;
  return config;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let cfg: Config;
  try { cfg = await getConfig(); } catch (e) { return json({ error: String(e) }, 500); }
  if (req.headers.get("x-hook-secret") !== cfg.hook) return json({ error: "forbidden" }, 403);

  const { id } = await req.json().catch(() => ({}));
  if (!id) return json({ error: "missing id" }, 400);

  const { data: n } = await sb.from("notifications").select("*").eq("id", id).maybeSingle();
  if (!n) return json({ sent: 0, reason: "notification not found" });

  const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", n.user_id).eq("active", true);
  if (!subs?.length) return json({ sent: 0, reason: "no devices" });

  const { count: unread } = await sb.from("notifications").select("id", { count: "exact", head: true })
    .eq("user_id", n.user_id).is("read_at", null);

  const payload = JSON.stringify({
    title: n.title,
    body: n.body,
    tag: n.bet_id ? `${n.kind}:${n.bet_id}` : `${n.kind}:${n.id}`,
    url: `./?n=${n.id}`,
    badge: unread ?? 0,
  });

  const results = await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: "high" });
      return { ok: true };
    } catch (e: any) {
      const status = e?.statusCode ?? 0;
      // The device unsubscribed or the address expired: stop sending to it.
      if (status === 404 || status === 410) await sb.from("push_subscriptions").update({ active: false }).eq("id", s.id);
      return { ok: false, status, error: String(e?.body ?? e?.message ?? e).slice(0, 200) };
    }
  }));
  return json({ sent: results.filter((r) => r.ok).length, results });
});
