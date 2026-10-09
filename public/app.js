// Midwest FC — the website players and organizers use.
const TZ = 'America/Chicago';
const WAIVER = 'I understand that playing soccer involves a risk of injury. I am choosing to play voluntarily, ' +
  'I am responsible for my own health and safety, and I agree not to hold the organizer or other players ' +
  'responsible for injuries that happen during the game, to the extent the law allows.';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const S = { cfg: null, session: null, home: null, email: '', refreshing: null };
const app = document.getElementById('app');

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(new Date(iso));
const timeOf = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
const dayOf = (iso) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' });
const longDay = (iso) => fmt(iso, { weekday: 'long', month: 'long', day: 'numeric' });
const whenOf = (iso) => `${fmt(iso, { weekday: 'short' })} ${timeOf(iso)}`;
const badgeHtml = (badges) => (badges || []).map((b) => `<span class="badge b-${esc(String(b).toLowerCase())}">${esc(b)}</span>`).join('');
function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function stored(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }

function toast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function modal({ title, text, buttons, html }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${html || ''}
      <div class="stack">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </div></div>`;
    root.querySelector('.modal-back').addEventListener('click', (e) => {
      const i = e.target.dataset.i;
      if (i !== undefined) {
        const form = root.querySelector('form');
        const data = form ? Object.fromEntries(new FormData(form)) : null;
        root.innerHTML = ''; resolve(buttons[i].value === undefined ? null : (data && buttons[i].value === true ? data : buttons[i].value));
      } else if (e.target.classList.contains('modal-back')) { root.innerHTML = ''; resolve(null); }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.session && ['', '#', '#/'].includes(location.hash)) loadHome(); });

async function route() {
  clearInterval(S.poll); clearInterval(S.refreshTimer);
  if (!S.session) return renderSignIn();
  const h = location.hash.replace(/^#/, '') || '/';
  try {
    if (!S.home) S.home = await rpc('get_home');
    const me = S.home.me;
    const hasRequest = S.home.memberships.some((m) => m.status === 'pending' || m.status === 'approved');
    if (!me.full_name || !me.waiver || (!me.is_admin && !hasRequest)) return renderProfile(true);
    if (h.startsWith('/admin') && me.is_admin) { const [, , tab, id] = h.split('/'); return renderAdmin(tab || 'games', id); }
    if (h === '/profile') return renderProfile(false);
    if (h === '/history') return renderHistory();
    if (!S.home.sections.length) return renderPending();
    return renderHome();
  } catch (e) {
    if (!S.session) return;
    app.innerHTML = `${topBar()}<div class="card center"><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></div>`;
    document.getElementById('retry').onclick = () => { S.home = null; route(); };
  }
}

function topBar(right = '') {
  return `<header class="top"><a class="brand" href="#/"><img src="/icons/icon-192.png" alt="">Midwest FC</a>${right}</header>`;
}

// ---------- sign in ----------
function renderSignIn(step = 'email', error = '') {
  if (step === 'email') {
    app.innerHTML = `
      <div class="hero"><img src="/icons/icon-192.png" alt=""><h1>Midwest FC</h1>
      <p class="muted">Pickup soccer · members sign-up</p></div>
      <form class="card" id="f">
        <label for="email">Your email</label>
        <input id="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@example.com" value="${esc(S.email)}">
        <p class="muted small">We'll email you a sign-in code. No password needed.</p>
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
      <p class="muted small center">If the email has a sign-in link instead of a code, just tap the link. Can't find it? Check your spam folder.</p>
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

// ---------- profile + membership requests ----------
function renderProfile(first) {
  const h = S.home, me = h.me;
  const requestable = h.memberships.filter((m) => !['pending', 'approved'].includes(m.status));
  const statusText = { approved: 'Member', pending: 'Waiting for approval', declined: 'Not approved', removed: 'Removed' };
  app.innerHTML = `${first ? '' : topBar('<a class="iconbtn" href="#/">Done</a>')}
    ${first ? `<div class="hero"><img src="/icons/icon-192.png" alt=""><h1>Join Midwest FC</h1><p class="muted">Tell us who you are and which games you play.</p></div>` : ''}
    <form class="card" id="f">
      ${first ? '' : '<h2>Your profile</h2>'}
      <label for="n">Full name</label>
      <input id="n" type="text" autocomplete="name" required placeholder="First and last name" value="${esc(me.full_name)}">
      <p class="muted small">Shown on the player list.</p>
      <label for="p">Phone (optional)</label>
      <input id="p" type="tel" autocomplete="tel" placeholder="(555) 123-4567" value="${esc(me.phone)}">
      <p class="muted small">Only the organizer can see it.</p>
      ${!first ? `<label>Your groups</label>
        ${h.memberships.map((m) => `<div class="row-item"><div class="who"><b>${esc(m.category)}</b></div>
          ${m.status ? `<span class="tag ${m.status === 'approved' ? '' : m.status === 'pending' ? 'warn' : 'grey'}">${statusText[m.status]}</span>` : '<span class="tag grey">Not a member</span>'}</div>`).join('')}` : ''}
      ${requestable.length && !(me.is_admin && first) ? `<label>${first ? 'Which games do you want to join?' : 'Ask to join'}</label>
        ${requestable.map((m) => `<label class="check"><input type="checkbox" name="req" value="${esc(m.category_id)}"> ${esc(m.category)}</label>`).join('')}
        <p class="muted small">The organizer approves every new member. You'll get an email once you're in.</p>` : ''}
      ${me.waiver ? '' : `<div class="waiver">${esc(WAIVER)}</div>
        <label class="check"><input type="checkbox" id="w" required> I have read and agree to this</label>`}
      <button class="btn" type="submit" style="margin-top:18px">${first ? (me.is_admin ? 'Continue' : 'Send my request') : 'Save'}</button>
      <div class="err"></div>
      ${first ? '' : `<p class="center small muted">Signed in as ${esc(me.email)} · <button class="linkbtn" type="button" id="out">Sign out</button></p>`}
    </form>`;
  const f = document.getElementById('f');
  const out = document.getElementById('out');
  if (out) out.onclick = signOut;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const req = [...f.querySelectorAll('input[name=req]:checked')].map((x) => x.value);
    try {
      await rpc('save_profile', { p_full_name: f.n.value, p_phone: f.p.value, p_accept_waiver: !!(f.w && f.w.checked), p_request: req.length ? req : null });
      if (req.length) kick();
      S.home = null; location.hash = '#/'; toast(req.length ? 'Request sent ✓' : 'Saved'); route();
    } catch (err) { f.querySelector('.err').textContent = err.message; }
  };
}

async function signOut() { try { await authCall('logout', {}); } catch {} signedOut(); }

function renderPending() {
  const h = S.home;
  const pending = h.memberships.filter((m) => m.status === 'pending');
  app.innerHTML = `${topBar('<a class="iconbtn" href="#/profile">Profile</a>')}
    <div class="hero"><img src="/icons/icon-192.png" alt=""><h1>Almost there</h1></div>
    <section class="card center">
      ${pending.length ? `<p>Thanks, <b>${esc(h.me.full_name)}</b>! Your request to join <b>${pending.map((m) => esc(m.category)).join('</b> and <b>')}</b>
        is waiting for the organizer's approval.</p><p class="muted">We'll email you at ${esc(h.me.email)} as soon as you're approved.
        Then you'll see the games here and can sign up when sign-ups open.</p>`
        : `<p>You're not a member of any game group right now.</p><p class="muted">Ask to join from your profile.</p>`}
      <a class="btn secondary" href="#/profile" style="margin-top:8px">${pending.length ? 'View my profile' : 'Ask to join'}</a>
    </section>
    <p class="center small"><button class="linkbtn muted" id="out">Sign out</button></p>`;
  document.getElementById('out').onclick = signOut;
  S.refreshTimer = setInterval(() => { if (!document.hidden) { S.home = null; route(); } }, 60000);
}

// ---------- home ----------
async function loadHome() {
  try { S.home = await rpc('get_home'); if (['', '#', '#/'].includes(location.hash)) renderHome(); } catch {}
}

function remaining(iso) {
  const ms = new Date(iso) - Date.now() - (S.skew || 0);   // skew = server clock − phone clock
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function inQuietNow() {
  const hr = Number(fmt(new Date(), { hour: 'numeric', hour12: false }));
  return hr >= 22 || hr < 9;
}

function actionHtml(v, me) {
  const g = v.game, my = v.my, price = money(g.price_cents), gid = g.id;
  const active = my && ['holding', 'confirmed', 'waitlisted', 'offered'].includes(my.status) ? my : null;
  const full = g.spots_taken >= g.max_players;
  const btn = (act, label, cls = '') => `<button class="btn ${cls}" data-act="${act}" data-game="${gid}">${label}</button>`;
  const link = (act, label) => `<div class="center"><button class="linkbtn" data-act="${act}" data-game="${gid}">${label}</button></div>`;

  if (g.phase === 'cancelled') return `<div class="status off">Game cancelled${g.cancel_reason ? `<small>${esc(g.cancel_reason)}</small>` : ''}</div>`;
  if (active && active.status === 'confirmed') {
    const held = active.pay_state === 'authorized';
    return `<div class="status in">You're in ✓<small>${active.is_manual ? 'Added by the organizer' :
      held ? `Card on hold for ${price} · charged ${whenOf(g.drop_deadline_at)}` : 'Paid'}</small></div>
      ${link('drop', 'I can\'t make it — drop out')}`;
  }
  if (active && active.status === 'holding') {
    return `${btn('pay', `Finish paying ${price}`)}
      <div class="sub">Your spot is held for <b class="countdown" data-until="${active.hold_expires_at}">${remaining(active.hold_expires_at)}</b></div>
      ${link('drop', 'Release my spot')}`;
  }
  if (active && active.status === 'offered') {
    return `${btn('pay', `Spot available — pay ${price}`)}
      <div class="sub">${inQuietNow() ? `Pay by <b>${whenOf(active.offer_expires_at)}</b> (clock paused overnight)`
        : `Pay within <b class="countdown" data-until="${active.offer_expires_at}">${remaining(active.offer_expires_at)}</b> or it goes to the next person`}</div>
      ${link('drop', 'No thanks, give it to the next person')}`;
  }
  if (active && active.status === 'waitlisted') {
    return `<div class="status wait">You're #${active.position} on the waitlist<small>We'll notify you the moment a spot opens</small></div>
      ${link('drop', 'Leave the waitlist')}`;
  }
  if (g.phase === 'upcoming') return `<div class="status off">Sign-ups open ${whenOf(g.opens_at)}<small>${longDay(g.opens_at)}</small></div>`;
  if (g.phase !== 'open') return `<div class="status off">Sign-ups closed</div>`;
  if (me.blocked) return `<div class="status off">Contact the organizer to play</div>`;
  if (full) return `${btn('pay', 'Join the waitlist')}
      <div class="sub">Free to join. If a spot opens, you'll get ${(new Date(g.kickoff_at) - Date.now()) < 6 * 3600e3 ? '30 minutes' : '2 hours'} to pay ${price}.</div>`;
  return `${btn('pay', `Sign up & pay ${price}`)}
    <div class="sub">${new Date() < new Date(g.drop_deadline_at) ? `Your card is only charged ${whenOf(g.drop_deadline_at)}. Drop before then for free.` : 'Apple Pay, Google Pay or card.'}</div>`;
}

function sectionHtml(sec, me) {
  const v = sec.view;
  if (!v) {
    return `<h2 class="section-title">${esc(sec.category)} ${badgeHtml([sec.badge])}</h2>
      <section class="card center muted">No ${esc(sec.category)} are scheduled yet. You'll get an email when sign-ups open.</section>`;
  }
  const g = v.game;
  const pct = Math.min(100, Math.round((g.spots_taken / g.max_players) * 100));
  const lateDrop = v.my && v.my.status === 'dropped' && v.my.late_drop_refund === 'pending'
    ? `<div class="notice warn">You dropped after the deadline. If someone takes your spot, you'll be refunded automatically.</div>` : '';
  const names = (list, extra) => list.map((p) => `<li class="${p.me ? 'me' : ''}"><span class="nm">${esc(p.name)}</span>${badgeHtml(p.badges)}${extra(p)}${p.me ? ' <span class="tag">You</span>' : ''}</li>`).join('');
  return `<h2 class="section-title">${esc(sec.category)} ${badgeHtml([sec.badge])}</h2>
    ${lateDrop}
    <section class="card game">
      <div class="kicker">${g.phase === 'closed' ? 'Today' : 'Next game'}</div>
      <h1>${esc(dayOf(g.kickoff_at))}</h1>
      <div class="meta">${esc(timeOf(g.kickoff_at))} – ${esc(timeOf(g.ends_at))} · ${esc(g.location)}</div>
      <div class="spots"><b>${g.spots_taken}</b><span class="of">/${g.max_players}</span><span class="label">spots taken${g.waitlist_count ? ` · ${g.waitlist_count} waiting` : ''}</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      ${actionHtml(v, me)}
    </section>
    <section class="card">
      <h2>Playing (${v.confirmed.length})</h2>
      ${v.confirmed.length ? `<ol class="names">${names(v.confirmed, () => '')}</ol>`
        : `<p class="muted">No one yet${g.phase === 'open' ? ' — be the first!' : '.'}</p>`}
      ${v.paying_count ? `<p class="muted small">+ ${v.paying_count} paying right now</p>` : ''}
    </section>
    ${v.waitlist.length ? `<section class="card"><h2>Waitlist (${v.waitlist.length})</h2>
      <ol class="names">${names(v.waitlist, (p) => (p.offered ? ' <span class="tag warn">Spot offered</span>' : ''))}</ol></section>` : ''}
    ${sec.upcoming.length ? `<section class="card"><details><summary>Upcoming ${esc(sec.category)} (${sec.upcoming.length})</summary>
      ${sec.upcoming.map((u) => `<div class="row-item"><div class="who"><b>${esc(longDay(u.kickoff_at))}</b>
        <span>${u.cancelled ? 'Cancelled' : `${esc(timeOf(u.kickoff_at))} · sign-ups open ${esc(whenOf(u.opens_at))}, ${esc(dayOf(u.opens_at))}`}</span></div></div>`).join('')}
      </details></section>` : ''}`;
}

function renderHome() {
  const h = S.home;
  if (!h.sections.length) return renderPending();
  S.skew = new Date(h.server_now).getTime() - Date.now();
  const params = new URLSearchParams(location.search);
  let banner = '';
  const anyConfirmedNow = h.sections.some((s) => s.view && s.view.my && s.view.my.status === 'confirmed');
  if (params.get('paid')) {
    banner = anyConfirmedNow ? `<div class="notice ok"><b>Payment received — you're in!</b></div>`
      : `<div class="notice ok"><b>Payment received.</b> Confirming your spot…</div>`;
    if (anyConfirmedNow) history.replaceState(null, '', '/' + location.hash); else setTimeout(loadHome, 2500);
  } else if (params.get('checkout') === 'cancelled') {
    history.replaceState(null, '', '/' + location.hash);
    banner = `<div class="notice warn">You didn't finish paying. If your spot is still held, you can finish within a few minutes.</div>`;
  }
  const pendingOther = h.memberships.filter((m) => m.status === 'pending');
  const adminNote = h.me.is_admin && h.pending_requests ? `<a class="notice info row" href="#/admin/members" style="display:flex;text-decoration:none;color:inherit">
      <span><b>${h.pending_requests} membership request${h.pending_requests > 1 ? 's' : ''}</b> waiting for you</span><span class="tag warn">Review</span></a>` : '';

  app.innerHTML = `${topBar(h.me.is_admin ? `<a class="iconbtn" href="#/admin">Organizer${h.pending_requests ? ` <span class="dot">${h.pending_requests}</span>` : ''}</a>` : '<a class="iconbtn" href="#/profile">Profile</a>')}
    ${banner}${adminNote}
    <div class="me-line">${esc(h.me.full_name)} ${badgeHtml(h.me.badges)}</div>
    ${pendingOther.length ? `<div class="notice info small">Waiting for approval: ${pendingOther.map((m) => esc(m.category)).join(', ')}</div>` : ''}
    ${h.sections.map((s) => sectionHtml(s, h.me)).join('')}
    ${pushCard()}
    <section class="card small muted">
      <b style="color:var(--ink)">How it works</b><br>
      First come, first served. Drop before the deadline (shown on your spot) for a full refund; after that you're only refunded if someone takes your spot.
      If the game is full, join the waitlist for free and we'll notify you if a spot opens.
    </section>
    <nav class="foot"><a href="#/history">My games & payments</a><a href="#/profile">Profile</a>${h.me.is_admin ? '<a href="#/admin">Organizer</a>' : ''}</nav>`;

  app.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => handleAction(b.dataset.act, Number(b.dataset.game), b); });
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

async function handleAction(act, gameId, btn) {
  const sec = S.home.sections.find((s) => s.view && s.view.game.id === gameId);
  if (!sec) return;
  const g = sec.view.game, my = sec.view.my;
  if (act === 'pay') {
    btn.disabled = true; btn.textContent = 'One moment…';
    try {
      const r = await api('checkout', { game_id: gameId });
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
    try { const r = await rpc('drop_out', { p_game: gameId }); kick(); toast(r.message, 6000); } catch (e) { toast(e.message); }
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
      <span class="small">Tap the Share button at the bottom of Safari, then <b>Add to Home Screen</b>. Open Midwest FC from your home screen and tap "Turn on".
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
      ${d.games.length ? `<table class="simple"><tr><th>Game</th><th>Status</th></tr>${d.games.map((x) => `<tr><td>${esc(dayOf(x.kickoff_at))}<br><span class="muted small">${esc(x.category)}</span></td>
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
const phaseText = (g) => ({ upcoming: `Opens ${whenOf(g.opens_at)}, ${dayOf(g.opens_at)}`, open: `Open until ${whenOf(g.closes_at)}`, closed: 'Sign-ups closed', done: 'Finished', cancelled: 'Cancelled' }[g.phase]);

async function renderAdmin(tab, id) {
  const pend = S.home.pending_requests;
  const tabs = [['games', 'Games'], ['members', `Members${pend ? ` <span class="dot">${pend}</span>` : ''}`], ['message', 'Message'], ['settings', 'Settings'], ['history', 'History']];
  const shell = (inner) => `${topBar('<a class="iconbtn" href="#/">Player view</a>')}
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab || (tab === 'game' && k === 'games') ? 'on' : ''}">${l}</a>`).join('')}</nav>${inner}`;
  app.innerHTML = shell('<div class="loading"><div class="spinner"></div></div>');
  try {
    if (tab === 'game') return await adminGame(shell, Number(id));
    if (tab === 'games') return await adminGames(shell);
    if (tab === 'members') return await adminMembers(shell);
    if (tab === 'message') return await adminMessage(shell);
    if (tab === 'settings') return await adminSettings(shell);
    if (tab === 'history') return await adminHistory(shell);
    return await adminGames(shell);
  } catch (e) { app.innerHTML = shell(`<div class="card">${esc(e.message)}</div>`); }
}

async function adminGames(shell) {
  const d = await rpc('admin_schedule');
  const cats = d.categories;
  app.innerHTML = shell(`
    <div class="btn-row" style="margin-bottom:14px"><button class="btn dark" id="add-weekly">Add weekly games</button><button class="btn secondary" id="add-one">Add one game</button></div>
    ${cats.map((c) => {
      const list = d.games.filter((g) => g.category_id === c.id);
      return `<h2 class="section-title">${esc(c.name)} ${badgeHtml([c.badge])}</h2><section class="card">
        ${list.length ? list.map((g) => `<a class="row-item linkrow" href="#/admin/game/${g.id}">
          <div class="who"><b>${esc(dayOf(g.kickoff_at))} · ${esc(timeOf(g.kickoff_at))}</b><span>${esc(phaseText(g))}</span></div>
          <span class="tag ${g.phase === 'open' ? '' : 'grey'}">${g.spots_taken}/${g.max_players}</span><span class="chev">›</span></a>`).join('')
          : '<p class="muted">No games scheduled. Use "Add weekly games".</p>'}
      </section>`;
    }).join('')}`);
  const catOptions = cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  const addForm = (weekly) => `<form class="stack-form">
      <label>Group</label><select name="cat">${catOptions}</select>
      <label>${weekly ? 'First game date' : 'Game date'}</label><input name="first" type="date" required>
      ${weekly ? '<label>Last game date</label><input name="last" type="date" required>' : ''}
      <label>Kickoff time (blank = the group\'s usual time)</label><input name="time" type="time">
      <p class="muted small">Sign-ups open, the drop deadline and closing time follow the group's settings.</p></form>`;
  const add = async (weekly) => {
    const f = await modal({ title: weekly ? 'Add weekly games' : 'Add one game', html: addForm(weekly),
      buttons: [{ label: 'Add', cls: 'dark', value: true }, { label: 'Cancel', cls: 'secondary', value: false }] });
    if (!f || !f.first) return;
    try {
      const r = await rpc('admin_add_games', { p_category: f.cat, p_first: f.first, p_last: weekly ? f.last : f.first, p_time: f.time || null });
      toast(`${r.added} game${r.added === 1 ? '' : 's'} added`); adminGames(shell);
    } catch (e) { toast(e.message, 5000); }
  };
  document.getElementById('add-weekly').onclick = () => add(true);
  document.getElementById('add-one').onclick = () => add(false);
}

async function adminGame(shell, gameId) {
  const b = await rpc('admin_board', { p_game: gameId });
  const g = b.game, regs = b.registrations;
  const playing = regs.filter((r) => ['confirmed', 'holding'].includes(r.status));
  const waiting = regs.filter((r) => ['waitlisted', 'offered'].includes(r.status));
  const gone = regs.filter((r) => !['confirmed', 'holding', 'waitlisted', 'offered'].includes(r.status));
  const row = (r, i, movable) => `<div class="row-item">
      <div class="who"><b>${i + 1}. ${esc(r.name || r.email)} ${badgeHtml(r.badges)}</b><span>${esc(r.email)}${r.phone ? ' · ' + esc(r.phone) : ''}</span></div>
      ${r.status === 'holding' ? '<span class="tag warn">Paying…</span>' : r.status === 'offered' ? '<span class="tag warn">Offered</span>' : payTag(r)}
      ${movable ? `<button class="mini" data-move="up" data-id="${r.id}" aria-label="Move up">↑</button><button class="mini" data-move="down" data-id="${r.id}" aria-label="Move down">↓</button>` : ''}
      <button class="mini bad" data-remove="${r.id}" data-name="${esc(r.name || r.email)}" data-paid="${['authorized', 'captured'].includes(r.pay_state) ? 1 : 0}">✕</button>
    </div>`;
  app.innerHTML = shell(`
    <p class="small"><a href="#/admin/games">‹ All games</a></p>
    <section class="card"><h2>${esc(g.category)} ${badgeHtml([g.badge])}</h2>
      <p style="margin:0"><b>${esc(longDay(g.kickoff_at))}</b> · ${esc(timeOf(g.kickoff_at))} · ${esc(g.location)}</p>
      <p class="muted small" style="margin:4px 0 0">${esc(phaseText(g))} · drop deadline ${esc(whenOf(g.drop_deadline_at))}</p></section>
    ${b.failed_tasks ? `<div class="notice warn">${b.failed_tasks} payment action(s) failed. Check your Stripe dashboard.</div>` : ''}
    <div class="stats">
      <div class="stat"><b>${g.spots_taken}/${g.max_players}</b><span>Spots taken</span></div>
      <div class="stat"><b>${g.waitlist_count}</b><span>Waitlist</span></div>
      <div class="stat"><b>${money(b.collected_cents)}</b><span>Collected</span></div>
      <div class="stat"><b>${money(b.on_hold_cents)}</b><span>On hold (charged ${esc(whenOf(g.drop_deadline_at))})</span></div>
    </div>
    ${g.phase !== 'cancelled' ? `<div class="btn-row" style="margin-bottom:14px">
      <button class="btn dark" id="add-me">Add myself</button>
      <button class="btn secondary" id="add-player">Add a player</button>
    </div>` : ''}
    <section class="card"><h2>Playing (${playing.length})</h2>${playing.map((r, i) => row(r, i, true)).join('') || '<p class="muted">No one yet.</p>'}</section>
    <section class="card"><h2>Waitlist (${waiting.length})</h2>${waiting.map((r, i) => row(r, i, true)).join('') || '<p class="muted">Empty.</p>'}</section>
    ${gone.length ? `<section class="card"><details><summary>Dropped / removed (${gone.length})</summary>
      ${gone.map((r) => `<div class="row-item"><div class="who"><b>${esc(r.name || r.email)}</b><span>${esc(r.status)}${r.late_drop_refund ? ` · late drop, refund ${esc(r.late_drop_refund)}` : ''}</span></div>${payTag(r)}</div>`).join('')}
    </details></section>` : ''}
    ${g.phase !== 'cancelled' ? `<section class="card"><h2>Change this game</h2>
      <form id="eg">
        <label>Location</label><input name="loc" type="text" value="${esc(g.location)}">
        <div class="grid2">
          <div><label>Max players</label><input name="max" type="number" min="2" max="100" value="${g.max_players}"></div>
          <div><label>Kickoff</label><input name="ko" type="time" value="${fmt(g.kickoff_at, { hour: '2-digit', minute: '2-digit', hour12: false })}"></div>
        </div>
        <button class="btn secondary" style="margin-top:14px">Save changes</button>
      </form>
    </section>
    ${regs.length ? '<button class="btn danger" id="cancel-game">Cancel this game & refund everyone</button>'
      : '<button class="btn danger" id="delete-game">Remove this game from the schedule</button>'}` : ''}`);

  app.querySelectorAll('[data-move]').forEach((el) => {
    el.onclick = async () => { try { await rpc('admin_move', { p_reg: Number(el.dataset.id), p_direction: el.dataset.move }); adminGame(shell, gameId); } catch (e) { toast(e.message); } };
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
      try { await rpc('admin_remove', { p_reg: Number(el.dataset.remove), p_refund: choice === 'refund' }); kick(); toast('Removed'); adminGame(shell, gameId); } catch (e) { toast(e.message); }
    };
  });
  const addMe = document.getElementById('add-me');
  if (addMe) addMe.onclick = async () => {
    try { await rpc('admin_add', { p_game: gameId, p_user: S.home.me.id }); toast('You\'re on the list'); S.home = null; adminGame(shell, gameId); } catch (e) { toast(e.message, 5000); }
  };
  const addPlayer = document.getElementById('add-player');
  if (addPlayer) addPlayer.onclick = async () => {
    const m = await rpc('admin_members');
    const onList = new Set(regs.filter((r) => ['confirmed', 'holding', 'waitlisted', 'offered'].includes(r.status)).map((r) => r.user_id));
    const options = m.people.filter((p) => !onList.has(p.id) && p.name && (p.is_admin || (p.memberships[g.category_id] || {}).status === 'approved'));
    if (!options.length) return toast(`Every approved ${g.category} member is already on the list`);
    const pick = await modal({ title: 'Add a player', text: `Approved ${esc(g.category)} members. They're added for free (no card charge).`,
      buttons: [...options.slice(0, 40).map((p) => ({ label: p.name, cls: 'secondary', value: p.id })), { label: 'Cancel', cls: 'secondary', value: null }] });
    if (!pick) return;
    try { await rpc('admin_add', { p_game: gameId, p_user: pick }); kick(); toast('Added'); adminGame(shell, gameId); } catch (e) { toast(e.message, 5000); }
  };
  const eg = document.getElementById('eg');
  if (eg) eg.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await rpc('admin_update_game', { p_game: gameId, p_location: f.loc.value, p_max_players: Number(f.max.value), p_kickoff_time: f.ko.value || null }); kick(); toast('Game updated'); S.home = null; adminGame(shell, gameId); }
    catch (err) { toast(err.message, 5000); }
  };
  const cg = document.getElementById('cancel-game');
  if (cg) cg.onclick = async () => {
    const reason = await modal({ title: 'Cancel this game?', text: 'Everyone is refunded automatically and gets a notification. This can\'t be undone.',
      buttons: [{ label: 'Cancel game (bad weather)', cls: 'danger', value: 'bad weather' }, { label: 'Cancel game (other reason)', cls: 'danger', value: ' ' }, { label: 'Keep the game', cls: 'secondary', value: null }] });
    if (!reason) return;
    try { const r = await rpc('admin_cancel_game', { p_game: gameId, p_reason: reason.trim() }); kick(); toast(`Cancelled. ${r.players} player(s) notified.`); S.home = null; adminGame(shell, gameId); } catch (e) { toast(e.message); }
  };
  const dg = document.getElementById('delete-game');
  if (dg) dg.onclick = async () => {
    const ok = await modal({ title: 'Remove this game?', text: 'It disappears from the schedule. Nobody has signed up yet.',
      buttons: [{ label: 'Remove game', cls: 'danger', value: true }, { label: 'Keep it', cls: 'secondary', value: false }] });
    if (!ok) return;
    try { await rpc('admin_delete_game', { p_game: gameId }); toast('Game removed'); location.hash = '#/admin/games'; } catch (e) { toast(e.message, 6000); }
  };
}

async function adminMembers(shell) {
  const d = await rpc('admin_members');
  const cats = d.categories;
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const catBadge = Object.fromEntries(cats.map((c) => [c.id, c.badge]));
  const requests = [];
  d.people.forEach((p) => Object.entries(p.memberships).forEach(([cid, m]) => { if (m.status === 'pending' && catName[cid]) requests.push({ p, cid, at: m.requested_at }); }));
  requests.sort((a, b) => new Date(a.at) - new Date(b.at));
  const approvedBadges = (p) => badgeHtml(cats.filter((c) => (p.memberships[c.id] || {}).status === 'approved').map((c) => c.badge));
  app.innerHTML = shell(`
    <section class="card"><h2>Requests (${requests.length})</h2>
      ${requests.length ? requests.map((r) => `<div class="row-item">
        <div class="who"><b>${esc(r.p.name || '(no name yet)')}</b><span>${esc(r.p.email)}${r.p.phone ? ' · ' + esc(r.p.phone) : ''}</span>
          <span>Wants to join <b>${esc(catName[r.cid])}</b> · ${esc(dayOf(r.at))}</span></div>
        <button class="mini ok" data-mem="${r.p.id}" data-cat="${r.cid}" data-st="approved">Approve</button>
        <button class="mini bad" data-mem="${r.p.id}" data-cat="${r.cid}" data-st="declined">Decline</button></div>`).join('')
        : '<p class="muted">No requests waiting.</p>'}
    </section>
    <section class="card"><h2>Everyone (${d.people.length})</h2>
      <div class="filters">${['all', ...cats.map((c) => c.id)].map((f) => `<button class="chip ${f === 'all' ? 'on' : ''}" data-filter="${f}">${f === 'all' ? 'All' : esc(catName[f])}</button>`).join('')}</div>
      <input type="text" id="q" placeholder="Search name or email" style="margin:8px 0">
      <div id="pl">${d.people.map((p) => `<div class="person" data-q="${esc(((p.name || '') + ' ' + p.email).toLowerCase())}"
          data-cats="${cats.filter((c) => (p.memberships[c.id] || {}).status === 'approved').map((c) => c.id).join(' ')}">
        <div class="row-item"><div class="who"><b>${esc(p.name || '(no name yet)')} ${approvedBadges(p)}${p.is_admin ? ' <span class="tag">Organizer</span>' : ''}${p.blocked ? ' <span class="tag bad">Blocked</span>' : ''}</b>
          <span>${esc(p.email)}${p.phone ? ' · ' + esc(p.phone) : ''} · ${p.games_played} game(s)</span></div>
          <button class="mini" data-more="${p.id}">Manage</button></div>
      </div>`).join('')}</div>
    </section>`);

  app.querySelectorAll('[data-mem]').forEach((el) => {
    el.onclick = async () => {
      try { await rpc('admin_set_membership', { p_user: el.dataset.mem, p_category: el.dataset.cat, p_status: el.dataset.st }); kick();
        toast(el.dataset.st === 'approved' ? 'Approved ✓ — they\'ve been emailed' : 'Declined'); S.home = await rpc('get_home'); adminMembers(shell); } catch (e) { toast(e.message); }
    };
  });
  const filterAndSearch = () => {
    const q = document.getElementById('q').value.toLowerCase();
    const f = app.querySelector('.chip.on').dataset.filter;
    app.querySelectorAll('#pl .person').forEach((el) => {
      el.style.display = el.dataset.q.includes(q) && (f === 'all' || el.dataset.cats.split(' ').includes(f)) ? '' : 'none';
    });
  };
  document.getElementById('q').oninput = filterAndSearch;
  app.querySelectorAll('.chip').forEach((c) => { c.onclick = () => { app.querySelectorAll('.chip').forEach((x) => x.classList.remove('on')); c.classList.add('on'); filterAndSearch(); }; });
  app.querySelectorAll('[data-more]').forEach((el) => {
    el.onclick = async () => {
      const p = d.people.find((x) => x.id === el.dataset.more);
      const isMe = p.id === S.home.me.id;
      const buttons = [];
      cats.forEach((c) => {
        const st = (p.memberships[c.id] || {}).status;
        if (st === 'approved') buttons.push({ label: `Remove from ${c.name}`, cls: 'secondary', value: ['removed', c.id] });
        else buttons.push({ label: `Approve for ${c.name}`, cls: 'dark', value: ['approved', c.id] });
      });
      if (!isMe) buttons.push({ label: p.is_admin ? 'Remove as organizer' : 'Make organizer', cls: 'secondary', value: ['org', !p.is_admin] });
      if (!isMe && !p.is_admin) buttons.push({ label: p.blocked ? 'Unblock' : 'Block', cls: p.blocked ? 'secondary' : 'danger', value: ['block', !p.blocked] });
      buttons.push({ label: 'Close', cls: 'secondary', value: null });
      const statusLine = cats.map((c) => `${esc(c.name)}: <b>${esc((p.memberships[c.id] || {}).status || 'not a member')}</b>`).join('<br>');
      const choice = await modal({ title: p.name || p.email, text: `${esc(p.email)}<br>${statusLine}`, buttons });
      if (!choice) return;
      try {
        if (choice[0] === 'org') await rpc('admin_set_organizer', { p_user: p.id, p_on: choice[1] });
        else if (choice[0] === 'block') await rpc('admin_block', { p_user: p.id, p_blocked: choice[1] });
        else await rpc('admin_set_membership', { p_user: p.id, p_category: choice[1], p_status: choice[0] });
        kick(); toast('Updated'); S.home = await rpc('get_home'); adminMembers(shell);
      } catch (e) { toast(e.message, 5000); }
    };
  });
}

async function adminMessage(shell) {
  const d = await rpc('admin_schedule');
  const games = d.games.filter((g) => g.phase !== 'done');
  app.innerHTML = shell(`<form class="card" id="m"><h2>Message players</h2>
    <p class="muted small">Goes to everyone signed up for the chosen game (playing and waitlist), by email and notification.</p>
    <label>Game</label><select name="g">${games.map((g) => `<option value="${g.id}">${esc(g.category)} · ${esc(dayOf(g.kickoff_at))} (${g.spots_taken + g.waitlist_count} signed up)</option>`).join('')}</select>
    <label>Title</label><input name="t" type="text" placeholder="e.g. Bring a dark shirt">
    <label>Message</label><textarea name="b" required placeholder="Write your message"></textarea>
    <button class="btn" style="margin-top:14px">Send</button></form>`);
  document.getElementById('m').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await rpc('admin_message', { p_game: Number(e.target.g.value), p_title: e.target.t.value, p_body: e.target.b.value }); kick(); toast(`Sent to ${r.sent_to} player(s)`); e.target.reset(); } catch (err) { toast(err.message); }
  };
}

async function adminSettings(shell) {
  const d = await rpc('admin_settings');
  const s = d.settings;
  const t = (v) => String(v).slice(0, 5);
  const daySel = (name, v) => `<select name="${name}">${DAYS.map((x, i) => `<option value="${i}" ${i === v ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  app.innerHTML = shell(`
    ${d.categories.map((c) => `<form class="card cat-form" data-cat="${esc(c.id)}"><h2>${esc(c.name)} ${badgeHtml([c.badge])}</h2>
      <p class="muted small">Used for new games you add. Games already on the schedule keep their own details (change those under Games).</p>
      <label>Name</label><input name="name" type="text" value="${esc(c.name)}">
      <div class="grid2">
        <div><label>Price ($)</label><input name="price" type="number" step="0.01" min="0.50" value="${(c.price_cents / 100).toFixed(2)}"></div>
        <div><label>Max players</label><input name="max_players" type="number" min="2" max="100" value="${c.max_players}"></div>
      </div>
      <label>Location</label><input name="location" type="text" value="${esc(c.location)}">
      <div class="grid2">
        <div><label>Kickoff</label><input name="kickoff_time" type="time" value="${t(c.kickoff_time)}"></div>
        <div><label>Length (minutes)</label><input name="duration_minutes" type="number" value="${c.duration_minutes}"></div>
        <div><label>Sign-ups open day</label>${daySel('opens_dow', c.opens_dow)}</div>
        <div><label>Open time</label><input name="opens_time" type="time" value="${t(c.opens_time)}"></div>
        <div><label>Drop deadline day</label>${daySel('drop_deadline_dow', c.drop_deadline_dow)}</div>
        <div><label>Deadline time</label><input name="drop_deadline_time" type="time" value="${t(c.drop_deadline_time)}"></div>
        <div><label>Close sign-ups (min before)</label><input name="close_minutes_before" type="number" value="${c.close_minutes_before}"></div>
      </div>
      <button class="btn secondary" style="margin-top:16px">Save ${esc(c.name)}</button></form>`).join('')}
    <form class="card" id="club"><h2>Club-wide</h2>
      <label>Club name</label><input name="club_name" type="text" value="${esc(s.club_name)}">
      <div class="grid2">
        <div><label>Checkout hold (min)</label><input name="hold_minutes" type="number" value="${s.hold_minutes}"></div>
        <div><label>Waitlist offer (min)</label><input name="offer_minutes" type="number" value="${s.offer_minutes}"></div>
        <div><label>Offer on game day (min)</label><input name="late_offer_minutes" type="number" value="${s.late_offer_minutes}"></div>
        <div></div>
        <div><label>Pause offers from</label><input name="quiet_start" type="time" value="${t(s.quiet_start)}"></div>
        <div><label>Pause offers until</label><input name="quiet_end" type="time" value="${t(s.quiet_end)}"></div>
      </div>
      <button class="btn secondary" style="margin-top:16px">Save club settings</button></form>`);
  app.querySelectorAll('.cat-form').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const p = { ...f, price_cents: Math.round(Number(f.price) * 100) };
      delete p.price;
      try { await rpc('admin_update_category', { p_category: form.dataset.cat, p }); toast('Saved'); } catch (err) { toast(err.message, 5000); }
    };
  });
  document.getElementById('club').onsubmit = async (e) => {
    e.preventDefault();
    try { await rpc('admin_update_settings', { p: Object.fromEntries(new FormData(e.target)) }); toast('Saved'); } catch (err) { toast(err.message, 5000); }
  };
}

async function adminHistory(shell) {
  const [games, pays] = await Promise.all([rpc('admin_games'), rpc('admin_payments')]);
  app.innerHTML = shell(`<section class="card"><h2>Past games</h2>
    ${games.length ? `<table class="simple"><tr><th>Game</th><th>Players</th><th>Collected</th></tr>
    ${games.map((g) => `<tr><td>${esc(dayOf(g.kickoff_at))}<br><span class="muted small">${esc(g.category)}</span>${g.cancelled ? ' <span class="tag grey">Cancelled</span>' : ''}</td><td>${g.players}</td><td>${money(g.collected_cents)}</td></tr>`).join('')}</table>`
      : '<p class="muted">No past games yet.</p>'}</section>
    <section class="card"><h2>Payments</h2><p class="muted small">${pays.length} payment record(s).</p>
    <button class="btn secondary" id="csv">Download spreadsheet (CSV)</button></section>`);
  document.getElementById('csv').onclick = () => {
    const rows = [['Date', 'Group', 'Game', 'Player', 'Email', 'Type', 'Amount', 'Stripe reference']];
    for (const p of pays) rows.push([fmt(p.date, { dateStyle: 'short', timeStyle: 'short' }), p.category || '', p.game ? dayOf(p.game) : '', p.player || '', p.email || '', p.kind, (p.amount_cents / 100).toFixed(2), p.stripe_ref || '']);
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'midwest-fc-payments.csv';
    a.click();
  };
}

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
S.session = stored('fs_session');
// Signing in from the link in the email: the sign-in details arrive in the address bar.
if (location.hash.includes('access_token=')) {
  const p = new URLSearchParams(location.hash.slice(1));
  setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: Number(p.get('expires_in') || 3600) });
  history.replaceState(null, '', '/');
} else if (location.hash.includes('error_description=')) {
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', '/');
  setTimeout(() => toast(p.get('error_description') || 'That sign-in link didn\'t work. Please request a new one.', 6000), 300);
}
route();
