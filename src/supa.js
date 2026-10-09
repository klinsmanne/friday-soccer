// Talking to the Supabase database from the server.

function serviceHeaders(env) {
  const key = String(env.SUPABASE_SERVICE_KEY || '').replace(/\s+/g, '');
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const h = { apikey: key, 'Content-Type': 'application/json' };
  // Older-style keys are JWTs and also go in the Authorization header; new "sb_secret_" keys must not.
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

// Calls a database function with full (server) privileges.
export async function rpc(env, fn, args = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: serviceHeaders(env),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch {}
    throw new Error(`Database error in ${fn}: ${String(msg).slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Checks a player's sign-in token and returns their user record.
export async function getUser(env, token) {
  if (!token) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}
