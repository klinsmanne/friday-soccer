// The work that runs every minute: game rules, Stripe follow-ups, notifications.
import { rpc } from './supa.js';
import { stripe, stripeMode, StripeError } from './stripe.js';
import { generateVapidKeys, sendPing } from './push.js';
import { sendEmails } from './mail.js';

let setupDone = false;     // remembered while this server instance stays warm
let vapidCache = null;

export function siteUrl(env) {
  return String(env.SITE_URL || '').replace(/\/+$/, '');
}

export async function getVapid(env) {
  if (vapidCache) return vapidCache;
  let pub = await rpc(env, 'get_secret', { p_key: 'vapid_public' });
  let priv = await rpc(env, 'get_secret', { p_key: 'vapid_private_jwk' });
  if (!pub || !priv) {
    const k = await generateVapidKeys();
    await rpc(env, 'set_secret', { p_key: 'vapid_private_jwk', p_value: k.privateJwk });
    await rpc(env, 'set_secret', { p_key: 'vapid_public', p_value: k.publicKey });
    pub = k.publicKey; priv = k.privateJwk;
  }
  vapidCache = { publicKey: pub, privateJwk: priv };
  return vapidCache;
}

export async function getWebhookSecret(env) {
  const raw = await rpc(env, 'get_secret', { p_key: `stripe_webhook_${stripeMode(env)}` });
  return raw ? JSON.parse(raw).secret : null;
}

// One-time setup the app does for itself: push keys, and telling Stripe where to send payment updates.
export async function ensureSetup(env) {
  if (setupDone) return;
  await getVapid(env);
  if (env.STRIPE_SECRET_KEY && siteUrl(env)) {
    const key = `stripe_webhook_${stripeMode(env)}`;
    const url = `${siteUrl(env)}/api/stripe-webhook`;
    const raw = await rpc(env, 'get_secret', { p_key: key });
    const saved = raw ? JSON.parse(raw) : null;
    if (!saved || saved.url !== url) {
      const ep = await stripe(env, 'POST', '/webhook_endpoints', {
        url,
        description: 'Friday Soccer sign-ups',
        enabled_events: ['checkout.session.completed', 'checkout.session.expired'],
      });
      await rpc(env, 'set_secret', { p_key: key, p_value: JSON.stringify({ id: ep.id, secret: ep.secret, url }) });
      if (saved && saved.id) {
        try { await stripe(env, 'DELETE', `/webhook_endpoints/${saved.id}`); } catch {}
      }
    }
  }
  setupDone = true;
}

async function doTask(env, t) {
  const idem = `task-${t.id}`;
  if (t.kind === 'expire_session') {
    if (!t.session_id) return { result: 'expired' };
    try {
      await stripe(env, 'POST', `/checkout/sessions/${t.session_id}/expire`, null, idem);
    } catch (e) {
      // Already expired or already paid: nothing left to close.
      if (!(e instanceof StripeError) || e.status >= 500) throw e;
    }
    return { result: 'expired' };
  }

  if (!t.payment_intent_id) return { result: 'nothing' };
  const pi = await stripe(env, 'GET', `/payment_intents/${t.payment_intent_id}`);

  if (t.kind === 'release_or_refund') {
    if (pi.status === 'requires_capture') {
      await stripe(env, 'POST', `/payment_intents/${pi.id}/cancel`, { cancellation_reason: 'requested_by_customer' }, idem);
      return { result: 'released', amount: pi.amount, ref: pi.id };
    }
    if (pi.status === 'succeeded') {
      const refund = await stripe(env, 'POST', '/refunds', { payment_intent: pi.id, reason: 'requested_by_customer' }, idem);
      return { result: 'refunded', amount: refund.amount, ref: refund.id };
    }
    if (pi.status === 'canceled') return { result: 'released', amount: pi.amount, ref: pi.id };
    throw new Error(`Payment is in state "${pi.status}", can't refund yet`);
  }

  if (t.kind === 'capture') {
    if (pi.status === 'requires_capture') {
      const done = await stripe(env, 'POST', `/payment_intents/${pi.id}/capture`, {}, idem);
      return { result: 'captured', amount: done.amount_received, ref: pi.id };
    }
    if (pi.status === 'succeeded') return { result: 'captured', amount: pi.amount_received, ref: pi.id };
    return { result: 'nothing' };
  }
  throw new Error(`Unknown task ${t.kind}`);
}

export async function processTasks(env, limit = 6) {
  if (!env.STRIPE_SECRET_KEY) return 0;
  const tasks = await rpc(env, 'take_tasks', { p_limit: limit });
  for (const t of tasks) {
    try {
      const r = await doTask(env, t);
      await rpc(env, 'task_done', { p_task: t.id, p_ok: true, p_result: r.result, p_amount: r.amount ?? null, p_ref: r.ref ?? null, p_error: null });
    } catch (e) {
      await rpc(env, 'task_done', { p_task: t.id, p_ok: false, p_result: null, p_amount: null, p_ref: null, p_error: String(e.message || e) });
    }
  }
  return tasks.length;
}

export async function processOutbox(env, connectFn, { limit = 20, maxPushes = 12 } = {}) {
  const items = await rpc(env, 'take_outbox', { p_limit: limit });
  if (!items.length) return 0;
  const site = siteUrl(env);

  // Email
  const emails = await sendEmails(env, connectFn, items.map((it) => ({
    to: it.email,
    subject: it.title,
    text: `Hi ${it.name || 'there'},\n\n${it.body}\n\nOpen the app: ${site || ''}\n\n— Friday Soccer`,
  })));

  // Push (best effort)
  const dead = [];
  let pushes = 0;
  const pushedOk = new Set();
  if (items.some((it) => it.subs.length)) {
    const v = await getVapid(env);
    for (const it of items) {
      for (const s of it.subs) {
        if (pushes >= maxPushes) break;
        pushes++;
        const r = await sendPing(s.endpoint, v.publicKey, v.privateJwk, `mailto:${env.GMAIL_USER || 'admin@example.com'}`);
        if (r === 'gone') dead.push(s.endpoint);
        if (r === 'sent') pushedOk.add(it.id);
      }
    }
  }

  const sent = [], failed = [];
  items.forEach((it, i) => {
    const e = emails[i];
    // If email isn't set up yet there's nothing to retry, so count it as done.
    if (e.ok || e.notConfigured) sent.push(it.id);
    else failed.push(it.id);
  });
  await rpc(env, 'outbox_result', { p_sent: sent, p_failed: failed, p_dead_endpoints: dead });
  return items.length;
}

export async function runTick(env, connectFn) {
  const log = {};
  try { await ensureSetup(env); } catch (e) { log.setup_error = String(e.message || e); }
  log.db = await rpc(env, 'tick_db', {});
  log.tasks = await processTasks(env);
  log.messages = await processOutbox(env, connectFn);
  return log;
}
