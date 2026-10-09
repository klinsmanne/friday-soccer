// Friday Soccer server: serves the website, talks to Stripe, and runs the every-minute schedule.
import { connect } from 'cloudflare:sockets';
import { rpc, getUser } from './supa.js';
import { stripe, verifyWebhook } from './stripe.js';
import { runTick, getWebhookSecret, getVapid, siteUrl } from './tick.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

async function checkout(request, env) {
  const user = await getUser(env, bearer(request));
  if (!user) return json({ error: 'Please sign in again.' }, 401);

  const claim = await rpc(env, 'claim_spot', { p_user: user.id });
  if (claim.error) return json({ error: claim.error }, 400);
  if (claim.action !== 'pay') return json(claim);

  // Reuse the checkout page if it's still open (e.g. they tapped "Back").
  if (claim.checkout_session_id && claim.checkout_url) {
    try {
      const s = await stripe(env, 'GET', `/checkout/sessions/${claim.checkout_session_id}`);
      if (s.status === 'open') return json({ action: 'redirect', url: s.url });
    } catch {}
  }

  const site = siteUrl(env) || new URL(request.url).origin;
  const nowSec = Math.floor(Date.now() / 1000);
  const session = await stripe(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'],            // includes Apple Pay and Google Pay
    customer_email: claim.email,
    client_reference_id: String(claim.registration_id),
    metadata: { registration_id: String(claim.registration_id) },
    line_items: [{
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: claim.amount_cents, product_data: { name: claim.description } },
    }],
    payment_intent_data: {
      capture_method: claim.capture,
      description: claim.description,
      metadata: { registration_id: String(claim.registration_id) },
    },
    // Stripe needs at least 30 minutes; our own 10-minute hold closes the page sooner.
    expires_at: nowSec + 31 * 60,
    success_url: `${site}/?paid=1`,
    cancel_url: `${site}/?checkout=cancelled`,
  }, `checkout-${claim.registration_id}-${Math.floor(nowSec / 20)}`);

  await rpc(env, 'attach_checkout', { p_reg: claim.registration_id, p_session: session.id, p_url: session.url });
  return json({ action: 'redirect', url: session.url });
}

async function webhook(request, env, ctx) {
  const payload = await request.text();
  const secret = await getWebhookSecret(env);
  if (!(await verifyWebhook(payload, request.headers.get('Stripe-Signature'), secret))) {
    return json({ error: 'bad signature' }, 400);
  }
  const event = JSON.parse(payload);
  const s = event.data && event.data.object;

  if (event.type === 'checkout.session.completed' && s.status === 'complete' && s.payment_intent) {
    const piId = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id;
    const pi = await stripe(env, 'GET', `/payment_intents/${piId}`);
    if (pi.status === 'requires_capture' || pi.status === 'succeeded') {
      await rpc(env, 'payment_completed', {
        p_session: s.id,
        p_reg: Number((s.metadata && s.metadata.registration_id) || 0) || null,
        p_pi: pi.id,
        p_amount: pi.amount,
        p_captured: pi.status === 'succeeded',
      });
    }
  } else if (event.type === 'checkout.session.expired') {
    await rpc(env, 'checkout_expired', { p_session: s.id });
  }
  // Send "you're in" messages and any refunds right away instead of waiting for the next minute.
  ctx.waitUntil(runTick(env, connect).catch(() => {}));
  return json({ received: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/api/config') {
        let vapid = null;
        try { vapid = (await getVapid(env)).publicKey; } catch {}
        return json({ supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_ANON_KEY, vapidPublicKey: vapid });
      }
      if (path === '/api/health') {
        // Shows whether each connected service works (never shows any keys).
        const check = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return String(e.message || e).slice(0, 200); } };
        return json({
          database: await check(() => rpc(env, 'get_secret', { p_key: 'health' })),
          push_keys: await check(() => getVapid(env)),
          stripe: await check(() => stripe(env, 'GET', '/balance')),
          stripe_mode: String(env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test',
          email_configured: Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD),
          site_url: siteUrl(env),
        });
      }
      if (path === '/api/checkout' && request.method === 'POST') return await checkout(request, env);
      if (path === '/api/stripe-webhook' && request.method === 'POST') return await webhook(request, env, ctx);
      if (path === '/api/latest' && request.method === 'POST') {
        const { endpoint } = await request.json().catch(() => ({}));
        const msg = endpoint ? await rpc(env, 'latest_for_endpoint', { p_endpoint: endpoint }) : null;
        return json(msg || { title: 'Friday Soccer', body: 'Open the app for the latest update.' });
      }
      if (path === '/api/kick' && request.method === 'POST') {
        // After a player or the organizer changes something, process refunds/messages right away.
        const user = await getUser(env, bearer(request));
        if (!user) return json({ error: 'Please sign in again.' }, 401);
        ctx.waitUntil(runTick(env, connect).catch(() => {}));
        return json({ ok: true });
      }
      if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env, connect).then(
      (log) => console.log('tick', JSON.stringify(log)),
      (e) => console.error('tick failed', e && e.stack || e)));
  },
};
