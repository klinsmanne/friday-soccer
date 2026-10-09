// Server tests (run: node --import ./tests/cf-stub.mjs tests/server_test.mjs)
import assert from 'node:assert/strict';
import { verifyWebhook } from '../src/stripe.js';
import { generateVapidKeys, vapidAuthHeader } from '../src/push.js';
import { sendEmails, makeReplyReader, buildMessage } from '../src/mail.js';

let passed = 0;
const ok = (name) => { passed++; console.log('ok -', name); };

// --- Stripe webhook signatures ---
{
  const secret = 'whsec_test123';
  const payload = '{"id":"evt_1"}';
  const t = 1760000000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`))).toString('hex');
  assert.equal(await verifyWebhook(payload, `t=${t},v1=${mac}`, secret, 300, t + 10), true); ok('genuine Stripe message accepted');
  assert.equal(await verifyWebhook(payload + ' ', `t=${t},v1=${mac}`, secret, 300, t + 10), false); ok('tampered message rejected');
  assert.equal(await verifyWebhook(payload, `t=${t},v1=${mac}`, 'whsec_other', 300, t + 10), false); ok('wrong secret rejected');
  assert.equal(await verifyWebhook(payload, `t=${t},v1=${mac}`, secret, 300, t + 1000), false); ok('old (replayed) message rejected');
}

// --- Push (VAPID) signatures verify with the public key ---
{
  const k = await generateVapidKeys();
  const h = await vapidAuthHeader('https://web.push.apple.com/abc', k.publicKey, k.privateJwk, 'mailto:a@b.c', 1760000000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:a@b.c');
  const pub = await crypto.subtle.importKey('raw', Buffer.from(m[4], 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(m[3], 'base64url'), new TextEncoder().encode(`${m[1]}.${m[2]}`));
  assert.equal(valid, true); ok('push authorization is validly signed');
  assert.equal(Buffer.from(m[4], 'base64url').length, 65); ok('push public key has the right format');
}

// --- Email: talk to a fake Gmail server ---
function fakeSmtp(script) {
  // script: function(line) -> reply string; records everything written
  const written = [];
  let pending = ['220 smtp.gmail.com ESMTP ready\r\n'];
  let waiters = [];
  const push = (s) => { if (waiters.length) waiters.shift()({ value: new TextEncoder().encode(s), done: false }); else pending.push(s); };
  let inData = false, dataBuf = '';
  return {
    written,
    connect(addr, opts) {
      assert.equal(addr.hostname, 'smtp.gmail.com'); assert.equal(addr.port, 465); assert.equal(opts.secureTransport, 'on');
      return {
        writable: { getWriter: () => ({ write: async (bytes) => {
          const s = new TextDecoder().decode(bytes);
          if (inData) {
            dataBuf += s;
            if (dataBuf.endsWith('\r\n.\r\n')) { written.push({ data: dataBuf }); inData = false; dataBuf = ''; push('250 2.0.0 OK queued\r\n'); }
            return;
          }
          const line = s.replace(/\r\n$/, '');
          written.push(line);
          const reply = script(line);
          if (reply === '354') { inData = true; push('354 Go ahead\r\n'); return; }
          if (reply) push(reply + '\r\n');
        } }) },
        readable: { getReader: () => ({ read: () => pending.length
          ? Promise.resolve({ value: new TextEncoder().encode(pending.shift()), done: false })
          : new Promise((r) => waiters.push(r)) }) },
        close: async () => {},
      };
    },
  };
}
{
  const smtp = fakeSmtp((line) => {
    if (line.startsWith('EHLO')) return '250-smtp.gmail.com at your service\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8';
    if (line === 'AUTH LOGIN') return '334 VXNlcm5hbWU6';
    if (line === Buffer.from('club@example.com').toString('base64')) return '334 UGFzc3dvcmQ6';
    if (line === Buffer.from('abcdefghijklmnop').toString('base64')) return '235 2.7.0 Accepted';
    if (line.startsWith('MAIL FROM')) return '250 OK';
    if (line === 'RCPT TO:<bad@example.com>') return '550 No such user';
    if (line.startsWith('RCPT TO')) return '250 OK';
    if (line === 'RSET') return '250 OK';
    if (line === 'DATA') return '354';
    if (line === 'QUIT') return '221 bye';
    return '500 what';
  });
  const env = { GMAIL_USER: 'club@example.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' };
  const res = await sendEmails(env, smtp.connect, [
    { to: 'a@example.com', subject: 'You\'re in! ✓', text: 'Line one\n.\nSee you Friday ⚽' },
    { to: 'bad@example.com', subject: 'x', text: 'y' },
    { to: 'c@example.com', subject: 'Sign-ups are open', text: 'Go' },
  ]);
  assert.deepEqual(res.map((r) => r.ok), [true, false, true]); ok('emails sent; a bad address does not block the others');
  const data = smtp.written.find((w) => w.data).data;
  const body = data.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, '').replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString(), 'Line one\n.\nSee you Friday ⚽'); ok('email text (with emoji and a lone dot) arrives intact');
  assert.match(data, /Subject: =\?UTF-8\?B\?/); ok('subject encoded for emoji');
  const bad = await sendEmails({ GMAIL_USER: 'x', GMAIL_APP_PASSWORD: '' }, smtp.connect, [{ to: 'a', subject: 'b', text: 'c' }]);
  assert.equal(bad[0].notConfigured, true); ok('no crash when email is not set up yet');
}

// --- Worker: sign-up creates a correct Stripe checkout ---
{
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init });
    const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (url.endsWith('/auth/v1/user')) return init.headers.Authorization === 'Bearer good' ? j({ id: 'u1' }) : j({}, 401);
    if (url.endsWith('/rpc/claim_spot')) return j({ action: 'pay', registration_id: 42, amount_cents: 805, email: 'p@x.com',
      description: 'Friday Soccer — Friday, October 16, 10:00 PM at Ackerman Soccer', capture: 'manual', checkout_session_id: null });
    if (url.endsWith('/v1/checkout/sessions')) return j({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    if (url.endsWith('/rpc/attach_checkout')) return j(true);
    return j({ error: 'unexpected ' + url }, 500);
  };
  const { default: worker } = await import('../src/worker.js');
  const env = { SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'pk', SUPABASE_SERVICE_KEY: 'sb_secret_x',
                STRIPE_SECRET_KEY: 'sk_test_x', SITE_URL: 'https://soccer.example/' };
  const ctx = { waitUntil() {} };
  let r = await worker.fetch(new Request('https://soccer.example/api/checkout', { method: 'POST' }), env, ctx);
  assert.equal(r.status, 401); ok('checkout requires sign-in');
  r = await worker.fetch(new Request('https://soccer.example/api/checkout', { method: 'POST', headers: { Authorization: 'Bearer good' }, body: JSON.stringify({ game_id: 7 }) }), env, ctx);
  const out = await r.json();
  assert.equal(out.url, 'https://checkout.stripe.com/c/pay/cs_test_1'); ok('checkout returns the Stripe payment page');
  const sc = calls.find((c) => c.url.endsWith('/v1/checkout/sessions'));
  const params = new URLSearchParams(sc.init.body);
  assert.equal(params.get('payment_intent_data[capture_method]'), 'manual');
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), '805');
  assert.equal(params.get('metadata[registration_id]'), '42');
  assert.equal(params.get('success_url'), 'https://soccer.example/?paid=1');
  assert.equal(params.get('payment_method_types[0]'), 'card');
  ok('Stripe checkout: $8.05, card/Apple Pay/Google Pay, hold-then-charge, linked to the sign-up');
  const rpcCall = calls.find((c) => c.url.endsWith('/rpc/claim_spot'));
  assert.equal(rpcCall.init.headers.apikey, 'sb_secret_x');
  assert.equal(rpcCall.init.headers.Authorization, undefined); ok('server key sent the way new Supabase keys require');
  assert.deepEqual(JSON.parse(rpcCall.init.body), { p_user: 'u1', p_game: 7 }); ok('spot claimed for the signed-in player, for the chosen game');
}

console.log(`\n${passed} server checks passed`);
