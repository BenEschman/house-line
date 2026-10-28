// House Line — client. Reads go straight to Supabase tables (row-level security
// limits them to your groups); every write is an RPC defined in supabase/schema.sql.

const cfg = window.HOUSE_LINE_CONFIG || {};
const configured = cfg.supabaseUrl && !cfg.supabaseUrl.includes("YOUR-PROJECT") && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.includes("YOUR-");
const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

const blankDraft = () => ({ type: "ou", title: "", detail: "", line: "", overOdds: "-110", underOdds: "-110",
  outcomes: [{ label: "", odds: "+100" }, { label: "", odds: "+100" }], hidden: [], closesAt: "", startsAt: "" });

const state = {
  session: null, groups: [], groupId: null,
  bets: [], wagers: [], members: [], hidden: {}, props: [], propStat: "", propPlayer: "", loaded: false,
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
    .select("group_id, groups(id, name, invite_code, owner_id, starting_balance)").eq("user_id", uid());
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
    sb.from("memberships").select("user_id, balance, profiles(username, avatar)").eq("group_id", gid),
    sb.from("bet_hidden").select("bet_id, user_id").eq("group_id", gid),
    sb.from("props").select("*").eq("group_id", gid).order("created_at"),
  ]);
  if (gid !== state.groupId) return;
  const err = bets.error || wagers.error || members.error;
  if (err) toast(errMsg(err));
  state.bets = (bets.data || []).map(b => ({ ...b, outcomes: (b.outcomes || []).sort((x, y) => x.position - y.position) }));
  state.wagers = wagers.data || [];
  state.members = (members.data || []).map(m => ({ id: m.user_id, balance: Number(m.balance), username: m.profiles?.username || "player", avatar: m.profiles?.avatar || null }));
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
  for (const table of ["bets", "outcomes", "wagers", "memberships", "bet_hidden", "props", "profiles"])
    ch.on("postgres_changes", table === "profiles" ? { event: "*", schema: "public", table } : { event: "*", schema: "public", table, filter: `group_id=eq.${gid}` }, scheduleReload);
  ch.subscribe();
  state.channel = ch;
}
// Catch up after the phone wakes or the tab comes back.
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.groupId) loadGroupData(); });

/* ---------------- derived ---------------- */

const me = () => state.members.find(m => m.id === uid());
const userOf = id => state.members.find(m => m.id === id);
const usernameOf = id => userOf(id)?.username || "player";
// Profile photo, or a colored initial when there isn't one. size in px.
function avatarHTML(id, size = 34) {
  const u = userOf(id), name = u?.username || "?";
  if (u?.avatar) return `<img class="av" src="${esc(u.avatar)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`;
  return `<span class="av initial" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc((name[0] || "?").toUpperCase())}</span>`;
}
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
  $("#meAvatar").innerHTML = avatarHTML(uid(), 34);
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-current", String(b.dataset.tab === state.tab)));
  app.innerHTML = { board: boardHTML, create: createHTML, props: propsHTML, slip: slipHTML, leaders: leadersHTML, settings: settingsHTML, profile: profileHTML }[state.tab]();
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
      <div class="bet-meta">${avatarHTML(b.creator_id, 18)}<span>${esc(nameOf(b.creator_id))}${b.line != null ? ` · line ${esc(b.line)}` : ""}</span><span class="pill ${esc(b.status)}">${esc(b.status)}</span></div>
      <h3>${esc(prop ? `${usernameOf(prop.player_id)} · ${prop.stat}` : b.title)}</h3>
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
function statGroups() {
  const by = {};
  for (const pr of state.props) (by[pr.stat.toLowerCase()] ||= { stat: pr.stat, props: [] }).props.push(pr);
  return Object.values(by).sort((a, b) => a.stat.localeCompare(b.stat));
}

function propsHTML() {
  const head = `<div class="props-head"><h2>Player props</h2><button class="btn primary" id="newStat">+ New stat line</button></div>`;
  if (!state.loaded) return head + `<div class="empty"><b>Loading…</b></div>`;
  const stats = statGroups();
  if (!stats.length) return head + `<div class="empty"><b>No stat lines yet</b>Add one, like Drinks or Shots, and everyone in the group gets a line for it. Set the first ${AUTO_THRESHOLD} lines yourself. After that, each player's line sets itself from their results.</div>`;
  // Sticky filter bar: jump straight to a stat and/or a player.
  if (state.propStat && !stats.some(sg => sg.stat.toLowerCase() === state.propStat)) state.propStat = "";
  const players = [...new Set(state.props.map(p => p.player_id))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  if (state.propPlayer && !players.includes(state.propPlayer)) state.propPlayer = "";
  const chip = (attr, val, label, on) => `<button type="button" ${attr}="${esc(val)}" aria-pressed="${on}">${esc(label)}</button>`;
  const bar = `<div class="prop-filter">
    <div class="chips">${chip("data-pf-stat", "", "All stats", !state.propStat)}${stats.map(sg => chip("data-pf-stat", sg.stat.toLowerCase(), sg.stat, state.propStat === sg.stat.toLowerCase())).join("")}</div>
    <div class="chips">${chip("data-pf-player", "", "Everyone", !state.propPlayer)}${players.map(id => chip("data-pf-player", id, id === uid() ? "You" : nameOf(id), state.propPlayer === id)).join("")}</div>
  </div>`;
  const shown = stats.filter(sg => !state.propStat || sg.stat.toLowerCase() === state.propStat);
  return head + bar + shown.map(sg => {
    const rows = [...sg.props].filter(pr => !state.propPlayer || pr.player_id === state.propPlayer)
      .sort((x, y) => nameOf(x.player_id).localeCompare(nameOf(y.player_id)));
    if (!rows.length) return "";
    const autoCount = rows.filter(pr => propHistory(pr).length >= AUTO_THRESHOLD).length;
    const openSlots = rows.filter(pr => !propActive(pr)).length;
    return `<section class="stat-block">
      <div class="stat-head">
        <div><h3>${esc(sg.stat)}</h3><span class="prop-status">${rows.length} players · ${autoCount} auto · ${rows.length - autoCount} set by hand</span></div>
        <button class="btn primary" data-post-stat="${esc(sg.stat)}" data-post-only="${esc(state.propPlayer)}" ${openSlots ? "" : "disabled"}>${openSlots ? "Post lines" : "All lines up"}</button>
      </div>
      <div class="stat-rows">${rows.map(propRow).join("")}</div>
    </section>`;
  }).join("");
}

function propRow(pr) {
  const hist = propHistory(pr), active = propActive(pr), n = hist.length;
  const recent = hist.slice(0, 5).map(b => `<span class="res num">${esc(String(Number(b.final_value)))}</span>`).join("");
  const right = active
    ? `<button class="prop-live" data-goto-bet="${esc(active.id)}"><span class="num">${esc(String(Number(active.line)))}</span><span class="go">›</span></button>`
    : n >= AUTO_THRESHOLD ? `<span class="alt-tag">auto</span>` : `<span class="prop-status num">${n}/${AUTO_THRESHOLD}</span>`;
  return `<div class="stat-row">
    ${avatarHTML(pr.player_id, 30)}
    <div class="who"><b>${esc(pr.player_id === uid() ? "You" : nameOf(pr.player_id))}</b>${recent ? `<div class="results">${recent}</div>` : `<span class="prop-status">No results yet</span>`}</div>
    ${right}
  </div>`;
}

function openNewStat() {
  sheet(`<h4>New stat line</h4><b>Everyone in the group gets a line for it.</b>
    <label class="f" for="ns-stat">Stat<input class="inp" id="ns-stat" maxlength="40" placeholder="Drinks"></label>
    <div class="chips close-chips">${["Drinks", "Shots", "Minutes late", "Points", "Texts sent"].map(x => `<button type="button" data-ns-stat="${x}">${x}</button>`).join("")}</div>
    <span class="hint">Pick something you can count. People who join later get it too.</span>
    <div class="err" id="ns-err"></div>
    <button class="btn primary big" id="ns-save">Add stat line</button>
    <button class="btn big" data-close>Cancel</button>`);
  document.querySelectorAll("[data-ns-stat]").forEach(btn => btn.onclick = () => { $("#ns-stat").value = btn.dataset.nsStat; });
  $("#ns-save").onclick = async () => {
    const stat = $("#ns-stat").value.trim();
    if (!stat) return ($("#ns-err").textContent = "Name the stat, like Drinks.");
    $("#ns-save").disabled = true;
    const { data, error } = await sb.rpc("create_prop_stat", { p_group: state.groupId, p_stat: stat });
    if (error) { $("#ns-err").textContent = errMsg(error); $("#ns-save").disabled = false; return; }
    closeSheet(); toast(data ? `${stat} added for ${data} ${data === 1 ? "player" : "players"}` : `Everyone already has ${stat}`); loadGroupData();
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

async function openPostSlate(stat, onlyPlayer = "") {
  const { data: slate, error } = await sb.rpc("prop_slate", { p_group: state.groupId, p_stat: stat });
  if (error) return toast(errMsg(error));
  const others = state.members.filter(m => m.id !== uid()).sort((a, b) => a.username.localeCompare(b.username));
  const hidden = new Set(), include = new Set();
  const rows = slate.map(r => {
    const name = r.player_id === uid() ? "You" : r.username, sug = r.suggestion;
    if (r.active_bet) return `<div class="slate-row off"><b>${esc(name)}</b><span class="prop-status">Line already up</span></div>`;
    if (!sug.auto && r.player_id === uid()) return `<div class="slate-row off"><b>You</b><span class="prop-status">Someone else sets your line until it's auto (${sug.results}/${sug.needed})</span></div>`;
    const on = !onlyPlayer || r.player_id === onlyPlayer;
    if (on) include.add(r.prop_id);
    const toggle = `<button type="button" class="incl" data-incl="${esc(r.prop_id)}" aria-pressed="${on}" aria-label="Include ${esc(name)}">✓</button>`;
    if (sug.auto) return `<div class="slate-row auto${on ? "" : " skipped"}" data-row="${esc(r.prop_id)}">${toggle}<b>${esc(name)}</b>
      <div class="auto-mini"><span class="alt-tag">auto</span><b class="num">${esc(String(sug.line))}</b><span class="num">O ${fmtOdds(sug.over_odds)} · U ${fmtOdds(sug.under_odds)}</span></div></div>`;
    return `<div class="slate-row manual${on ? "" : " skipped"}" data-row="${esc(r.prop_id)}">${toggle}<b>${esc(name)}<small class="prop-status"> ${sug.results}/${sug.needed} results</small></b>
      <div class="manual-inputs">
        <label class="f" for="sl-line-${esc(r.prop_id)}">Line<input class="inp num" id="sl-line-${esc(r.prop_id)}" inputmode="decimal" placeholder="3.5"></label>
        <label class="f" for="sl-over-${esc(r.prop_id)}">Over${oddsField(`sl-over-${r.prop_id}`, "-110")}</label>
        <label class="f" for="sl-under-${esc(r.prop_id)}">Under${oddsField(`sl-under-${r.prop_id}`, "-110")}</label>
      </div></div>`;
  }).join("");
  sheet(`<h4>Post lines</h4><b>${esc(stat)}</b>
    <div class="slate">${rows}</div>
    <div class="f">Starts${sheetTimePicker("sl-start", startPresets(), "", "Start date and time")}</div>
    <div class="f">Ends${sheetTimePicker("sl-end", closePresets(), toLocalInput(nextAtHour(2)), "End date and time")}<span class="hint">One start and end for every line here. Odds follow the clock in between.</span></div>
    ${others.length ? `<div class="f">Hide from (optional)<div class="chips hide-chips">${others.map(m =>
      `<button type="button" data-sl-hide="${esc(m.id)}" aria-pressed="false">${esc(m.username)}</button>`).join("")}</div></div>` : ""}
    <div class="err" id="sl-err"></div>
    <button class="btn primary big" id="sl-save">Post lines</button>
    <button class="btn big" data-close>Cancel</button>`);
  wireSheetTimePickers();
  const countLabel = () => { const n = include.size; $("#sl-save").textContent = n ? `Post ${n} ${n === 1 ? "line" : "lines"}` : "Pick at least one player"; $("#sl-save").disabled = !n; };
  document.querySelectorAll("[data-incl]").forEach(btn => btn.onclick = () => {
    const id = btn.dataset.incl; include.has(id) ? include.delete(id) : include.add(id);
    btn.setAttribute("aria-pressed", String(include.has(id)));
    document.querySelector(`[data-row="${id}"]`)?.classList.toggle("skipped", !include.has(id));
    countLabel();
  });
  document.querySelectorAll("[data-sl-hide]").forEach(btn => btn.onclick = () => {
    const id = btn.dataset.slHide; hidden.has(id) ? hidden.delete(id) : hidden.add(id);
    btn.setAttribute("aria-pressed", String(hidden.has(id)));
  });
  countLabel();
  $("#sl-save").onclick = async () => {
    const err = $("#sl-err"), start = $("#sl-start").value, end = $("#sl-end").value;
    const lines = [];
    for (const r of slate) {
      if (!include.has(r.prop_id)) continue;
      if (r.suggestion.auto) { lines.push({ prop_id: r.prop_id }); continue; }
      const lv = $(`#sl-line-${r.prop_id}`).value.trim(), line = Number(lv);
      const ov = Number(oddsValue(`sl-over-${r.prop_id}`)), un = Number(oddsValue(`sl-under-${r.prop_id}`));
      const who = r.player_id === uid() ? "your" : `${r.username}'s`;
      if (lv === "" || !Number.isFinite(line) || line < 0) return (err.textContent = `Set ${who} line, like 3.5, or uncheck them.`);
      if (!validOdds(ov) || !validOdds(un)) return (err.textContent = `${who[0].toUpperCase() + who.slice(1)} odds need at least 100 (like −110). Tap ± to switch minus and plus.`);
      lines.push({ prop_id: r.prop_id, line, over: ov, under: un });
    }
    if (end && new Date(end) <= new Date()) return (err.textContent = "Pick an end time in the future.");
    if (start && end && new Date(start) >= new Date(end)) return (err.textContent = "The end has to be after the start.");
    $("#sl-save").disabled = true;
    const { data, error } = await sb.rpc("create_prop_slate", {
      p_lines: lines, p_closes_at: end ? new Date(end).toISOString() : null,
      p_starts_at: start ? new Date(start).toISOString() : null, p_hidden: [...hidden] });
    if (error) { err.textContent = errMsg(error); $("#sl-save").disabled = false; return; }
    closeSheet(); toast(`Posted ${data} ${stat} ${data === 1 ? "line" : "lines"}`); state.tab = "board"; state.filter = "open"; loadGroupData();
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
  const invite = (g && g.owner_id === uid() ? `<button class="btn settings-link" id="openSettings">⚙ Group settings</button>` : "") + (g ? `<div class="invite"><div><small>Invite code</small><b>${esc(g.invite_code)}</b></div>
    <button class="btn" id="copyCode">Copy</button></div>` : "");
  return `<h2>Leaderboard</h2>${invite}<div class="list">${rows.map((r, i) => {
    const rec = recordOf(r.id);
    return `<div class="row"><div class="rank num">${i + 1}</div>${avatarHTML(r.id, 34)}
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
    <button class="btn big" id="openSettings">${group()?.owner_id === uid() ? "Group settings" : "Group options"}</button>
    <div class="divider">add a group</div>
    ${joinCreateForms()}
    <button class="btn link" id="signOut">Sign out</button>`);
  document.querySelectorAll("[data-group]").forEach(b => b.onclick = () => { closeSheet(); openGroup(b.dataset.group); });
}

/* ---------------- group settings ---------------- */

function settingsHTML() {
  const g = group(); if (!g) return "";
  const owner = g.owner_id === uid();
  const back = `<button class="btn link back" id="settingsBack">‹ Back</button>`;
  if (!owner) return `${back}<h2>Group options</h2>
    <section class="set-block"><h3>${esc(g.name)}</h3><p class="hint">Owned by ${esc(nameOf(g.owner_id))}. Only the owner can change settings.</p>
      <button class="btn danger big" data-set="leave">Leave group</button>
      <p class="hint">Leaving removes your wagers on bets that haven't settled yet, and your props.</p></section>`;
  const members = [...state.members].sort((a, b) => a.username.localeCompare(b.username));
  const stats = statGroups();
  return `${back}<h2>Group settings</h2>
  <section class="set-block"><h3>Group</h3>
    <label class="f" for="set-name">Name<div class="inline"><input class="inp" id="set-name" maxlength="60" value="${esc(g.name)}"><button class="btn" data-set="rename">Save</button></div></label>
    <div class="f">Invite code<div class="inline"><b class="code-show">${esc(g.invite_code)}</b><button class="btn" data-set="newcode">New code</button></div>
      <span class="hint">A new code stops the old one from working. People already in stay in.</span></div>
    <label class="f" for="set-start">Starting balance for new members<div class="inline"><input class="inp num" id="set-start" inputmode="numeric" value="${esc(String(g.starting_balance ?? 1000))}"><button class="btn" data-set="startbal">Save</button></div></label>
  </section>
  <section class="set-block"><h3>Members · ${members.length}</h3>
    <div class="set-list">${members.map(m => `
      <div class="set-row"><div class="main"><b>${esc(m.username)}${m.id === uid() ? " (you)" : ""}</b><span class="s num">${fmtTok(m.balance)} tokens${m.id === g.owner_id ? " · owner" : ""}</span></div>
        <div class="acts">
          <button class="btn" data-set="tokens" data-user="${esc(m.id)}">Tokens</button>
          ${m.id !== uid() ? `<button class="btn" data-set="owner" data-user="${esc(m.id)}">Make owner</button>
          <button class="btn danger" data-set="remove" data-user="${esc(m.id)}">Remove</button>` : ""}
        </div></div>`).join("")}</div>
  </section>
  <section class="set-block"><h3>Props</h3>
    ${stats.length ? stats.map(sg => `<div class="set-stat">
      <div class="set-row"><div class="main"><b>${esc(sg.stat)}</b><span class="s">${sg.props.length} players</span></div>
        <div class="acts"><button class="btn danger" data-set="delstat" data-stat="${esc(sg.stat)}">Delete stat</button></div></div>
      <div class="chips">${sg.props.map(pr => `<button type="button" class="x-chip" data-set="delprop" data-prop="${esc(pr.id)}" aria-label="Remove ${esc(nameOf(pr.player_id))}'s ${esc(sg.stat)} prop">${esc(nameOf(pr.player_id))} ×</button>`).join("")}</div>
    </div>`).join("") : `<p class="hint">No props yet. Add them from the Props tab.</p>`}
    <p class="hint">Deleting a prop keeps its past and current bets on the board. They just stop being linked to the prop.</p>
  </section>
  <section class="set-block"><h3>New season</h3>
    <p class="hint">Put everyone back to ${fmtTok(g.starting_balance ?? 1000)} tokens. Settle or void open bets first.</p>
    <button class="btn" data-set="reset">Reset all balances</button>
  </section>
  <section class="set-block danger-zone"><h3>Delete group</h3>
    <p class="hint">Deletes every bet, wager, prop and balance in ${esc(g.name)} for everyone. This can't be undone.</p>
    <label class="f" for="set-del">Type the group name to confirm<input class="inp" id="set-del" placeholder="${esc(g.name)}" autocomplete="off"></label>
    <button class="btn danger big" data-set="delgroup">Delete ${esc(g.name)}</button>
  </section>`;
}

function confirmSheet(title, body, action, danger, run) {
  sheet(`<h4>${esc(title)}</h4><p class="sheet-body">${body}</p>
    <div class="err" id="cf-err"></div>
    <button class="btn big ${danger ? "danger" : "primary"}" id="cf-go">${esc(action)}</button>
    <button class="btn big" data-close>Cancel</button>`);
  $("#cf-go").onclick = async () => {
    $("#cf-go").disabled = true;
    const msg = await run();
    if (msg) { $("#cf-err").textContent = msg; $("#cf-go").disabled = false; return; }
    closeSheet();
  };
}

async function settingsAction(t) {
  const g = group(), gid = g.id, act = t.dataset.set, who = t.dataset.user, name = who ? nameOf(who) : "";
  const call = async (fn, args, ok) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) {
      const m = errMsg(error);
      return /could not find the function|schema cache/i.test(m) ? "Settings aren't switched on yet. Run supabase/owner_settings.sql in Supabase first." : m;
    }
    toast(typeof ok === "function" ? ok(data) : ok);
    await loadGroups(); state.tab = "settings"; render();
    return "";
  };
  const inline = async (fn, args, ok) => { const m = await call(fn, args, ok); if (m) toast(m); };
  if (act === "rename") return inline("rename_group", { p_group: gid, p_name: $("#set-name").value }, "Group renamed");
  if (act === "newcode") return confirmSheet("New invite code?", `The current code <b>${esc(g.invite_code)}</b> stops working. Everyone already in the group stays.`, "Make new code", false,
    () => call("new_invite_code", { p_group: gid }, c => `New code: ${c}`));
  if (act === "startbal") return inline("set_starting_balance", { p_group: gid, p_amount: Math.floor(Number($("#set-start").value)) }, "Starting balance saved");
  if (act === "tokens") {
    sheet(`<h4>Tokens for ${esc(name)}</h4><b class="num">${fmtTok(state.members.find(m => m.id === who)?.balance)} now</b>
      <label class="f" for="tk-amt">Amount<input class="inp num" id="tk-amt" inputmode="numeric" placeholder="100"></label>
      <div class="err" id="tk-err"></div>
      <div class="orow two"><button class="btn big primary" id="tk-give">Give</button><button class="btn big danger" id="tk-take">Take</button></div>
      <button class="btn big" data-close>Cancel</button>`);
    const go = async sign => {
      const amt = Math.floor(Number($("#tk-amt").value));
      if (!(amt > 0)) return ($("#tk-err").textContent = "Enter an amount.");
      const m = await call("adjust_balance", { p_group: gid, p_user: who, p_delta: sign * amt }, nb => `${name} now has ${fmtTok(nb)} tokens`);
      if (m) $("#tk-err").textContent = m; else closeSheet();
    };
    $("#tk-give").onclick = () => go(1); $("#tk-take").onclick = () => go(-1);
    return;
  }
  if (act === "owner") return confirmSheet(`Make ${name} the owner?`, `${esc(name)} gets these settings and you become a regular member. Only they can give it back.`, `Make ${name} owner`, false,
    () => call("transfer_ownership", { p_group: gid, p_user: who }, `${name} is now the owner`));
  if (act === "remove") return confirmSheet(`Remove ${name}?`, `${esc(name)} loses access to ${esc(g.name)}. Their wagers on bets that haven't settled are removed, and so are their props. They can rejoin with the invite code unless you make a new one.`, `Remove ${name}`, true,
    () => call("remove_member", { p_group: gid, p_user: who }, `${name} removed`));
  if (act === "delstat") return confirmSheet(`Delete ${t.dataset.stat}?`, `Removes the ${esc(t.dataset.stat)} prop for everyone. Bets already posted stay on the board.`, `Delete ${t.dataset.stat}`, true,
    () => call("delete_prop_stat", { p_group: gid, p_stat: t.dataset.stat }, `${t.dataset.stat} deleted`));
  if (act === "delprop") return inline("delete_prop", { p_prop: t.dataset.prop }, "Prop removed");
  if (act === "reset") return confirmSheet("Reset all balances?", `Everyone goes back to ${fmtTok(g.starting_balance ?? 1000)} tokens. Past bets stay in history.`, "Reset balances", true,
    () => call("reset_balances", { p_group: gid }, "New season. Everyone is reset."));
  if (act === "delgroup") {
    const typed = $("#set-del").value;
    if (typed !== g.name) return toast("Type the group name exactly to confirm.");
    return confirmSheet(`Delete ${g.name} for good?`, "Every bet, wager, prop and balance is gone for everyone. This can't be undone.", "Delete group", true, async () => {
      const { error } = await sb.rpc("delete_group", { p_group: gid, p_confirm_name: typed });
      if (error) return errMsg(error);
      toast(`${g.name} deleted`); state.tab = "board"; store.set("hl-group", ""); await loadGroups(); return "";
    });
  }
  if (act === "leave") return confirmSheet(`Leave ${g.name}?`, "Your wagers on bets that haven't settled are removed, and so are your props. You can rejoin with the invite code.", "Leave group", true, async () => {
    const { error } = await sb.rpc("leave_group", { p_group: gid });
    if (error) return errMsg(error);
    toast(`You left ${g.name}`); state.tab = "board"; store.set("hl-group", ""); await loadGroups(); return "";
  });
}

/* ---------------- profile ---------------- */

function profileHTML() {
  const me = userOf(uid()) || { username: "", balance: 0 };
  const mine = state.wagers.filter(w => w.user_id === uid());
  const settled = mine.filter(w => w.payout != null && betById(w.bet_id)?.status === "settled");
  const won = settled.filter(w => w.payout > w.stake), lost = settled.filter(w => w.payout === 0);
  const profit = settled.reduce((a, w) => a + (w.payout - w.stake), 0);
  const best = won.reduce((m, w) => Math.max(m, w.payout - w.stake), 0);
  const staked = mine.reduce((a, w) => a + w.stake, 0);
  const posted = state.bets.filter(b => b.creator_id === uid()).length;
  const hit = won.length + lost.length ? Math.round(won.length / (won.length + lost.length) * 100) : null;
  const rank = [...state.members].sort((a, b) => b.balance - a.balance).findIndex(m => m.id === uid()) + 1;
  return `<button class="btn link back" id="profileBack">‹ Back</button>
  <section class="pf-hero">
    <div class="pf-photo">${avatarHTML(uid(), 96)}</div>
    <div class="pf-photo-acts">
      <button class="btn" id="pfPhoto">${me.avatar ? "Change photo" : "Add photo"}</button>
      ${me.avatar ? `<button class="btn link danger-link" id="pfRemove">Remove</button>` : ""}
      <input type="file" id="pf-file" accept="image/*" hidden>
    </div>
  </section>
  <section class="set-block">
    <label class="f" for="pf-name">Username<div class="inline"><input class="inp" id="pf-name" maxlength="20" autocapitalize="none" autocomplete="username" value="${esc(me.username)}"><button class="btn" id="pfSaveName">Save</button></div>
      <span class="hint">2 to 20 letters, numbers, or underscores. Your prop lines update to the new name.</span></label>
    <div class="f">Email<span class="pf-email">${esc(state.session?.user?.email || "")}</span></div>
  </section>
  <section class="set-block"><h3>${esc(group()?.name || "This group")}</h3>
    <div class="pf-stats">
      <div><small>Balance</small><b class="num">${fmtTok(me.balance)}</b></div>
      <div><small>Rank</small><b class="num">${rank ? `${rank} of ${state.members.length}` : "—"}</b></div>
      <div><small>Profit</small><b class="num ${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${profit > 0 ? "+" : profit < 0 ? "−" : ""}${fmtTok(Math.abs(profit))}</b></div>
      <div><small>Record</small><b class="num">${won.length}–${lost.length}</b></div>
      <div><small>Hit rate</small><b class="num">${hit == null ? "—" : hit + "%"}</b></div>
      <div><small>Best win</small><b class="num">${best ? "+" + fmtTok(best) : "—"}</b></div>
      <div><small>Total wagered</small><b class="num">${fmtTok(staked)}</b></div>
      <div><small>Lines posted</small><b class="num">${posted}</b></div>
    </div>
  </section>
  <section class="set-block"><h3>Account</h3>
    <button class="btn big" id="pfPassword">Change password</button>
    <button class="btn big" id="openSettings">${group()?.owner_id === uid() ? "Group settings" : "Group options"}</button>
    <button class="btn big danger-outline" id="signOut">Sign out</button>
  </section>`;
}

async function saveProfile(args, ok) {
  const { error } = await sb.rpc("update_profile", args);
  if (error) {
    const m = errMsg(error);
    return toast(/duplicate key|unique/i.test(m) ? "That username is taken" : m);
  }
  toast(ok); await loadGroupData();
}

// Center-crop to a square and shrink to 256px so photos stay small and load fast.
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight), out = 256;
      const c = document.createElement("canvas"); c.width = c.height = out;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out, out);
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
      URL.revokeObjectURL(url);
      let q = 0.85, data = c.toDataURL("image/jpeg", q);
      while (data.length > 150000 && q > 0.4) { q -= 0.1; data = c.toDataURL("image/jpeg", q); }
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a photo we can read. Try a JPG or PNG.")); };
    img.src = url;
  });
}

document.addEventListener("change", async e => {
  if (e.target.id !== "pf-file" || !e.target.files?.[0]) return;
  try {
    toast("Uploading photo…");
    const data = await resizePhoto(e.target.files[0]);
    await saveProfile({ p_avatar: data }, "Photo updated");
  } catch (err) { toast(err.message); }
  e.target.value = "";
});

function openPassword() {
  sheet(`<h4>Change password</h4>
    <label class="f" for="pw-new">New password<input class="inp" id="pw-new" type="password" autocomplete="new-password" minlength="6"></label>
    <label class="f" for="pw-again">Type it again<input class="inp" id="pw-again" type="password" autocomplete="new-password" minlength="6"></label>
    <div class="err" id="pw-err"></div>
    <button class="btn primary big" id="pw-save">Change password</button>
    <button class="btn big" data-close>Cancel</button>`);
  $("#pw-save").onclick = async () => {
    const a = $("#pw-new").value, b = $("#pw-again").value;
    if (a.length < 6) return ($("#pw-err").textContent = "Use at least 6 characters.");
    if (a !== b) return ($("#pw-err").textContent = "Those don't match.");
    $("#pw-save").disabled = true;
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) { $("#pw-err").textContent = errMsg(error); $("#pw-save").disabled = false; return; }
    closeSheet(); toast("Password changed");
  };
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
$("#meBtn").addEventListener("click", () => { if (state.tab !== "profile") state.prevTab = state.tab; state.tab = "profile"; window.scrollTo(0, 0); render(); });
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
  if (t.id === "openSettings") { closeSheet(); state.tab = "settings"; window.scrollTo(0, 0); return render(); }
  if (t.id === "settingsBack") { state.tab = "leaders"; return render(); }
  if (t.id === "profileBack") { state.tab = state.prevTab || "board"; return render(); }
  if (t.id === "pfPhoto") return $("#pf-file").click();
  if (t.id === "pfRemove") return saveProfile({ p_clear_avatar: true }, "Photo removed");
  if (t.id === "pfSaveName") return saveProfile({ p_username: $("#pf-name").value }, "Username saved");
  if (t.id === "pfPassword") return openPassword();
  if (t.dataset.set) return settingsAction(t);
  if (t.id === "newStat") return openNewStat();
  if (t.dataset.pfStat !== undefined) { state.propStat = t.dataset.pfStat; return render(); }
  if (t.dataset.pfPlayer !== undefined) { state.propPlayer = t.dataset.pfPlayer; return render(); }
  if (t.dataset.postStat) return openPostSlate(t.dataset.postStat, t.dataset.postOnly || "");
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
