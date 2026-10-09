// Local preview server: serves the website and fakes Supabase/Stripe using a local Postgres.
// node tests/devserver.mjs <database> [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

const DB = process.argv[2] || 'dev';
const PORT = Number(process.argv[3] || 8787);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let fakeNow = process.env.FAKE_NOW || '';

const lit = (v) => v === null || v === undefined ? 'null'
  : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : typeof v === 'object' ? `$j$${JSON.stringify(v)}$j$::jsonb` : `$q$${v}$q$`;

function sql(q, sub) {
  const pre = [`set test.now = '${fakeNow}';`, sub ? `set request.jwt.claim.sub = '${sub}';` : ''].join(' ');
  return new Promise((resolve, reject) => {
    execFile('psql', ['-h', '/tmp/pg', '-U', 'postgres', '-X', '-q', '-t', '-A', '-d', DB, '-c', pre, '-c', q], (err, out, errout) => {
      if (err) reject(new Error((errout || err.message).replace(/^.*ERROR:\s*/s, '').split('\n')[0]));
      else resolve(out.trim());
    });
  });
}
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const userFrom = (req) => (req.headers.authorization || '').replace('Bearer dev:', '') || null;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/__time') { fakeNow = url.searchParams.get('t') || ''; return send(res, 200, { now: fakeNow }); }
    if (p === '/api/config') return send(res, 200, { supabaseUrl: `http://localhost:${PORT}/sb`, supabaseKey: 'dev', vapidPublicKey: null });
    if (p === '/sb/auth/v1/otp') return send(res, 200, {});
    if (p === '/sb/auth/v1/verify') {
      const { email, token } = await body(req);
      if (token !== '123456') return send(res, 400, { msg: 'Token has expired or is invalid' });
      let id = await sql(`select id from auth.users where email = ${lit(email)}`);
      if (!id) id = await sql(`insert into auth.users (email) values (${lit(email)}) returning id`);
      return send(res, 200, { access_token: 'dev:' + id, refresh_token: 'r', expires_in: 3600 });
    }
    if (p === '/sb/auth/v1/logout') return send(res, 200, {});
    if (p.startsWith('/sb/rest/v1/rpc/')) {
      const fn = p.split('/').pop();
      const args = await body(req);
      const call = `select to_json(public.${fn}(${Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')}))`;
      try { return send(res, 200, JSON.parse((await sql(call, userFrom(req))) || 'null')); }
      catch (e) { return send(res, 400, { message: e.message }); }
    }
    if (p === '/api/checkout') {
      const uid = userFrom(req);
      const claim = JSON.parse(await sql(`select to_json(claim_spot(${lit(uid)}))`));
      if (claim.error) return send(res, 400, { error: claim.error });
      if (claim.action !== 'pay') return send(res, 200, claim);
      // Pretend the player paid on Stripe.
      await sql(`select attach_checkout(${claim.registration_id}, 'cs_dev_${claim.registration_id}_${Date.now()}', 'u')`);
      await sql(`select payment_completed(null, ${claim.registration_id}, 'pi_dev_${Date.now()}', ${claim.amount_cents}, ${claim.capture === 'automatic'})`);
      return send(res, 200, { action: 'redirect', url: '/?paid=1' });
    }
    if (p === '/api/kick') return send(res, 200, { ok: true });
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    send(res, 404, { error: e.message });
  }
}).listen(PORT, () => console.log(`preview on http://localhost:${PORT} (db ${DB})`));
