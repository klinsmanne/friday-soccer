// Friday Soccer — the website players and the organizer use.
const TZ = 'America/Chicago';
const WAIVER = 'I understand that playing soccer involves a risk of injury. I am choosing to play voluntarily, ' +
  'I am responsible for my own health and safety, and I agree not to hold the organizer or other players ' +
  'responsible for injuries that happen during the game, to the extent the law allows.';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const S = { cfg: null, session: null, home: null, email: '', refreshing: null, admin: {} };
const app = document.getElementById('app');

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(new Date(iso));
const timeOf = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
const dayOf = (iso) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' });
const longDay = (iso) => fmt(iso, { weekday: 'long', month: 'long', day: 'numeric' });
const whenOf = (iso) => `${fmt(iso, { weekday: 'short' })} ${timeOf(iso)}`;
function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function stored(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }

function toast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function modal({ title, text, buttons }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}
      <div class="stack">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </div></div>`;
    root.querySelector('.modal-back').addEventListener('click', (e) => {
      const i = e.target.dataset.i;
      if (i !== undefined) { root.innerHTML = ''; resolve(buttons[i].value); }
      else if (e.target.classList.contains('modal-back')) { root.innerHTML = ''; resolve(null); }
    });
  });
}

// ---------- talking to the server ----------
async function config() {
  if (!S.cfg) S.cfg = await (await fetch('/api/config')).json();
  return S.cfg;
}

async function authCall(path, body) {
  const c = await config();
  const r = await fetch(`${c.supabaseUrl}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: c.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.msg || d.error_description || d.message || 'Something went wrong. Please try again.');
  return d;
}

function setSession(d) {
  S.session = d ? { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600) } : null;
  store('fs_session', S.session);
}

async function token() {
  if (!S.session) return null;
  if (S.session.expires_at - 60 < Date.now() / 1000) {
    if (!S.refreshing) {
      S.refreshing = authCall('token?grant_type=refresh_token', { refresh_token: S.session.refresh_token })
        .then(setSession, () => setSession(null))
        .finally(() => { S.refreshing = null; });
    }
    await S.refreshing;
  }
  return S.session && S.session.access_token;
}

async function rpc(fn, args = {}) {
  const c = await config();
  const t = await token();
  if (!t) { signedOut(); throw new Error('Please sign in again.'); }
  const r = await fetch(`${c.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: c.supabaseKey, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (r.status === 401) { signedOut(); throw new Error('Please sign in again.'); }
  if (!r.ok) {
    let m = 'Something went wrong. Please try again.';
    try { m = JSON.parse(text).message || m; } catch {}
    throw new Error(m);
  }
  return text ? JSON.parse(text) : null;
}

async function api(path, body) {
  const t = await token();
  const r = await fetch(`/api/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
  return d;
}
const kick = () => api('kick').catch(() => {});

function signedOut() { setSession(null); S.home = null; route(); }

// ---------- routing ----------
window.addEventListener('hashchange', () => route());
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.session && location.hash.replace('#', '') in { '': 1, '/': 1 }) loadHome(); });

async function route() {
  clearInterval(S.poll);
  if (!S.session) return renderSignIn();
  const h = location.hash.replace(/^#/, '') || '/';
  try {
    if (!S.home) S.home = await rpc('get_home');
    const me = S.home.me;
    if (!me.full_name || !me.waiver) return renderProfile(true);
    if (h === '/profile') return renderProfile(false);
    if (h === '/history') return renderHistory();
    if (h.startsWith('/admin') && me.is_admin) return renderAdmin(h.split('/')[2] || 'game');
    return renderHome();
  } catch (e) {
    if (!S.session) return;
    app.innerHTML = `${topBar()}<div class="card center"><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></div>`;
    document.getElementById('retry').onclick = () => { S.home = null; route(); };
  }
}

function topBar(right = '') {
  return `<header class="top"><a class="brand" href="#/"><img src="/icons/icon-192.png" alt="">Friday Soccer</a>${right}</header>`;
}

// ---------- sign in ----------
function renderSignIn(step = 'email', error = '') {
  if (step === 'email') {
    app.innerHTML = `
      <div class="hero"><img src="/icons/icon-192.png" alt=""><h1>Friday Soccer</h1>
      <p class="muted">Ackerman Soccer · Fridays 10 PM</p></div>
      <form class="card" id="f">
        <label for="email">Your email</label>
        <input id="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@example.com" value="${esc(S.email)}">
        <p class="muted small">We'll email you a code. No password needed.</p>
        <button class="btn" type="submit">Send my code</button>
        <div class="err">${esc(error)}</div>
      </form>`;
    const f = document.getElementById('f');
    f.onsubmit = async (e) => {
      e.preventDefault();
      S.email = f.email.value.trim().toLowerCase();
      const b = f.querySelector('button'); b.disabled = true; b.textContent = 'Sending…';
      try { await authCall('otp', { email: S.email, create_user: true }); renderSignIn('code'); }
      catch (err) { renderSignIn('email', err.message); }
    };
    return;
  }
  app.innerHTML = `
    <div class="hero"><img src="/icons/icon-192.png" alt=""><h1>Check your email</h1>
    <p class="muted">We sent a code to <b>${esc(S.email)}</b></p></div>
    <form class="card" id="f">
      <label for="code">Enter the code</label>
      <input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required placeholder="••••••">
      <button class="btn" type="submit" style="margin-top:14px">Sign in</button>
      <div class="err">${esc(error)}</div>
      <p class="center small"><button class="linkbtn" type="button" id="back">Use a different email</button>
      · <button class="linkbtn" type="button" id="again">Send a new code</button></p>
      <p class="muted small center">Can't find it? Check your spam folder.</p>
    </form>`;
  const f = document.getElementById('f');
  f.code.focus();
  document.getElementById('back').onclick = () => renderSignIn('email');
  document.getElementById('again').onclick = async () => {
    try { await authCall('otp', { email: S.email, create_user: true }); toast('New code sent'); } catch (e) { toast(e.message); }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = f.querySelector('button[type=submit]'); b.disabled = true; b.textContent = 'Checking…';
    try {
      setSession(await authCall('verify', { type: 'email', email: S.email, token: f.code.value.replace(/\D/g, '') }));
      S.home = null; location.hash = '#/'; route();
    } catch (err) { renderSignIn('code', 'That code didn\'t work. Check it, or send a new one.'); }
  };
}

// ---------- profile ----------
function renderProfile(first) {
  const me = S.home.me;
  app.innerHTML = `${first ? '' : topBar('<a class="iconbtn" href="#/">Done</a>')}
    ${first ? `<div class="hero"><img src="/icons/icon-192.png" alt=""><h1>Welcome!</h1><p class="muted">Just a couple of things before you play.</p></div>` : ''}
    <form class="card" id="f">
      ${first ? '' : '<h2>Your profile</h2>'}
      <label for="n">Full name</label>
      <input id="n" type="text" autocomplete="name" required placeholder="First and last name" value="${esc(me.full_name)}">
      <p class="muted small">Shown on the player list.</p>
      <label for="p">Phone (optional)</label>
      <input id="p" type="tel" autocomplete="tel" placeholder="(555) 123-4567" value="${esc(me.phone)}">
      <p class="muted small">Only the organizer can see it.</p>
      ${me.waiver ? '' : `<div class="waiver">${esc(WAIVER)}</div>
        <label class="check"><input type="checkbox" id="w" required> I have read and agree to this</label>`}
      <button class="btn" type="submit" style="margin-top:18px">${first ? 'Let\'s play' : 'Save'}</button>
      <div class="err"></div>
      ${first ? '' : `<p class="center small muted">Signed in as ${esc(me.email)} · <button class="linkbtn" type="button" id="out">Sign out</button></p>`}
    </form>`;
  const f = document.getElementById('f');
  const out = document.getElementById('out');
  if (out) out.onclick = async () => { try { await authCall('logout', {}); } catch {} signedOut(); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await rpc('save_profile', { p_full_name: f.n.value, p_phone: f.p.value, p_accept_waiver: !!(f.w && f.w.checked) });
      S.home = null; location.hash = '#/'; if (!first) toast('Saved'); route();
    } catch (err) { f.querySelector('.err').textContent = err.message; }
  };
}

// ---------- home ----------
async function loadHome() {
  try { S.home = await rpc('get_home'); if ((location.hash || '#/') === '#/' || location.hash === '') renderHome(); } catch {}
}

function remaining(iso) {
  const ms = new Date(iso) - Date.now() - (S.skew || 0);
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function inQuietNow() {
  const hr = Number(fmt(new Date(), { hour: 'numeric', hour12: false }));
  return hr >= 22 || hr < 9;
}

function actionHtml(h) {
  const g = h.game, my = h.my, price = money(g.price_cents);
  const active = my && ['holding', 'confirmed', 'waitlisted', 'offered'].includes(my.status) ? my : null;
  const full = g.spots_taken >= g.max_players;

  if (g.phase === 'cancelled') return `<div class="status off">Game cancelled${g.cancel_reason ? `<small>${esc(g.cancel_reason)}</small>` : ''}</div>`;
  if (active && active.status === 'confirmed') {
    const held = active.pay_state === 'authorized';
    return `<div class="status in">You're in ✓<small>${active.is_manual ? 'Added by the organizer' :
      held ? `Card on hold for ${price} · charged ${whenOf(g.drop_deadline_at)}` : 'Paid'}</small></div>
      <div class="center"><button class="linkbtn" data-act="drop">I can't make it — drop out</button></div>`;
  }
  if (active && active.status === 'holding') {
    return `<button class="btn" data-act="pay">Finish paying ${price}</button>
      <div class="sub">Your spot is held for <b class="countdown" data-until="${active.hold_expires_at}">${remaining(active.hold_expires_at)}</b></div>
      <div class="center"><button class="linkbtn" data-act="drop">Release my spot</button></div>`;
  }
  if (active && active.status === 'offered') {
    const paused = inQuietNow();
    return `<button class="btn" data-act="pay">Spot available — pay ${price}</button>
      <div class="sub">${paused ? `Pay by <b>${whenOf(active.offer_expires_at)}</b> (clock paused overnight)`
        : `Pay within <b class="countdown" data-until="${active.offer_expires_at}">${remaining(active.offer_expires_at)}</b> or it goes to the next person`}</div>
      <div class="center"><button class="linkbtn" data-act="drop">No thanks, give it to the next person</button></div>`;
  }
  if (active && active.status === 'waitlisted') {
    return `<div class="status wait">You're #${active.position} on the waitlist<small>We'll notify you the moment a spot opens</small></div>
      <div class="center"><button class="linkbtn" data-act="drop">Leave the waitlist</button></div>`;
  }
  if (g.phase === 'upcoming') return `<div class="status off">Sign-ups open ${whenOf(g.opens_at)}<small>${longDay(g.opens_at)}</small></div>`;
  if (g.phase !== 'open') return `<div class="status off">Sign-ups closed</div>`;
  if (h.me.blocked) return `<div class="status off">Contact the organizer to play</div>`;
  if (full) return `<button class="btn" data-act="pay">Join the waitlist</button>
      <div class="sub">Free to join. If a spot opens, you'll get ${remaining_window(g)} to pay ${price}.</div>`;
  return `<button class="btn" data-act="pay">Sign up & pay ${price}</button>
    <div class="sub">${new Date() < new Date(g.drop_deadline_at) ? `Your card is only charged ${whenOf(g.drop_deadline_at)}. Drop before then for free.` : 'Apple Pay, Google Pay or card.'}</div>`;
}
function remaining_window(g) {
  return (new Date(g.kickoff_at) - Date.now()) < 6 * 3600e3 ? '30 minutes' : '2 hours';
}

function renderHome() {
  const h = S.home, g = h.game;
  S.skew = Date.now() - new Date(h.server_now).getTime();
  const pct = Math.min(100, Math.round((g.spots_taken / g.max_players) * 100));
  const params = new URLSearchParams(location.search);
  let banner = '';
  if (params.get('paid')) {
    const mine = h.my && h.my.status === 'confirmed';
    banner = mine ? `<div class="notice ok"><b>Payment received — you're in!</b></div>`
      : `<div class="notice ok"><b>Payment received.</b> Confirming your spot…</div>`;
    if (mine) history.replaceState(null, '', '/' + location.hash); else setTimeout(loadHome, 2500);
  } else if (params.get('checkout') === 'cancelled') {
    history.replaceState(null, '', '/' + location.hash);
    if (h.my && h.my.status === 'holding') banner = `<div class="notice warn">You didn't finish paying. Your spot is still held for a few minutes.</div>`;
  }
  const lateDrop = h.my && h.my.status === 'dropped' && h.my.late_drop_refund === 'pending'
    ? `<div class="notice warn">You dropped after the deadline. If someone takes your spot, you'll be refunded automatically.</div>` : '';

  app.innerHTML = `${topBar(h.me.is_admin ? '<a class="iconbtn" href="#/admin">Organizer</a>' : '<a class="iconbtn" href="#/profile">Profile</a>')}
    ${banner}${lateDrop}
    <section class="card game">
      <div class="kicker">${g.phase === 'done' || g.phase === 'closed' ? 'Tonight' : 'Next game'}</div>
      <h1>${esc(dayOf(g.kickoff_at))}</h1>
      <div class="meta">${esc(timeOf(g.kickoff_at))} – ${esc(timeOf(g.ends_at))} · ${esc(g.location)}</div>
      <div class="spots"><b>${g.spots_taken}</b><span class="of">/${g.max_players}</span><span class="label">spots taken${g.waitlist_count ? ` · ${g.waitlist_count} waiting` : ''}</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      ${actionHtml(h)}
    </section>
    ${pushCard()}
    <section class="card">
      <h2>Playing (${h.confirmed.length})</h2>
      ${h.confirmed.length ? `<ol class="names">${h.confirmed.map((p) => `<li class="${p.me ? 'me' : ''}">${esc(p.name)}${p.me ? ' <span class="tag">You</span>' : ''}</li>`).join('')}</ol>`
        : `<p class="muted">No one yet${g.phase === 'open' ? ' — be the first!' : '.'}</p>`}
      ${h.paying_count ? `<p class="muted small">+ ${h.paying_count} paying right now</p>` : ''}
    </section>
    ${h.waitlist.length ? `<section class="card"><h2>Waitlist (${h.waitlist.length})</h2>
      <ol class="names">${h.waitlist.map((p) => `<li class="${p.me ? 'me' : ''}">${esc(p.name)}${p.offered ? ' <span class="tag warn">Spot offered</span>' : ''}${p.me ? ' <span class="tag">You</span>' : ''}</li>`).join('')}</ol></section>` : ''}
    <section class="card small muted">
      <b style="color:var(--ink)">How it works</b><br>
      ${g.max_players} spots, first come first served. ${money(g.price_cents)} per game.
      Drop before ${whenOf(g.drop_deadline_at)} for a full refund; after that you're only refunded if someone takes your spot.
      Sign-ups close ${whenOf(g.closes_at)}.
    </section>
    <nav class="foot"><a href="#/history">My games & payments</a><a href="#/profile">Profile</a>${h.me.is_admin ? '<a href="#/admin">Organizer</a>' : ''}</nav>`;

  app.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => handleAction(b.dataset.act, b); });
  const pushBtn = document.getElementById('push-on');
  if (pushBtn) pushBtn.onclick = enablePush;
  const pushNo = document.getElementById('push-no');
  if (pushNo) pushNo.onclick = () => { store('fs_push_dismissed', true); renderHome(); };

  clearInterval(S.poll);
  S.poll = setInterval(() => {
    let expired = false;
    app.querySelectorAll('.countdown').forEach((el) => {
      el.textContent = remaining(el.dataset.until);
      if (el.textContent === '0:00') expired = true;
    });
    if (expired) { clearInterval(S.poll); setTimeout(loadHome, 1500); }
  }, 1000);
  clearInterval(S.refreshTimer);
  S.refreshTimer = setInterval(() => { if (!document.hidden) loadHome(); }, 30000);
}

async function handleAction(act, btn) {
  const h = S.home, g = h.game, my = h.my;
  if (act === 'pay') {
    btn.disabled = true; btn.textContent = 'One moment…';
    try {
      const r = await api('checkout');
      if (r.action === 'redirect') { location.href = r.url; return; }
      if (r.action === 'waitlisted') toast(`You're #${r.position} on the waitlist`);
      await loadHome();
    } catch (e) { toast(e.message, 5000); await loadHome(); }
    return;
  }
  if (act === 'drop') {
    let title = 'Drop out?', text = '', yes = 'Yes, drop me';
    if (my.status === 'holding') { title = 'Release your spot?'; text = 'Someone else will be able to take it.'; yes = 'Release it'; }
    else if (my.status === 'waitlisted') { title = 'Leave the waitlist?'; text = 'You\'ll lose your place in line.'; yes = 'Leave waitlist'; }
    else if (my.status === 'offered') { title = 'Turn down this spot?'; text = 'It will be offered to the next person.'; yes = 'Give it away'; }
    else if (my.is_manual) text = 'Your spot will go to the next person.';
    else if (new Date() < new Date(g.drop_deadline_at)) text = `You'll get your ${money(g.price_cents)} back automatically.`;
    else if (g.phase === 'open') text = `It's past the drop deadline (${whenOf(g.drop_deadline_at)}), so you'll only get a refund if someone takes your spot.`;
    else text = 'Sign-ups are closed, so there\'s no refund.';
    const ok = await modal({ title, text: esc(text), buttons: [{ label: yes, cls: 'danger', value: true }, { label: 'Keep my spot', cls: 'secondary', value: false }] });
    if (!ok) return;
    try { const r = await rpc('drop_out'); kick(); toast(r.message, 6000); } catch (e) { toast(e.message); }
    await loadHome();
  }
}

// ---------- push notifications ----------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

function pushCard() {
  if (stored('fs_push_dismissed') || stored('fs_push_on')) return '';
  if ('PushManager' in window && 'Notification' in window && Notification.permission !== 'denied') {
    return `<div class="notice info"><div class="row"><div><b>Get notified</b><br><span class="muted small">Know right away when sign-ups open or a spot frees up.</span></div>
      <button class="btn small dark" id="push-on">Turn on</button></div>
      <div class="center"><button class="linkbtn muted" id="push-no">Not now</button></div></div>`;
  }
  if (isIOS && !standalone) {
    return `<div class="notice info"><b>Tip: get notifications on iPhone</b><br>
      <span class="small">Tap the Share button <b>⎋</b> at the bottom of Safari, then <b>Add to Home Screen</b>. Open Friday Soccer from your home screen and tap "Turn on".
      You'll get emails either way.</span>
      <div class="center"><button class="linkbtn muted" id="push-no">Got it</button></div></div>`;
  }
  return '';
}

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are off. You\'ll still get emails.'); store('fs_push_dismissed', true); return renderHome(); }
    const reg = await navigator.serviceWorker.ready;
    const c = await config();
    if (!c.vapidPublicKey) throw new Error('Notifications aren\'t ready yet — try again in a minute.');
    const sub = (await reg.pushManager.getSubscription()) ||
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(c.vapidPublicKey) });
    const j = sub.toJSON();
    await rpc('save_push', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
    store('fs_push_on', true);
    toast('Notifications on ✓');
    renderHome();
  } catch (e) { toast(e.message || 'Couldn\'t turn on notifications'); }
}

// ---------- history ----------
async function renderHistory() {
  app.innerHTML = `${topBar('<a class="iconbtn" href="#/">Back</a>')}<div class="loading"><div class="spinner"></div></div>`;
  const d = await rpc('my_history');
  const label = { confirmed: 'Played', dropped: 'Dropped', removed: 'Removed', cancelled: 'Cancelled', expired: 'Not completed', holding: 'Paying', offered: 'Offered', waitlisted: 'Waitlist' };
  const kind = { authorized: 'Card hold', charged: 'Charged', captured: 'Charged', released: 'Hold released', refunded: 'Refunded' };
  app.innerHTML = `${topBar('<a class="iconbtn" href="#/">Back</a>')}
    <section class="card"><h2>My games</h2>
      ${d.games.length ? `<table class="simple"><tr><th>Game</th><th>Status</th></tr>${d.games.map((x) => `<tr><td>${esc(dayOf(x.kickoff_at))}</td>
        <td>${x.cancelled ? '<span class="tag grey">Game cancelled</span>' : `<span class="tag ${x.status === 'confirmed' ? '' : 'grey'}">${esc(label[x.status] || x.status)}</span>`}</td></tr>`).join('')}</table>`
        : '<p class="muted">No games yet.</p>'}
    </section>
    <section class="card"><h2>Payments</h2>
      ${d.payments.length ? `<table class="simple"><tr><th>Date</th><th>What</th><th>Amount</th></tr>${d.payments.map((p) => `<tr>
        <td>${esc(dayOf(p.created_at))}</td><td>${esc(kind[p.kind] || p.kind)}${p.kickoff_at ? `<br><span class="muted small">for ${esc(dayOf(p.kickoff_at))}</span>` : ''}</td>
        <td>${['released', 'refunded'].includes(p.kind) ? '−' : ''}${money(p.amount_cents)}</td></tr>`).join('')}</table>`
        : '<p class="muted">No payments yet.</p>'}
      <p class="muted small">A "card hold" isn't a charge yet; it becomes one at the drop deadline or is released if you drop.</p>
    </section>`;
}

// ---------- organizer ----------
const payTag = (r) => ({
  authorized: '<span class="tag">Held</span>', captured: '<span class="tag">Paid</span>', manual: '<span class="tag grey">Added</span>',
  refund_pending: '<span class="tag warn">Refunding</span>', refunded: '<span class="tag grey">Refunded</span>',
  released: '<span class="tag grey">Released</span>', none: '',
}[r.pay_state] || '');

async function renderAdmin(tab) {
  const tabs = [['game', 'This game'], ['message', 'Message'], ['players', 'Players'], ['settings', 'Settings'], ['history', 'History']];
  const shell = (inner) => `${topBar('<a class="iconbtn" href="#/">Player view</a>')}
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>${inner}`;
  app.innerHTML = shell('<div class="loading"><div class="spinner"></div></div>');
  try {
    if (tab === 'game') return await adminGame(shell);
    if (tab === 'message') return adminMessage(shell);
    if (tab === 'players') return await adminPlayers(shell);
    if (tab === 'settings') return await adminSettings(shell);
    if (tab === 'history') return await adminHistory(shell);
  } catch (e) { app.innerHTML = shell(`<div class="card">${esc(e.message)}</div>`); }
}

async function adminGame(shell) {
  const b = await rpc('admin_board', { p_game: null });
  const g = b.game, regs = b.registrations;
  const playing = regs.filter((r) => ['confirmed', 'holding'].includes(r.status));
  const waiting = regs.filter((r) => ['waitlisted', 'offered'].includes(r.status));
  const gone = regs.filter((r) => !['confirmed', 'holding', 'waitlisted', 'offered'].includes(r.status));
  const row = (r, i, movable) => `<div class="row-item">
      <div class="who"><b>${i + 1}. ${esc(r.name || r.email)}</b><span>${esc(r.email)}${r.phone ? ' · ' + esc(r.phone) : ''}</span></div>
      ${r.status === 'holding' ? '<span class="tag warn">Paying…</span>' : r.status === 'offered' ? '<span class="tag warn">Offered</span>' : payTag(r)}
      ${movable ? `<button class="mini" data-move="up" data-id="${r.id}" aria-label="Move up">↑</button><button class="mini" data-move="down" data-id="${r.id}" aria-label="Move down">↓</button>` : ''}
      <button class="mini bad" data-remove="${r.id}" data-name="${esc(r.name || r.email)}" data-paid="${['authorized', 'captured'].includes(r.pay_state) ? 1 : 0}">✕</button>
    </div>`;
  const phaseText = { upcoming: `Sign-ups open ${whenOf(g.opens_at)}`, open: `Sign-ups open until ${whenOf(g.closes_at)}`, closed: 'Sign-ups closed', done: 'Finished', cancelled: 'Cancelled' }[g.phase];
  app.innerHTML = shell(`
    <section class="card"><h2>${esc(longDay(g.kickoff_at))}</h2>
      <p class="muted" style="margin:0">${esc(timeOf(g.kickoff_at))} · ${esc(g.location)} · ${esc(phaseText)}</p></section>
    ${b.failed_tasks ? `<div class="notice warn">${b.failed_tasks} payment action(s) failed. Check your Stripe dashboard.</div>` : ''}
    <div class="stats">
      <div class="stat"><b>${g.spots_taken}/${g.max_players}</b><span>Spots taken</span></div>
      <div class="stat"><b>${g.waitlist_count}</b><span>Waitlist</span></div>
      <div class="stat"><b>${money(b.collected_cents)}</b><span>Collected</span></div>
      <div class="stat"><b>${money(b.on_hold_cents)}</b><span>On hold (charged ${esc(whenOf(g.drop_deadline_at))})</span></div>
    </div>
    <div class="btn-row" style="margin-bottom:14px">
      <button class="btn dark" id="add-me">Add myself</button>
      <button class="btn secondary" id="add-player">Add a player</button>
    </div>
    <section class="card"><h2>Playing (${playing.length})</h2>${playing.map((r, i) => row(r, i, true)).join('') || '<p class="muted">No one yet.</p>'}</section>
    <section class="card"><h2>Waitlist (${waiting.length})</h2>${waiting.map((r, i) => row(r, i, true)).join('') || '<p class="muted">Empty.</p>'}</section>
    ${gone.length ? `<section class="card"><details><summary>Dropped / removed (${gone.length})</summary>
      ${gone.map((r) => `<div class="row-item"><div class="who"><b>${esc(r.name || r.email)}</b><span>${esc(r.status)}${r.late_drop_refund ? ` · late drop, refund ${esc(r.late_drop_refund)}` : ''}</span></div>${payTag(r)}</div>`).join('')}
    </details></section>` : ''}
    <section class="card"><h2>Change this game</h2>
      <form id="eg">
        <label>Location</label><input name="loc" type="text" value="${esc(g.location)}">
        <div class="grid2">
          <div><label>Max players</label><input name="max" type="number" min="2" max="100" value="${g.max_players}"></div>
          <div><label>Kickoff</label><input name="ko" type="time" value="${fmt(g.kickoff_at, { hour: '2-digit', minute: '2-digit', hour12: false })}"></div>
        </div>
        <button class="btn secondary" style="margin-top:14px">Save changes</button>
      </form>
    </section>
    ${g.phase !== 'cancelled' ? '<button class="btn danger" id="cancel-game">Cancel this game & refund everyone</button>' : ''}`);

  app.querySelectorAll('[data-move]').forEach((el) => {
    el.onclick = async () => { try { await rpc('admin_move', { p_reg: Number(el.dataset.id), p_direction: el.dataset.move }); adminGame(shell); } catch (e) { toast(e.message); } };
  });
  app.querySelectorAll('[data-remove]').forEach((el) => {
    el.onclick = async () => {
      const paid = el.dataset.paid === '1';
      const choice = await modal({
        title: `Remove ${el.dataset.name}?`, text: paid ? 'They paid. Do you want to refund them?' : 'Their spot goes to the next person.',
        buttons: paid ? [{ label: 'Remove & refund', cls: 'danger', value: 'refund' }, { label: 'Remove, no refund', cls: 'secondary', value: 'keep' }, { label: 'Cancel', cls: 'secondary', value: null }]
          : [{ label: 'Remove', cls: 'danger', value: 'refund' }, { label: 'Cancel', cls: 'secondary', value: null }],
      });
      if (!choice) return;
      try { await rpc('admin_remove', { p_reg: Number(el.dataset.remove), p_refund: choice === 'refund' }); kick(); toast('Removed'); adminGame(shell); } catch (e) { toast(e.message); }
    };
  });
  document.getElementById('add-me').onclick = async () => {
    try { await rpc('admin_add', { p_user: S.home.me.id }); toast('You\'re on the list'); S.home = null; adminGame(shell); } catch (e) { toast(e.message, 5000); }
  };
  document.getElementById('add-player').onclick = async () => {
    const players = await rpc('admin_players');
    const onList = new Set(regs.filter((r) => ['confirmed', 'holding', 'waitlisted', 'offered'].includes(r.status)).map((r) => r.user_id));
    const options = players.filter((p) => !onList.has(p.id) && p.name);
    if (!options.length) return toast('Everyone who has an account is already on the list');
    const pick = await modal({ title: 'Add a player', text: 'They\'re added for free (no card charge). Players need an account first.',
      buttons: [...options.slice(0, 30).map((p) => ({ label: p.name, cls: 'secondary', value: p.id })), { label: 'Cancel', cls: 'secondary', value: null }] });
    if (!pick) return;
    try { await rpc('admin_add', { p_user: pick }); kick(); toast('Added'); adminGame(shell); } catch (e) { toast(e.message, 5000); }
  };
  document.getElementById('eg').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await rpc('admin_update_game', { p_location: f.loc.value, p_max_players: Number(f.max.value), p_kickoff_time: f.ko.value || null }); kick(); toast('Game updated'); S.home = null; adminGame(shell); }
    catch (err) { toast(err.message, 5000); }
  };
  const cg = document.getElementById('cancel-game');
  if (cg) cg.onclick = async () => {
    const reason = await modal({ title: 'Cancel this game?', text: 'Everyone is refunded automatically and gets a notification. This can\'t be undone.',
      buttons: [{ label: 'Cancel game (bad weather)', cls: 'danger', value: 'bad weather' }, { label: 'Cancel game (other reason)', cls: 'danger', value: ' ' }, { label: 'Keep the game', cls: 'secondary', value: null }] });
    if (!reason) return;
    try { const r = await rpc('admin_cancel_game', { p_reason: reason.trim() }); kick(); toast(`Cancelled. ${r.players} player(s) notified.`); S.home = null; adminGame(shell); } catch (e) { toast(e.message); }
  };
}

function adminMessage(shell) {
  app.innerHTML = shell(`<form class="card" id="m"><h2>Message everyone</h2>
    <p class="muted small">Goes to everyone signed up for this week (playing and waitlist), by email and notification.</p>
    <label>Title</label><input name="t" type="text" placeholder="e.g. Bring a dark shirt">
    <label>Message</label><textarea name="b" required placeholder="Write your message"></textarea>
    <button class="btn" style="margin-top:14px">Send</button></form>`);
  document.getElementById('m').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await rpc('admin_message', { p_title: e.target.t.value, p_body: e.target.b.value }); kick(); toast(`Sent to ${r.sent_to} player(s)`); e.target.reset(); } catch (err) { toast(err.message); }
  };
}

async function adminPlayers(shell) {
  const players = await rpc('admin_players');
  app.innerHTML = shell(`<section class="card"><h2>Players (${players.length})</h2>
    <input type="text" id="q" placeholder="Search name or email" style="margin-bottom:8px">
    <div id="pl">${players.map((p) => `<div class="row-item" data-q="${esc(((p.name || '') + ' ' + p.email).toLowerCase())}">
      <div class="who"><b>${esc(p.name || '(no name yet)')}</b><span>${esc(p.email)}${p.phone ? ' · ' + esc(p.phone) : ''} · ${p.games_played} game(s)</span></div>
      ${p.is_admin ? '<span class="tag">Organizer</span>' : `<button class="mini ${p.blocked ? '' : 'bad'}" data-block="${p.id}" data-on="${p.blocked ? 0 : 1}">${p.blocked ? 'Unblock' : 'Block'}</button>`}
    </div>`).join('')}</div>
    <p class="muted small">Blocked people can still sign in but can't sign up for games. To take someone off this week's list, use "This game".</p></section>`);
  document.getElementById('q').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    app.querySelectorAll('#pl .row-item').forEach((el) => { el.style.display = el.dataset.q.includes(q) ? '' : 'none'; });
  };
  app.querySelectorAll('[data-block]').forEach((el) => {
    el.onclick = async () => { try { await rpc('admin_block', { p_user: el.dataset.block, p_blocked: el.dataset.on === '1' }); adminPlayers(shell); } catch (e) { toast(e.message); } };
  });
}

async function adminSettings(shell) {
  const s = (await rpc('admin_board', { p_game: null })).settings;
  const t = (v) => String(v).slice(0, 5);
  const daySel = (name, v) => `<select name="${name}">${DAYS.map((d, i) => `<option value="${i}" ${i === v ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
  app.innerHTML = shell(`<form class="card" id="s"><h2>Settings</h2>
    <p class="muted small">These apply from the next game that's created. To change this week's game, use "This game".</p>
    <div class="grid2">
      <div><label>Price ($)</label><input name="price" type="number" step="0.01" min="0.50" value="${(s.price_cents / 100).toFixed(2)}"></div>
      <div><label>Max players</label><input name="max_players" type="number" min="2" max="100" value="${s.max_players}"></div>
    </div>
    <label>Location</label><input name="location" type="text" value="${esc(s.location)}">
    <div class="grid2">
      <div><label>Game day</label>${daySel('kickoff_dow', s.kickoff_dow)}</div>
      <div><label>Kickoff</label><input name="kickoff_time" type="time" value="${t(s.kickoff_time)}"></div>
      <div><label>Length (minutes)</label><input name="duration_minutes" type="number" value="${s.duration_minutes}"></div>
      <div><label>Close sign-ups (min before)</label><input name="close_minutes_before" type="number" value="${s.close_minutes_before}"></div>
      <div><label>Sign-ups open day</label>${daySel('opens_dow', s.opens_dow)}</div>
      <div><label>Open time</label><input name="opens_time" type="time" value="${t(s.opens_time)}"></div>
      <div><label>Drop deadline day</label>${daySel('drop_deadline_dow', s.drop_deadline_dow)}</div>
      <div><label>Deadline time</label><input name="drop_deadline_time" type="time" value="${t(s.drop_deadline_time)}"></div>
      <div><label>Checkout hold (min)</label><input name="hold_minutes" type="number" value="${s.hold_minutes}"></div>
      <div><label>Waitlist offer (min)</label><input name="offer_minutes" type="number" value="${s.offer_minutes}"></div>
      <div><label>Offer on game day (min)</label><input name="late_offer_minutes" type="number" value="${s.late_offer_minutes}"></div>
      <div></div>
      <div><label>Pause offers from</label><input name="quiet_start" type="time" value="${t(s.quiet_start)}"></div>
      <div><label>Pause offers until</label><input name="quiet_end" type="time" value="${t(s.quiet_end)}"></div>
    </div>
    <button class="btn" style="margin-top:16px">Save settings</button></form>`);
  document.getElementById('s').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const p = { ...f, price_cents: Math.round(Number(f.price) * 100) };
    delete p.price;
    try { await rpc('admin_update_settings', { p }); toast('Settings saved'); } catch (err) { toast(err.message, 5000); }
  };
}

async function adminHistory(shell) {
  const [games, pays] = await Promise.all([rpc('admin_games'), rpc('admin_payments')]);
  app.innerHTML = shell(`<section class="card"><h2>Past games</h2>
    <table class="simple"><tr><th>Game</th><th>Players</th><th>Collected</th></tr>
    ${games.map((g) => `<tr><td>${esc(dayOf(g.kickoff_at))}${g.cancelled ? ' <span class="tag grey">Cancelled</span>' : ''}</td><td>${g.players}</td><td>${money(g.collected_cents)}</td></tr>`).join('')}</table></section>
    <section class="card"><h2>Payments</h2><p class="muted small">${pays.length} payment record(s).</p>
    <button class="btn secondary" id="csv">Download spreadsheet (CSV)</button></section>`);
  document.getElementById('csv').onclick = () => {
    const rows = [['Date', 'Game', 'Player', 'Email', 'Type', 'Amount', 'Stripe reference']];
    for (const p of pays) rows.push([fmt(p.date, { dateStyle: 'short', timeStyle: 'short' }), p.game ? dayOf(p.game) : '', p.player || '', p.email || '', p.kind, (p.amount_cents / 100).toFixed(2), p.stripe_ref || '']);
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'friday-soccer-payments.csv';
    a.click();
  };
}

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
S.session = stored('fs_session');
route();
