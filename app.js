// House Line — client. Reads go straight to Supabase tables (row-level security
// limits them to your groups); every write is an RPC defined in supabase/schema.sql.

const cfg = window.HOUSE_LINE_CONFIG || {};
const configured = cfg.supabaseUrl && !cfg.supabaseUrl.includes("YOUR-PROJECT") && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.includes("YOUR-");
const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

const blankDraft = () => ({ type: "ou", title: "", detail: "", line: "", overOdds: "-110", underOdds: "-110",
  outcomes: [{ label: "", odds: "+100" }, { label: "", odds: "+100" }], hidden: [], closesAt: "", startsAt: "" });

const state = {
  session: null, groups: [], groupId: null,
  bets: [], wagers: [], members: [], hidden: {}, props: [], loaded: false,
  tab: "board", filter: "open", authMode: "signin", draft: blankDraft(), channel: null,
};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtOdds = o => (o > 0 ? "+" : "") + o;
const fmtTok = n => Math.round(Number(n) || 0).toLocaleString();
const returns = (stake, odds) => stake + Math.floor(odds > 0 ? stake * odds / 100 : stake * 100 / Math.abs(odds));
const validOdds = o => Number.isInteger(o) && Math.abs(o) >= 100;

// Live pricing — mirrors private.* functions in supabase/schema.sql so the preview matches the server.
const impliedProb = o => o < 0 ? -o / (-o + 100) : 100 / (o + 100);
function toAmerican(q) {
  q = Math.min(Math.max(q, 0.0099), 0.99);
  if (q >= 0.5) return Math.min(-Math.round(100 * q / (1 - q) / 5) * 5, -100);
  return Math.max(Math.round(100 * (1 - q) / q / 5) * 5, 100);
}
function poissonAtLeast(k, mu) {
  if (k <= 0) return 1;
  if (mu <= 0) return 0;
  let term = Math.exp(-mu), cdf = 0;
  for (let i = 0; i < k; i++) { cdf += term; term = term * mu / (i + 1); }
  return Math.max(0, Math.min(1, 1 - cdf));
}
function calibrateLambda(k, p) {
  let lo = 1e-6, hi = Math.max(10, k * 4 + 10);
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; poissonAtLeast(k, mid) < p ? lo = mid : hi = mid; }
  return (lo + hi) / 2;
}
// Pricing — mirrors private.bet_progress / price_ou / price_custom in supabase/schema.sql.
const MARKET_TEMPERATURE = 10000;   // tokens of net money that shift the log-odds by 1
const startOf = b => new Date(b.starts_at || b.created_at).getTime();
const hasStarted = (b, t = Date.now()) => t >= startOf(b);
function progressAt(b, t = Date.now()) {
  if (!b.closes_at) return 0;
  const start = startOf(b), span = new Date(b.closes_at).getTime() - start;
  if (!(span > 0)) return 0;
  const minute = Math.floor(t / 60000) * 60000;
  return Math.min(1, Math.max(0, (minute - start) / span));
}
function ouModel(b) {
  if (b.live_lambda != null) return { lam: b.live_lambda, ovr: b.live_overround };
  const [ov, un] = b.outcomes;
  const qo = impliedProb(ov.open_odds ?? ov.odds), qu = impliedProb(un.open_odds ?? un.odds);
  return { lam: calibrateLambda(Math.floor(Number(b.line)) + 1, Math.min(Math.max(qo / (qo + qu), 0.01), 0.99)), ovr: qo + qu };
}
function sideStakes(b) {
  let over = 0, under = 0;
  for (const w of state.wagers) if (w.bet_id === b.id) {
    ((w.side || (w.outcome_id === b.outcomes[0].id ? "over" : "under")) === "over") ? over += w.stake : under += w.stake;
  }
  return { over, under };
}
function priceOU(b, line, side, t = Date.now()) {
  const [ov, un] = b.outcomes, s = sideStakes(b), cur = Number(b.live_current ?? 0), prog = progressAt(b, t);
  if (s.over === 0 && s.under === 0 && cur === 0 && prog === 0 && line === Number(b.line))
    return side === "over" ? (ov.open_odds ?? ov.odds) : (un.open_odds ?? un.odds);
  const m = ouModel(b);
  let p = poissonAtLeast(Math.floor(line - cur) + 1, m.lam * (1 - prog));
  p = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  p = 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + (s.over - s.under) / MARKET_TEMPERATURE)));
  return toAmerican((side === "over" ? p : 1 - p) * m.ovr);
}
function priceCustom(b, o) {
  const stakeOn = id => state.wagers.reduce((a, w) => a + (w.bet_id === b.id && w.outcome_id === id ? w.stake : 0), 0);
  if (state.wagers.every(w => w.bet_id !== b.id)) return o.open_odds ?? o.odds;
  const ovr = b.outcomes.reduce((a, x) => a + impliedProb(x.open_odds ?? x.odds), 0);
  let num = 0, den = 0;
  for (const x of b.outcomes) {
    const v = impliedProb(x.open_odds ?? x.odds) / ovr * Math.exp(stakeOn(x.id) / MARKET_TEMPERATURE);
    den += v; if (x.id === o.id) num = v;
  }
  return toAmerican(num / den * ovr);
}
// Current price of an outcome as the server would quote it now. Final bets show what was stored.
function priceOf(b, o) {
  if (b.status !== "open" && b.status !== "locked") return o.odds;
  return b.line != null ? priceOU(b, Number(b.line), o.position === 0 ? "over" : "under") : priceCustom(b, o);
}
// Closing-time helpers. Inputs use the device's local time; the server stores UTC.
const pad2 = n => String(n).padStart(2, "0");
const toLocalInput = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function nextAtHour(h) { const d = new Date(); d.setHours(h, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d; }
function closePresets() {
  const inHour = new Date(Date.now() + 3600e3); inHour.setSeconds(0, 0);
  return [["none", "No limit", ""], ["1h", "In 1 hour", toLocalInput(inHour)], ["mid", "Midnight", toLocalInput(nextAtHour(0))], ["2am", "2 AM", toLocalInput(nextAtHour(2))]];
}
function fmtClose(iso) {
  const d = new Date(iso), soon = Math.abs(d - Date.now()) < 20 * 3600e3;
  return d.toLocaleString([], soon ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function leftText(iso) {
  const m = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  if (m < 1) return "under a minute left";
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m left` : `${Math.round(h / 24)} days left`;
}
const isPast = iso => iso && new Date(iso) <= new Date();
function startPresets() {
  const inHour = new Date(Date.now() + 3600e3); inHour.setSeconds(0, 0);
  return [["now", "Now", ""], ["1h", "In 1 hour", toLocalInput(inHour)], ["8pm", "8 PM", toLocalInput(nextAtHour(20))], ["10pm", "10 PM", toLocalInput(nextAtHour(22))]];
}
function startPicker(value) {
  return `<div class="chips close-chips">${startPresets().map(([k, l, v]) =>
      `<button type="button" data-start-preset="c" data-v="${v}" aria-pressed="${value === v}">${l}</button>`).join("")}</div>
    <input class="inp num" type="datetime-local" id="c-start" value="${esc(value)}" aria-label="Start date and time">`;
}
function closePicker(prefix, value) {
  return `<div class="chips close-chips">${closePresets().map(([k, l, v]) =>
      `<button type="button" data-close-preset="${prefix}" data-v="${v}" aria-pressed="${value === v}">${l}</button>`).join("")}</div>
    <input class="inp num" type="datetime-local" id="${prefix}-at" value="${esc(value)}" aria-label="Closing date and time">`;
}
// Step to the next/previous half-point line (alternate lines always end in .5).
const lineUp = l => Math.floor(l) + 0.5 > l ? Math.floor(l) + 0.5 : Math.floor(l) + 1.5;
const lineDown = l => Math.ceil(l) - 0.5 < l ? Math.ceil(l) - 0.5 : Math.ceil(l) - 1.5;
const sideLabel = s => s === "over" ? "Over" : "Under";
const agoText = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
const uid = () => state.session?.user?.id;
const group = () => state.groups.find(g => g.id === state.groupId);
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  $("#toastHost").replaceChildren(t); setTimeout(() => t.remove(), 2400);
}
const errMsg = e => (e?.message || "Something went wrong. Try again.").replace(/^.*?ERROR:\s*/, "");

/* ---------------- data ---------------- */

async function loadGroups() {
  const { data, error } = await sb.from("memberships")
    .select("group_id, groups(id, name, invite_code, owner_id)").eq("user_id", uid());
  if (error) { toast(errMsg(error)); return; }
  state.groups = (data || []).map(r => r.groups).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const saved = store.get("hl-group");
  const pick = state.groups.find(g => g.id === saved) || state.groups[0];
  if (pick) await openGroup(pick.id); else { state.groupId = null; render(); }
}

async function openGroup(id) {
  state.groupId = id; store.set("hl-group", id);
  state.loaded = false; state.tab = "board"; render();
  await loadGroupData();
  subscribe(id);
}

async function loadGroupData() {
  const gid = state.groupId; if (!gid) return;
  const [bets, wagers, members, hidden, props] = await Promise.all([
    sb.from("bets").select("*, outcomes!outcomes_bet_id_fkey(id, label, odds, open_odds, position)").eq("group_id", gid).order("created_at", { ascending: false }).limit(300),
    sb.from("wagers").select("*").eq("group_id", gid).limit(5000),
    sb.from("memberships").select("user_id, balance, profiles(username)").eq("group_id", gid),
    sb.from("bet_hidden").select("bet_id, user_id").eq("group_id", gid),
    sb.from("props").select("*").eq("group_id", gid).order("created_at"),
  ]);
  if (gid !== state.groupId) return;
  const err = bets.error || wagers.error || members.error;
  if (err) toast(errMsg(err));
  state.bets = (bets.data || []).map(b => ({ ...b, outcomes: (b.outcomes || []).sort((x, y) => x.position - y.position) }));
  state.wagers = wagers.data || [];
  state.members = (members.data || []).map(m => ({ id: m.user_id, balance: Number(m.balance), username: m.profiles?.username || "player" }));
  state.props = props.data || [];
  state.hidden = {};
  for (const h of hidden.data || []) (state.hidden[h.bet_id] ||= []).push(h.user_id);
  state.loaded = true;
  render();
}

let reloadTimer = null;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadGroupData, 250); }

function subscribe(gid) {
  if (state.channel) sb.removeChannel(state.channel);
  const ch = sb.channel("group-" + gid);
  for (const table of ["bets", "outcomes", "wagers", "memberships", "bet_hidden", "props"])
    ch.on("postgres_changes", { event: "*", schema: "public", table, filter: `group_id=eq.${gid}` }, scheduleReload);
  ch.subscribe();
  state.channel = ch;
}
// Catch up after the phone wakes or the tab comes back.
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.groupId) loadGroupData(); });

/* ---------------- derived ---------------- */

const me = () => state.members.find(m => m.id === uid());
const nameOf = id => id === uid() ? "You" : (state.members.find(m => m.id === id)?.username || "player");
const betById = id => state.bets.find(b => b.id === id);
const propOf = b => b.prop_id ? state.props.find(p => p.id === b.prop_id) : null;
const canManage = b => propOf(b)?.player_id !== uid() && (b.creator_id === uid() || group()?.owner_id === uid());

function myStats() {
  let risk = 0, won = 0, lost = 0;
  for (const w of state.wagers) {
    if (w.user_id !== uid()) continue;
    const b = betById(w.bet_id);
    if (w.payout == null) risk += w.stake;
    else if (b?.status === "settled") (w.payout > w.stake ? won++ : w.payout === 0 ? lost++ : 0);
  }
  return { bal: me()?.balance ?? 0, risk, won, lost };
}
function recordOf(id) {
  let won = 0, lost = 0, risk = 0;
  for (const w of state.wagers) if (w.user_id === id) {
    if (w.payout == null) risk += w.stake;
    else if (betById(w.bet_id)?.status === "settled") (w.payout > w.stake ? won++ : w.payout === 0 ? lost++ : 0);
  }
  return { won, lost, risk };
}

/* ---------------- render ---------------- */

function render() {
  const app = $("#app");
  const inGroup = !!(state.session && state.groupId);
  $("#top").hidden = !inGroup; $("#tabs").hidden = !inGroup;
  app.classList.toggle("solo", !inGroup);
  if (!configured) { app.innerHTML = setupHTML(); return; }
  if (!state.session) { app.innerHTML = authHTML(); return; }
  if (!state.groupId) { app.innerHTML = noGroupHTML(); return; }
  $("#groupName").textContent = group()?.name || "";
  $("#bal").textContent = state.loaded ? fmtTok(myStats().bal) : "—";
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-current", String(b.dataset.tab === state.tab)));
  app.innerHTML = { board: boardHTML, create: createHTML, props: propsHTML, slip: slipHTML, leaders: leadersHTML }[state.tab]();
}

function setupHTML() {
  return `<h1>House<span>Line</span></h1>
  <p class="lede">Almost there. This copy isn’t connected to a database yet.</p>
  <div class="form"><b>Finish setup</b><span class="hint">Open <code>config.js</code> and paste your Supabase project URL and anon key. The README walks through it.</span></div>`;
}

function authHTML() {
  const up = state.authMode === "signup";
  return `<h1>House<span>Line</span></h1>
  <p class="lede">Make lines. Take action. Play money only.</p>
  <form class="form" id="authForm">
    ${up ? `<label class="f" for="a-user">Username<input class="inp" id="a-user" autocomplete="username" maxlength="20" placeholder="benny" required></label>` : ""}
    <label class="f" for="a-email">Email<input class="inp" id="a-email" type="email" autocomplete="email" required></label>
    <label class="f" for="a-pass">Password<input class="inp" id="a-pass" type="password" autocomplete="${up ? "new-password" : "current-password"}" minlength="6" required></label>
    <div class="err" id="a-err"></div>
    <button class="btn primary big" type="submit">${up ? "Create account" : "Sign in"}</button>
    <button class="btn link" type="button" id="a-toggle">${up ? "Have an account? Sign in" : "New here? Create an account"}</button>
  </form>`;
}

function noGroupHTML() {
  return `<h1>House<span>Line</span></h1>
  <p class="lede">Bets live inside a group. Join your friends’ group with their invite code, or start one.</p>
  ${joinCreateForms()}
  <button class="btn link" id="signOut" style="margin-top:18px">Sign out</button>`;
}
function joinCreateForms() {
  return `<form class="form" id="joinForm">
    <label class="f" for="j-code">Invite code<input class="inp code" id="j-code" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="K7Q2MX" required></label>
    <div class="err" id="j-err"></div>
    <button class="btn primary big" type="submit">Join group</button>
  </form>
  <div class="divider">or</div>
  <form class="form" id="newGroupForm">
    <label class="f" for="g-name">New group name<input class="inp" id="g-name" maxlength="60" placeholder="Friday night crew" required></label>
    <span class="hint">Everyone who joins starts with 1,000 tokens.</span>
    <div class="err" id="g-err"></div>
    <button class="btn big" type="submit">Create group</button>
  </form>`;
}

function poolFor(betId) {
  const pool = {};
  for (const w of state.wagers) if (w.bet_id === betId) pool[w.outcome_id] = (pool[w.outcome_id] || 0) + w.stake;
  return pool;
}

function boardHTML() {
  const bucket = b => b.status === "open" ? "open" : b.status === "locked" ? "locked" : "done";
  const counts = { open: 0, locked: 0, done: 0 };
  state.bets.forEach(b => counts[bucket(b)]++);
  const shown = state.bets.filter(b => bucket(b) === state.filter);
  const seg = `<div class="seg" role="group" aria-label="Filter bets">${[["open", "Open"], ["locked", "Locked"], ["done", "Settled"]]
    .map(([k, l]) => `<button data-filter="${k}" aria-pressed="${state.filter === k}">${l} · ${counts[k]}</button>`).join("")}</div>`;
  if (!state.loaded) return seg + `<div class="empty"><b>Loading the board…</b></div>`;
  if (!shown.length) return seg + (state.filter === "open"
    ? `<div class="empty"><b>No open bets yet</b>Tap New bet to post the first line, like “Jake finishes the burrito, O/U 12.5 min.”</div>`
    : `<div class="empty"><b>Nothing here yet</b>Bets move here when their creator locks or settles them.</div>`);
  return seg + `<div class="list">${shown.map(betCard).join("")}</div>`;
}

function betCard(b) {
  const pool = poolFor(b.id);
  const mineBy = {};
  for (const w of state.wagers) if (w.bet_id === b.id && w.user_id === uid()) mineBy[w.outcome_id] = (mineBy[w.outcome_id] || 0) + w.stake;
  const open = b.status === "open";
  const mine = b.creator_id === uid();
  const prop = propOf(b), myProp = prop?.player_id === uid();
  const closed = isPast(b.closes_at);
  const canBet = open && !(mine && !b.auto_line) && !myProp && !closed;
  const hiddenFrom = (state.hidden[b.id] || []).map(nameOf);
  const outs = b.outcomes.map(o => {
    const cls = b.status === "settled" ? (o.id === b.winning_outcome_id ? "won" : "lost") : "";
    return `<button class="out ${cls}" data-bet="${esc(b.id)}" data-out="${esc(o.id)}" ${canBet ? "" : "disabled"}>
      <span class="lbl">${esc(o.label)}</span>
      <span class="odds num">${fmtOdds(priceOf(b, o))}</span>
      ${o.open_odds != null && o.open_odds !== priceOf(b, o) ? `<span class="opened num">opened ${fmtOdds(o.open_odds)}</span>` : ""}
      <span class="pool num">${fmtTok(pool[o.id] || 0)} wagered${cls === "won" ? " · winner" : ""}</span>
      ${mineBy[o.id] ? `<span class="mine num">You: ${fmtTok(mineBy[o.id])}</span>` : ""}
    </button>`;
  }).join("");
  const live = b.status === "open" || b.status === "locked";
  const ctl = live && canManage(b) ? `<div class="ctl"><span>${b.creator_id === uid() ? "Your bet" : "Group owner"}</span>
      ${b.line != null ? `<button class="btn live-btn" data-act="live" data-bet="${esc(b.id)}">Live count</button>` : ""}
      <button class="btn" data-act="closetime" data-bet="${esc(b.id)}">End time</button>
      ${open ? `<button class="btn" data-act="lock" data-bet="${esc(b.id)}">Lock</button>` : `<button class="btn" data-act="reopen" data-bet="${esc(b.id)}">Reopen</button>`}
      <button class="btn primary" data-act="settle" data-bet="${esc(b.id)}">Settle</button>
      <button class="btn danger" data-act="void" data-bet="${esc(b.id)}">Void</button></div>` : "";
  return `<article class="bet" data-bet-card="${esc(b.id)}">
    <div class="bet-head">
      <div class="bet-meta"><span>${esc(nameOf(b.creator_id))}${b.line != null ? ` · line ${esc(b.line)}` : ""}</span><span class="pill ${esc(b.status)}">${esc(b.status)}</span></div>
      <h3>${esc(b.title)}</h3>
      ${b.detail ? `<p class="detail">${esc(b.detail)}</p>` : ""}
      ${b.closes_at && (open || (b.status === "locked" && closed)) ? `<p class="note close-note${closed ? "" : " ticking"}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${closed ? `Ended ${esc(fmtClose(b.closes_at))} · waiting for ${esc(b.creator_id === uid() ? "you" : nameOf(b.creator_id))} to settle` : `Ends ${esc(fmtClose(b.closes_at))} · ${leftText(b.closes_at)}`}</p>` : ""}
      ${b.final_value != null ? `<p class="note"><b>Final: ${esc(String(Number(b.final_value)))}</b></p>` : ""}
      ${canBet && b.line != null ? `<p class="note">Tap odds to bet, or pick your own line.</p>` : ""}
      ${prop ? `<p class="note prop-note"><span class="prop-tag">PROP</span>${esc(nameOf(prop.player_id))} · ${esc(prop.stat)}${b.auto_line ? ` <span class="alt-tag">auto line</span>` : ""}</p>` : ""}
      ${myProp && open ? `<p class="note">This prop is about you, so you can't bet on it.</p>` : ""}
      ${mine && open && !b.auto_line && !myProp ? `<p class="note">Your line. You can't bet on it.</p>` : ""}
      ${hiddenFrom.length ? `<p class="note hidden-note"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3.1 3.6M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6c1.7 0 3.2-.5 4.5-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>Hidden from ${esc(hiddenFrom.join(", "))}</p>` : ""}
      ${liveBar(b, live)}
    </div>
    <div class="outs">${outs}</div>${ctl}
  </article>`;
}

// Odds input with a ± button: phone number pads have no + or − key.
function oddsField(id, value, attrs = "") {
  const neg = String(value).trim().startsWith("-");
  return `<div class="odds-field">
    <button type="button" class="sign" data-sign-for="${id}" aria-label="Switch between minus and plus odds">${neg ? "−" : "+"}<small>±</small></button>
    <input class="inp num" id="${id}" ${attrs} inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="110" value="${esc(String(value).replace(/^[+-]/, ""))}">
  </div>`;
}
// Read an odds field back as a signed string like "-110" or "+150".
function oddsValue(id) {
  const input = document.getElementById(id), btn = document.querySelector(`[data-sign-for="${id}"]`);
  if (!input) return undefined;
  const digits = input.value.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return (btn?.textContent.trim().startsWith("−") ? "-" : "+") + digits;
}

function liveBar(b, live) {
  if (b.line == null || !b.closes_at || !live) return "";
  if (!hasStarted(b)) return `<div class="livebar"><span class="dot off"></span>Starts&nbsp;<b>${esc(fmtClose(b.starts_at || b.created_at))}</b><span class="when">odds frozen until then</span></div>`;
  const pct = Math.round(progressAt(b) * 100);
  return `<div class="livebar"><span class="dot"></span><b class="num">${esc(String(Number(b.live_current ?? 0)))}</b>&nbsp;so far · <span class="num">${pct}%</span>&nbsp;through${b.live_updated_at ? `<span class="when">count ${agoText(b.live_updated_at)}</span>` : ""}
    <div class="prog" aria-hidden="true"><i style="width:${pct}%"></i></div></div>`;
}

function createHTML() {
  const d = state.draft, ou = d.type === "ou";
  const typeSeg = `<div class="seg" role="group" aria-label="Bet type">${[["ou", "Over / Under"], ["custom", "Custom outcomes"]]
    .map(([k, l]) => `<button type="button" data-type="${k}" aria-pressed="${d.type === k}">${l}</button>`).join("")}</div>`;
  const body = ou ? `
    <label class="f" for="c-line">Line<input class="inp num" id="c-line" inputmode="decimal" placeholder="12.5" value="${esc(d.line)}"><span class="hint">Use a .5 so nobody pushes.</span></label>
    <div class="orow two">
      <label class="f" for="c-over">Over odds${oddsField("c-over", d.overOdds)}</label>
      <label class="f" for="c-under">Under odds${oddsField("c-under", d.underOdds)}</label>
    </div>` : `
    <div class="f">Outcomes &amp; odds
      <div class="list" style="gap:8px">${d.outcomes.map((o, i) => `
        <div class="orow">
          <input class="inp" id="c-ol-${i}" data-ol="${i}" maxlength="60" placeholder="Outcome ${i + 1}" value="${esc(o.label)}" aria-label="Outcome ${i + 1}">
          ${oddsField(`c-oo-${i}`, o.odds, `data-oo="${i}" aria-label="Odds for outcome ${i + 1}"`)}
          <button type="button" class="x" data-rm="${i}" aria-label="Remove outcome ${i + 1}" ${d.outcomes.length <= 2 ? "disabled" : ""}>×</button>
        </div>`).join("")}</div>
      <button type="button" class="btn" id="c-add" style="align-self:flex-start;margin-top:4px" ${d.outcomes.length >= 8 ? "disabled" : ""}>+ Add outcome</button>
      <span class="hint">Tap ± to switch minus and plus. −150 means risk 150 to win 100. +200 means risk 100 to win 200.</span>
    </div>`;
  return `<h2>Post a line</h2>${typeSeg}
  <form class="form" id="createForm">
    <label class="f" for="c-title">What’s the bet?<input class="inp" id="c-title" maxlength="120" placeholder="${ou ? "Minutes for Jake to finish the burrito" : "Who wins Friday’s Smash bracket?"}" value="${esc(d.title)}"></label>
    <label class="f" for="c-detail">Details (optional)<input class="inp" id="c-detail" maxlength="240" placeholder="Settled by stopwatch at the table" value="${esc(d.detail)}"></label>
    ${body}
    <div class="f">Starts${startPicker(state.draft.startsAt)}<span class="hint">Odds hold at your opening line until the start. People can bet early.</span></div>
    <div class="f">Ends${closePicker("c", state.draft.closesAt)}<span class="hint">Betting closes at the end. Over/under odds follow the clock between start and end.</span></div>
    ${hidePicker()}
    <div class="err" id="c-err"></div>
    <button class="btn primary big" type="submit">Post bet</button>
  </form>`;
}

function hidePicker() {
  const others = state.members.filter(m => m.id !== uid()).sort((a, b) => a.username.localeCompare(b.username));
  if (!others.length) return "";
  const h = state.draft.hidden;
  return `<div class="f">Hide from (optional)
    <div class="chips hide-chips">${others.map(m => `<button type="button" data-hide="${esc(m.id)}" aria-pressed="${h.includes(m.id)}">${esc(m.username)}</button>`).join("")}</div>
    <span class="hint">${h.length ? `${h.length} ${h.length === 1 ? "person" : "people"} won’t see this bet, its odds, or who bet on it.` : "Pick anyone who shouldn’t see this bet."}</span>
  </div>`;
}

/* ---------------- player props ---------------- */

const AUTO_THRESHOLD = 3;   // settled results before lines set themselves (matches private.prop_auto_threshold)
function propHistory(pr) {
  return state.bets.filter(b => b.prop_id === pr.id && b.status === "settled" && b.final_value != null)
    .sort((a, b) => (b.settled_at || "").localeCompare(a.settled_at || ""));
}
const propActive = pr => state.bets.find(b => b.prop_id === pr.id && (b.status === "open" || b.status === "locked"));

function propsHTML() {
  const byPlayer = {};
  for (const pr of state.props) (byPlayer[pr.player_id] ||= []).push(pr);
  const players = Object.keys(byPlayer).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const head = `<div class="props-head"><h2>Player props</h2><button class="btn primary" id="newProp">New prop</button></div>`;
  if (!state.loaded) return head + `<div class="empty"><b>Loading…</b></div>`;
  if (!players.length) return head + `<div class="empty"><b>No props yet</b>Make one for anyone in the group, like “Jake · Drinks”. Set the first ${AUTO_THRESHOLD} lines yourself. After that, the app sets the line from past results.</div>`;
  return head + players.map(pid => `
    <section class="player">
      <h3 class="player-name"><span class="initial">${esc((nameOf(pid)[0] || "?").toUpperCase())}</span>${esc(pid === uid() ? "You" : nameOf(pid))}</h3>
      <div class="list">${byPlayer[pid].map(propCard).join("")}</div>
    </section>`).join("");
}

function propCard(pr) {
  const hist = propHistory(pr), active = propActive(pr), mineProp = pr.player_id === uid();
  const n = hist.length, auto = n >= AUTO_THRESHOLD;
  const recent = hist.slice(0, 8).map(b => `<span class="res num">${esc(String(Number(b.final_value)))}</span>`).join("");
  const status = auto
    ? `<span class="alt-tag">auto lines</span> Set from the last ${Math.min(n, 10)} results`
    : `Lines set by hand · ${n} of ${AUTO_THRESHOLD} results until auto lines`;
  let action;
  if (active) {
    const ov = active.outcomes[0], un = active.outcomes[1];
    action = `<button class="prop-live" data-goto-bet="${esc(active.id)}"><span class="pill ${esc(active.status)}">${esc(active.status)}</span>
      Line ${esc(String(Number(active.line)))} · O ${fmtOdds(priceOf(active, ov))} / U ${fmtOdds(priceOf(active, un))}<span class="go">View ›</span></button>`;
  } else if (mineProp) {
    action = `<p class="hint">This prop is about you. Someone else posts its lines.</p>`;
  } else {
    action = `<button class="btn primary" data-post-prop="${esc(pr.id)}">Post ${auto ? "auto " : ""}line</button>`;
  }
  return `<article class="prop card-ish">
    <div class="prop-top"><b>${esc(pr.stat)}</b><span class="prop-status">${status}</span></div>
    ${recent ? `<div class="results"><small>Recent</small>${recent}</div>` : ""}
    ${action}
  </article>`;
}

function openNewProp() {
  const people = [...state.members].sort((a, b) => a.username.localeCompare(b.username));
  let player = null;
  sheet(`<h4>New player prop</h4>
    <div class="f">Who's it about?<div class="chips hide-chips" id="np-people">${people.map(m =>
      `<button type="button" data-np-player="${esc(m.id)}" aria-pressed="false">${esc(m.id === uid() ? m.username + " (you)" : m.username)}</button>`).join("")}</div></div>
    <label class="f" for="np-stat">Stat<input class="inp" id="np-stat" maxlength="40" placeholder="Drinks"></label>
    <div class="chips close-chips">${["Drinks", "Shots", "Minutes late", "Points", "Texts sent"].map(x => `<button type="button" data-np-stat="${x}">${x}</button>`).join("")}</div>
    <span class="hint">Pick something you can count. The first ${AUTO_THRESHOLD} lines are set by hand, then the app takes over.</span>
    <div class="err" id="np-err"></div>
    <button class="btn primary big" id="np-save">Create prop</button>
    <button class="btn big" data-close>Cancel</button>`);
  document.querySelectorAll("[data-np-player]").forEach(btn => btn.onclick = () => {
    player = btn.dataset.npPlayer;
    document.querySelectorAll("[data-np-player]").forEach(x => x.setAttribute("aria-pressed", String(x === btn)));
  });
  document.querySelectorAll("[data-np-stat]").forEach(btn => btn.onclick = () => { $("#np-stat").value = btn.dataset.npStat; });
  $("#np-save").onclick = async () => {
    const stat = $("#np-stat").value.trim();
    if (!player) return ($("#np-err").textContent = "Pick who the prop is about.");
    if (!stat) return ($("#np-err").textContent = "Name the stat, like Drinks.");
    $("#np-save").disabled = true;
    const { error } = await sb.rpc("create_prop", { p_group: state.groupId, p_player: player, p_stat: stat });
    if (error) { $("#np-err").textContent = errMsg(error); $("#np-save").disabled = false; return; }
    closeSheet(); toast(`Prop created: ${nameOf(player)} · ${stat}`); loadGroupData();
  };
}

// Small time pickers that live inside a sheet (the form versions re-render the page).
function sheetTimePicker(id, presets, value, label) {
  return `<div class="chips close-chips">${presets.map(([k, l, v]) =>
      `<button type="button" data-sheet-time="${id}" data-v="${v}" aria-pressed="${value === v}">${l}</button>`).join("")}</div>
    <input class="inp num" type="datetime-local" id="${id}" value="${esc(value)}" aria-label="${label}">`;
}
function wireSheetTimePickers() {
  document.querySelectorAll("[data-sheet-time]").forEach(btn => btn.onclick = () => {
    $("#" + btn.dataset.sheetTime).value = btn.dataset.v;
    document.querySelectorAll(`[data-sheet-time="${btn.dataset.sheetTime}"]`).forEach(x => x.setAttribute("aria-pressed", String(x === btn)));
  });
}

async function openPostProp(propId) {
  const pr = state.props.find(p => p.id === propId); if (!pr) return;
  const { data: sug, error } = await sb.rpc("prop_suggestion", { p_prop: propId });
  if (error) return toast(errMsg(error));
  const others = state.members.filter(m => m.id !== uid()).sort((a, b) => a.username.localeCompare(b.username));
  const hidden = new Set();
  const lineBlock = sug.auto
    ? `<div class="auto-line"><small>Line set automatically</small>
        <b class="num">${esc(String(sug.line))}</b>
        <span class="num">Over ${fmtOdds(sug.over_odds)} · Under ${fmtOdds(sug.under_odds)}</span>
        <span class="hint">From ${nameOf(pr.player_id)}'s last ${sug.results} results (weighted average ${sug.mean}). Recent nights count more.</span></div>`
    : `<label class="f" for="pp-line">Line<input class="inp num" id="pp-line" inputmode="decimal" placeholder="3.5"><span class="hint">${sug.results} of ${sug.needed} results so far. After ${sug.needed}, lines set themselves.</span></label>
       <div class="orow two">
         <label class="f" for="pp-over">Over odds${oddsField("pp-over", "-110")}</label>
         <label class="f" for="pp-under">Under odds${oddsField("pp-under", "-110")}</label>
       </div>`;
  sheet(`<h4>Post a line</h4><b>${esc(nameOf(pr.player_id))} · ${esc(pr.stat)}</b>
    ${lineBlock}
    <div class="f">Starts${sheetTimePicker("pp-start", startPresets(), "", "Start date and time")}</div>
    <div class="f">Ends${sheetTimePicker("pp-end", closePresets(), toLocalInput(nextAtHour(2)), "End date and time")}<span class="hint">Odds follow the clock from start to end. Betting closes at the end.</span></div>
    ${others.length ? `<div class="f">Hide from (optional)<div class="chips hide-chips">${others.map(m =>
      `<button type="button" data-pp-hide="${esc(m.id)}" aria-pressed="false">${esc(m.username)}</button>`).join("")}</div></div>` : ""}
    <div class="err" id="pp-err"></div>
    <button class="btn primary big" id="pp-save">Post line</button>
    <button class="btn big" data-close>Cancel</button>`);
  wireSheetTimePickers();
  document.querySelectorAll("[data-pp-hide]").forEach(btn => btn.onclick = () => {
    const id = btn.dataset.ppHide; hidden.has(id) ? hidden.delete(id) : hidden.add(id);
    btn.setAttribute("aria-pressed", String(hidden.has(id)));
  });
  $("#pp-save").onclick = async () => {
    const err = $("#pp-err"), start = $("#pp-start").value, end = $("#pp-end").value;
    let line = null, ov = null, un = null;
    if (!sug.auto) {
      line = Number($("#pp-line").value);
      ov = Number(oddsValue("pp-over")); un = Number(oddsValue("pp-under"));
      if ($("#pp-line").value.trim() === "" || !Number.isFinite(line) || line < 0) return (err.textContent = "Set a line, like 3.5.");
      if (!validOdds(ov) || !validOdds(un)) return (err.textContent = "Odds need at least 100 (like −110 or +120). Tap ± to switch minus and plus.");
    }
    if (end && new Date(end) <= new Date()) return (err.textContent = "Pick an end time in the future.");
    if (start && end && new Date(start) >= new Date(end)) return (err.textContent = "The end has to be after the start.");
    $("#pp-save").disabled = true;
    const { error } = await sb.rpc("create_prop_bet", {
      p_prop: propId, p_line: line, p_over_odds: ov, p_under_odds: un,
      p_closes_at: end ? new Date(end).toISOString() : null, p_starts_at: start ? new Date(start).toISOString() : null,
      p_hidden: [...hidden] });
    if (error) { err.textContent = errMsg(error); $("#pp-save").disabled = false; return; }
    closeSheet(); toast("Line posted"); state.tab = "board"; state.filter = "open"; loadGroupData();
  };
}

function slipHTML() {
  const s = myStats();
  const ws = state.wagers.filter(w => w.user_id === uid()).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const stats = `<div class="stats">
    <div class="stat"><small>Balance</small><b class="num">${fmtTok(s.bal)}</b></div>
    <div class="stat"><small>At risk</small><b class="num">${fmtTok(s.risk)}</b></div>
    <div class="stat"><small>Record</small><b class="num">${s.won}–${s.lost}</b></div></div>`;
  if (!ws.length) return `<h2>My slip</h2>${stats}<div class="empty"><b>No wagers yet</b>Tap any odds on the board to bet.</div>`;
  return `<h2>My slip</h2>${stats}<div class="list">${ws.map(w => {
    const b = betById(w.bet_id); const o = b?.outcomes.find(x => x.id === w.outcome_id);
    let right, status;
    if (w.payout == null) { status = "pending"; right = `<span>to win ${fmtTok(returns(w.stake, w.odds) - w.stake)}</span>`; }
    else if (b?.status === "void") { status = "voided"; right = `<span>refunded</span>`; }
    else if (w.payout === w.stake) { status = "push"; right = `<span>refunded</span>`; }
    else if (w.payout > 0) { status = "won"; right = `<span class="pos">+${fmtTok(w.payout - w.stake)}</span>`; }
    else { status = "lost"; right = `<span class="neg">−${fmtTok(w.stake)}</span>`; }
    return `<div class="row"><div class="main"><div class="t">${esc(w.line != null ? `${sideLabel(w.side)} ${Number(w.line)}` : o?.label || "Outcome")}${w.line != null ? ` <span class="alt-tag">alt line</span>` : ""} <span class="num" style="color:var(--felt)">${fmtOdds(w.odds)}</span></div>
      <div class="s">${esc(b?.title || "Bet")} · ${fmtTok(w.stake)} staked · ${status}</div></div><div class="amt num">${right}</div></div>`;
  }).join("")}</div>`;
}

function leadersHTML() {
  const g = group();
  const rows = [...state.members].sort((a, b) => b.balance - a.balance);
  const invite = g ? `<div class="invite"><div><small>Invite code</small><b>${esc(g.invite_code)}</b></div>
    <button class="btn" id="copyCode">Copy</button></div>` : "";
  return `<h2>Leaderboard</h2>${invite}<div class="list">${rows.map((r, i) => {
    const rec = recordOf(r.id);
    return `<div class="row"><div class="rank num">${i + 1}</div><div class="initial">${esc((r.username[0] || "?").toUpperCase())}</div>
      <div class="main"><div class="t">${esc(r.id === uid() ? r.username + " (you)" : r.username)}</div><div class="s num">${rec.won}–${rec.lost} · ${fmtTok(rec.risk)} at risk</div></div>
      <div class="amt num">${fmtTok(r.balance)}</div></div>`;
  }).join("")}</div>`;
}

/* ---------------- sheets ---------------- */

function sheet(html) {
  $("#sheetHost").innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  $("#scrim").addEventListener("click", e => { if (e.target.id === "scrim" || e.target.closest("[data-close]")) closeSheet(); });
}
function closeSheet() { $("#sheetHost").innerHTML = ""; }

function openWager(betId, outId) {
  const b = betById(betId); const o = b?.outcomes.find(x => x.id === outId);
  if (!b || !o) return;
  const bal = myStats().bal;
  const ou = b.line != null && b.outcomes.length === 2;
  const main = Number(b.line);
  const minLine = Number(b.live_current ?? 0);          // a line must sit above the count so far
  const maxLine = main * 4 + 20;
  let side = o.position === 0 ? "over" : "under", line = main;
  const outcomeFor = sd => b.outcomes[sd === "over" ? 0 : 1];
  const price = () => !ou ? priceOf(b, o) : priceOU(b, line, side);
  const label = () => !ou ? o.label : line === main ? outcomeFor(side).label : `${sideLabel(side)} ${line}`;

  sheet(`<h4>${esc(b.title)}</h4>
    ${ou ? `<div class="seg" role="group" aria-label="Side"><button type="button" data-side="over">Over</button><button type="button" data-side="under">Under</button></div>
      <div class="f">Your line
        <div class="stepper"><button type="button" id="w-down" aria-label="Lower line">−</button><div class="lineval num" id="w-line"></div><button type="button" id="w-up" aria-label="Raise line">+</button></div>
        <button type="button" class="btn link" id="w-main" hidden>Back to the main line (${esc(b.line)})</button>
      </div>` : ""}
    <div class="pick"><b id="w-label"></b><span class="odds num" id="w-odds"></span></div>
    <label class="f" for="stake">Stake · ${fmtTok(bal)} available<input class="inp num" id="stake" inputmode="numeric" placeholder="0" autocomplete="off"></label>
    <div class="chips">${[10, 50, 100, 250].map(v => `<button data-chip="${v}">${v}</button>`).join("")}<button data-chip="${Math.floor(bal)}">All in</button></div>
    <div class="payout"><span>Returns</span><b class="num" id="ret">0</b></div>
    <div class="err" id="s-err"></div>
    <button class="btn primary big" id="place">Place wager</button>
    <button class="btn big" data-close>Cancel</button>`);

  const input = $("#stake");
  const paint = () => {
    const odds = price();
    $("#w-label").textContent = label();
    $("#w-odds").textContent = fmtOdds(odds);
    const v = Math.floor(Number(input.value) || 0);
    $("#ret").textContent = fmtTok(v > 0 ? returns(v, odds) : 0);
    if (ou) {
      $("#w-line").textContent = line;
      $("#w-main").hidden = line === main;
      $("#w-down").disabled = lineDown(line) <= minLine;
      $("#w-up").disabled = lineUp(line) > maxLine;
      document.querySelectorAll("[data-side]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.side === side)));
    }
  };
  if (ou) {
    document.querySelectorAll("[data-side]").forEach(x => x.onclick = () => { side = x.dataset.side; paint(); });
    $("#w-down").onclick = () => { line = lineDown(line); paint(); };
    $("#w-up").onclick = () => { line = lineUp(line); paint(); };
    $("#w-main").onclick = () => { line = main; paint(); };
  }
  input.addEventListener("input", paint);
  document.querySelectorAll("[data-chip]").forEach(c => c.onclick = () => { input.value = c.dataset.chip; paint(); });
  paint();

  $("#place").onclick = async () => {
    const stake = Math.floor(Number(input.value) || 0);
    if (stake < 1) return ($("#s-err").textContent = "Enter at least 1 token.");
    const odds = price(), what = label();
    $("#place").disabled = true;
    const { error } = !ou || line === main
      ? await sb.rpc("place_wager", { p_outcome: (ou ? outcomeFor(side) : o).id, p_stake: stake, p_expected_odds: odds })
      : await sb.rpc("place_alt_wager", { p_bet: b.id, p_side: side, p_line: line, p_stake: stake, p_expected_odds: odds });
    if (error) {
      const msg = errMsg(error);
      if (msg.startsWith("Odds moved")) { closeSheet(); toast(msg); return loadGroupData(); }
      $("#s-err").textContent = msg; $("#place").disabled = false; return;
    }
    closeSheet(); toast(`Bet ${fmtTok(stake)} on ${what} at ${fmtOdds(odds)}`); loadGroupData();
  };
  input.focus();
}

function openLive(betId) {
  const b = betById(betId); if (!b) return;
  const line = Number(b.line);
  if (!b.closes_at) return toast("Give this bet an end time first (End time button) so the odds can follow the clock.");
  if (!hasStarted(b)) return toast(`This starts ${fmtClose(b.starts_at || b.created_at)}. Count updates open then.`);
  const pct = Math.round(progressAt(b) * 100);
  sheet(`<h4>Live count: ${esc(b.title)}</h4>
    <div class="f">Count so far · line ${esc(b.line)}
      <div class="stepper"><button type="button" id="l-minus" aria-label="Decrease count">−</button>
        <input class="inp num" id="l-cur" inputmode="decimal" value="${Number(b.live_current ?? 0)}">
        <button type="button" id="l-plus" aria-label="Increase count">+</button></div></div>
    <span class="hint">${pct}% through by the clock (start ${esc(fmtClose(b.starts_at || b.created_at))}, end ${esc(fmtClose(b.closes_at))}). The odds keep moving with the clock on their own.</span>
    <div class="quote">
      <div><small>${esc(b.outcomes[0].label)}</small><b class="num" id="q-over"></b><span class="num" id="q-over-was"></span></div>
      <div><small>${esc(b.outcomes[1].label)}</small><b class="num" id="q-under"></b><span class="num" id="q-under-was"></span></div>
    </div>
    <span class="hint" id="l-note"></span>
    <div class="err" id="l-err"></div>
    <button class="btn primary big" id="l-save">Update count</button>
    <button class="btn big" data-close>Cancel</button>`);
  const curEl = $("#l-cur");
  const read = () => Math.max(0, Number(curEl.value) || 0);
  const paint = () => {
    const c = read(), preview = { ...b, live_current: c };
    $("#q-over").textContent = fmtOdds(priceOU(preview, line, "over"));
    $("#q-under").textContent = fmtOdds(priceOU(preview, line, "under"));
    $("#q-over-was").textContent = "now " + fmtOdds(priceOf(b, b.outcomes[0]));
    $("#q-under-was").textContent = "now " + fmtOdds(priceOf(b, b.outcomes[1]));
    $("#l-note").textContent = c > line ? "Over has hit. Saving locks the bet so you can settle it." : "Wagers already placed keep their odds.";
  };
  $("#l-minus").onclick = () => { curEl.value = Math.max(0, (Number(curEl.value) || 0) - 1); paint(); };
  $("#l-plus").onclick = () => { curEl.value = (Number(curEl.value) || 0) + 1; paint(); };
  curEl.addEventListener("input", paint);
  paint();
  $("#l-save").onclick = async () => {
    $("#l-save").disabled = true;
    const { data, error } = await sb.rpc("update_live_count", { p_bet: betId, p_current: read() });
    if (error) { $("#l-err").textContent = errMsg(error); $("#l-save").disabled = false; return; }
    closeSheet();
    toast(data?.status === "locked" && b.status === "open" ? "Over has hit, so the bet is locked. Settle it when ready." : "Count updated");
    loadGroupData();
  };
}

function openCloseTime(betId) {
  const b = betById(betId); if (!b) return;
  const cur = b.closes_at ? toLocalInput(new Date(b.closes_at)) : "";
  sheet(`<h4>End time: ${esc(b.title)}</h4>
    <div class="f">Ends${closePicker("t", cur)}<span class="hint">Your local time. Clear it for no end time.</span></div>
    <div class="err" id="t-err"></div>
    <button class="btn primary big" id="t-save">Save end time</button>
    <button class="btn big" data-close>Cancel</button>`);
  document.querySelectorAll('[data-close-preset="t"]').forEach(btn => btn.onclick = () => {
    $("#t-at").value = btn.dataset.v;
    document.querySelectorAll('[data-close-preset="t"]').forEach(x => x.setAttribute("aria-pressed", String(x === btn)));
  });
  $("#t-save").onclick = async () => {
    const v = $("#t-at").value;
    if (v && new Date(v) <= new Date()) return ($("#t-err").textContent = "Pick a closing time in the future.");
    $("#t-save").disabled = true;
    const { error } = await sb.rpc("set_bet_close", { p_bet: betId, p_closes_at: v ? new Date(v).toISOString() : null });
    if (error) { $("#t-err").textContent = errMsg(error); $("#t-save").disabled = false; return; }
    closeSheet();
    toast(v ? `Betting now closes ${fmtClose(new Date(v).toISOString())}${b.status === "locked" ? ". Tap Reopen to take wagers again." : ""}` : "Closing time removed");
    loadGroupData();
  };
}

function openSettle(betId) {
  const b = betById(betId); if (!b) return;
  if (b.line != null) return openSettleCount(b);
  sheet(`<h4>Settle: ${esc(b.title)}</h4><b>Which outcome hit?</b>
    <div class="list" style="gap:8px">${b.outcomes.map(o => `<button class="btn big" data-win="${esc(o.id)}">${esc(o.label)}</button>`).join("")}</div>
    <div class="err" id="st-err"></div>
    <button class="btn big" data-close>Cancel</button>`);
  document.querySelectorAll("[data-win]").forEach(btn => btn.onclick = async () => {
    btn.disabled = true;
    const { error } = await sb.rpc("settle_bet", { p_bet: betId, p_winner: btn.dataset.win });
    if (error) { $("#st-err").textContent = errMsg(error); btn.disabled = false; return; }
    closeSheet(); toast("Settled. Winners are paid."); loadGroupData();
  });
}

function openSettleCount(b) {
  const line = Number(b.line);
  const alts = state.wagers.filter(w => w.bet_id === b.id && w.line != null).length;
  sheet(`<h4>Settle: ${esc(b.title)}</h4><b>What was the final count?</b>
    <div class="stepper"><button type="button" id="f-minus" aria-label="Decrease">−</button>
      <input class="inp num" id="f-val" inputmode="decimal" value="${esc(String(Number(b.live_current ?? 0)))}">
      <button type="button" id="f-plus" aria-label="Increase">+</button></div>
    <span class="hint" id="f-note"></span>
    <div class="err" id="f-err"></div>
    <button class="btn primary big" id="f-save">Settle at this count</button>
    <button class="btn big" data-close>Cancel</button>`);
  const el = $("#f-val");
  const paint = () => {
    const v = Number(el.value);
    const main = !Number.isFinite(v) ? "" : v > line ? `Over ${line} wins.` : v < line ? `Under ${line} wins.` : `Exactly ${line}: main-line bets push and get refunded.`;
    $("#f-note").textContent = `${main}${alts ? ` ${alts} alternate-line ${alts === 1 ? "wager is" : "wagers are"} graded on ${alts === 1 ? "its" : "their"} own line.` : ""}`;
  };
  $("#f-minus").onclick = () => { el.value = Math.max(0, (Number(el.value) || 0) - 1); paint(); };
  $("#f-plus").onclick = () => { el.value = (Number(el.value) || 0) + 1; paint(); };
  el.addEventListener("input", paint); paint();
  $("#f-save").onclick = async () => {
    const v = Number(el.value);
    if (el.value.trim() === "" || !Number.isFinite(v) || v < 0) return ($("#f-err").textContent = "Enter the final count.");
    $("#f-save").disabled = true;
    const { error } = await sb.rpc("settle_ou", { p_bet: b.id, p_final: v });
    if (error) { $("#f-err").textContent = errMsg(error); $("#f-save").disabled = false; return; }
    closeSheet(); toast(`Settled at ${v}. Winners are paid.`); loadGroupData();
  };
}

function openVoid(betId) {
  const b = betById(betId); if (!b) return;
  sheet(`<h4>Void bet</h4><b>${esc(b.title)}</b>
    <span class="hint">Every stake on this bet is refunded and the bet closes for good.</span>
    <div class="err" id="v-err"></div>
    <button class="btn big danger" id="confirmVoid">Void and refund</button>
    <button class="btn big" data-close>Keep it</button>`);
  $("#confirmVoid").onclick = async () => {
    const { error } = await sb.rpc("void_bet", { p_bet: betId });
    if (error) return ($("#v-err").textContent = errMsg(error));
    closeSheet(); toast("Voided. Stakes refunded."); loadGroupData();
  };
}

function openGroups() {
  sheet(`<h4>Your groups</h4>
    <div class="list" style="gap:8px">${state.groups.map(g => `
      <button class="row ${g.id === state.groupId ? "current" : ""}" data-group="${esc(g.id)}" style="text-align:left">
        <div class="main"><div class="t">${esc(g.name)}</div><div class="s">Code ${esc(g.invite_code)}</div></div></button>`).join("")}</div>
    <div class="divider">add a group</div>
    ${joinCreateForms()}
    <button class="btn link" id="signOut">Sign out</button>`);
  document.querySelectorAll("[data-group]").forEach(b => b.onclick = () => { closeSheet(); openGroup(b.dataset.group); });
}

/* ---------------- events ---------------- */

function syncDraft() {
  const d = state.draft, v = id => document.getElementById(id)?.value;
  for (const [id, key] of [["c-title", "title"], ["c-detail", "detail"], ["c-line", "line"]])
    if (v(id) !== undefined) d[key] = v(id);
  if (oddsValue("c-over") !== undefined) d.overOdds = oddsValue("c-over");
  if (oddsValue("c-under") !== undefined) d.underOdds = oddsValue("c-under");
  if (document.getElementById("c-at")) d.closesAt = document.getElementById("c-at").value;
  if (document.getElementById("c-start")) d.startsAt = document.getElementById("c-start").value;
  document.querySelectorAll("[data-ol]").forEach(el => d.outcomes[+el.dataset.ol].label = el.value);
  document.querySelectorAll("[data-oo]").forEach(el => d.outcomes[+el.dataset.oo].odds = oddsValue(el.id));
}

$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  if (state.tab === "create") syncDraft();
  state.tab = b.dataset.tab; window.scrollTo(0, 0); render();
});
$("#groupBtn").addEventListener("click", openGroups);
$("#app").addEventListener("input", e => { if (state.tab === "create" && e.target.closest("#createForm")) syncDraft(); });

document.addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.id === "signOut") { closeSheet(); await sb.auth.signOut(); return; }
  if (t.id === "a-toggle") { state.authMode = state.authMode === "signup" ? "signin" : "signup"; return render(); }
  if (t.id === "copyCode") {
    const code = group()?.invite_code || "";
    try { await navigator.clipboard.writeText(code); toast("Invite code copied"); } catch { toast(`Code: ${code}`); }
    return;
  }
  if (t.id === "newProp") return openNewProp();
  if (t.dataset.postProp) return openPostProp(t.dataset.postProp);
  if (t.dataset.gotoBet) {
    const b = betById(t.dataset.gotoBet);
    state.tab = "board"; state.filter = b?.status === "locked" ? "locked" : "open"; render();
    setTimeout(() => document.querySelector(`[data-bet-card="${t.dataset.gotoBet}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    return;
  }
  if (t.dataset.signFor) {
    const neg = t.textContent.trim().startsWith("−");
    t.innerHTML = `${neg ? "+" : "−"}<small>±</small>`;
    syncDraft();
    return;
  }
  if (!t.closest("#app")) return;
  if (t.dataset.filter) { state.filter = t.dataset.filter; return render(); }
  if (t.dataset.startPreset === "c") { syncDraft(); state.draft.startsAt = t.dataset.v; return render(); }
  if (t.dataset.closePreset === "c") { syncDraft(); state.draft.closesAt = t.dataset.v; return render(); }
  if (t.dataset.hide) {
    syncDraft();
    const h = state.draft.hidden, id = t.dataset.hide;
    state.draft.hidden = h.includes(id) ? h.filter(x => x !== id) : [...h, id];
    return render();
  }
  if (t.dataset.type) { syncDraft(); state.draft.type = t.dataset.type; return render(); }
  if (t.id === "c-add") { syncDraft(); state.draft.outcomes.push({ label: "", odds: "+100" }); return render(); }
  if (t.dataset.rm) { syncDraft(); state.draft.outcomes.splice(+t.dataset.rm, 1); return render(); }
  if (t.dataset.out && !t.disabled) return openWager(t.dataset.bet, t.dataset.out);
  if (t.dataset.act === "settle") return openSettle(t.dataset.bet);
  if (t.dataset.act === "live") return openLive(t.dataset.bet);
  if (t.dataset.act === "closetime") return openCloseTime(t.dataset.bet);
  if (t.dataset.act === "void") return openVoid(t.dataset.bet);
  if (t.dataset.act === "lock" || t.dataset.act === "reopen") {
    const { error } = await sb.rpc("set_bet_status", { p_bet: t.dataset.bet, p_status: t.dataset.act === "lock" ? "locked" : "open" });
    if (error) return toast(errMsg(error));
    toast(t.dataset.act === "lock" ? "Locked. No more wagers." : "Reopened."); loadGroupData();
  }
});

document.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector("button[type=submit]");
  const busy = on => { if (btn) btn.disabled = on; };

  if (f.id === "authForm") {
    const email = $("#a-email").value.trim(), password = $("#a-pass").value, err = $("#a-err");
    busy(true); err.textContent = "";
    if (state.authMode === "signup") {
      const username = $("#a-user").value.trim();
      if (!/^[A-Za-z0-9_]{2,20}$/.test(username)) { busy(false); return (err.textContent = "Username: 2–20 letters, numbers, or underscores."); }
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
      busy(false);
      if (error) return (err.textContent = errMsg(error));
      if (!data.session) { err.className = "ok"; err.textContent = "Check your email for a confirmation link, then sign in."; state.authMode = "signin"; }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      busy(false);
      if (error) err.textContent = errMsg(error);
    }
    return;
  }

  if (f.id === "joinForm") {
    const err = f.querySelector(".err"); busy(true);
    const { data, error } = await sb.rpc("join_group", { p_code: f.querySelector("#j-code").value });
    busy(false);
    if (error) return (err.textContent = errMsg(error));
    closeSheet(); store.set("hl-group", data.id); toast(`Joined ${data.name}`); return loadGroups();
  }

  if (f.id === "newGroupForm") {
    const err = f.querySelector(".err"); busy(true);
    const { data, error } = await sb.rpc("create_group", { p_name: f.querySelector("#g-name").value });
    busy(false);
    if (error) return (err.textContent = errMsg(error));
    closeSheet(); store.set("hl-group", data.id); toast(`Created ${data.name}. Share code ${data.invite_code}`); return loadGroups();
  }

  if (f.id === "createForm") {
    syncDraft();
    const d = state.draft, err = $("#c-err");
    const title = d.title.trim();
    if (!title) return (err.textContent = "Give the bet a name.");
    let outcomes, line = null;
    if (d.type === "ou") {
      const L = Number(d.line), ov = Number(d.overOdds), un = Number(d.underOdds);
      if (!d.line.trim() || !Number.isFinite(L)) return (err.textContent = "Set a number for the line, like 12.5.");
      if (!validOdds(ov) || !validOdds(un)) return (err.textContent = "Odds need at least 100 (like −110 or +120). Tap ± to switch minus and plus.");
      line = L;
      outcomes = [{ label: `Over ${L}`, odds: ov }, { label: `Under ${L}`, odds: un }];
    } else {
      outcomes = d.outcomes.map(o => ({ label: o.label.trim(), odds: Number(o.odds) }));
      if (outcomes.some(o => !o.label)) return (err.textContent = "Every outcome needs a name.");
      if (outcomes.some(o => !validOdds(o.odds))) return (err.textContent = "Odds need at least 100 (like −110 or +250). Tap ± to switch minus and plus.");
    }
    if (d.closesAt && new Date(d.closesAt) <= new Date()) return (err.textContent = "Pick an end time in the future.");
    if (d.startsAt && d.closesAt && new Date(d.startsAt) >= new Date(d.closesAt)) return (err.textContent = "The end has to be after the start.");
    busy(true);
    const { error } = await sb.rpc("create_bet", { p_group: state.groupId, p_title: title, p_detail: d.detail.trim(), p_line: line, p_outcomes: outcomes, p_hidden: d.hidden, p_closes_at: d.closesAt ? new Date(d.closesAt).toISOString() : null, p_starts_at: d.startsAt ? new Date(d.startsAt).toISOString() : null });
    busy(false);
    if (error) return (err.textContent = errMsg(error));
    state.draft = { ...blankDraft(), type: d.type };
    state.tab = "board"; state.filter = "open"; toast("Bet posted"); loadGroupData();
  }
});

/* ---------------- boot ---------------- */

// Keep countdowns current, and disable betting the moment a bet's time passes.
setInterval(() => {
  if (state.tab === "board" && !$("#sheetHost").children.length && state.bets.some(b => b.closes_at && b.status === "open")) render();
}, 30000);

render();
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    const was = uid();
    state.session = session;
    if (!session) {
      if (state.channel) sb.removeChannel(state.channel);
      Object.assign(state, { groups: [], groupId: null, bets: [], wagers: [], members: [], channel: null });
      return render();
    }
    if (session.user.id !== was) setTimeout(loadGroups, 0); // defer: don't query inside the auth callback
  });
}
