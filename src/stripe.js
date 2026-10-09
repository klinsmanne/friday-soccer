// Minimal Stripe API client (no libraries needed).

function encode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

export class StripeError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

export async function stripe(env, method, path, params, idempotencyKey) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Stripe-Version': '2024-06-20',
  };
  let body;
  if (params && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = encode(params);
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers, body });
  const data = await res.json();
  if (!res.ok) {
    const e = data.error || {};
    throw new StripeError(e.message || `Stripe error ${res.status}`, e.code, res.status);
  }
  return data;
}

export function stripeMode(env) {
  return String(env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test';
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Confirms a webhook really came from Stripe.
export async function verifyWebhook(payload, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const piece of header.split(',')) {
    const [k, v] = piece.split('=');
    if (k === 't') t = v;
    if (k === 'v1') sigs.push(v);
  }
  if (!t || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => safeEqual(s, mac));
}
