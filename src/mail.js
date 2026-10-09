// Sends email through Gmail (SMTP over TLS, port 465). No libraries needed.

const enc = new TextEncoder();

export function b64utf8(s) {
  const bytes = enc.encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function wrap76(s) {
  return s.replace(/(.{76})/g, '$1\r\n');
}

export function buildMessage({ from, fromName, to, subject, text, date = new Date() }) {
  const id = `${crypto.randomUUID()}@friday-soccer`;
  return [
    `From: =?UTF-8?B?${b64utf8(fromName)}?= <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64utf8(text)),
  ].join('\r\n');
}

// Reads complete SMTP replies (handles multi-line "250-..." responses).
export function makeReplyReader(read) {
  const dec = new TextDecoder();
  let buf = '';
  return async function next() {
    for (;;) {
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3}( |$)/.test(lines[i])) {
          const text = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          return { code: Number(lines[i].slice(0, 3)), text };
        }
      }
      const { value, done } = await read();
      if (done) throw new Error('Email server closed the connection');
      buf += dec.decode(value, { stream: true });
    }
  };
}

// Sends several messages over one connection. Returns [{ok, error}] in the same order.
// `connectFn` is cloudflare:sockets' connect (passed in so this file can be tested elsewhere).
export async function sendEmails(env, connectFn, messages) {
  const results = messages.map(() => ({ ok: false, error: 'not sent' }));
  if (!messages.length) return results;
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    return messages.map(() => ({ ok: false, error: 'Email is not set up yet', notConfigured: true }));
  }
  const user = env.GMAIL_USER;
  const pass = String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, '');
  const socket = connectFn({ hostname: 'smtp.gmail.com', port: 465 }, { secureTransport: 'on' });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const next = makeReplyReader(() => reader.read());
  const send = (line) => writer.write(enc.encode(line + '\r\n'));
  const expect = async (codes, step) => {
    const r = await next();
    if (!codes.includes(r.code)) throw new Error(`${step}: ${r.text}`);
    return r;
  };
  try {
    await expect([220], 'greeting');
    await send('EHLO friday-soccer'); await expect([250], 'EHLO');
    await send('AUTH LOGIN'); await expect([334], 'AUTH');
    await send(b64utf8(user)); await expect([334], 'AUTH user');
    await send(b64utf8(pass)); await expect([235], 'Gmail login (check the app password)');
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      await send(`MAIL FROM:<${user}>`); await expect([250], 'MAIL FROM');
      await send(`RCPT TO:<${m.to}>`);
      const rcpt = await next();
      if (![250, 251].includes(rcpt.code)) {
        results[i] = { ok: false, error: `recipient refused: ${rcpt.text}` };
        await send('RSET'); await expect([250], 'RSET');
        continue;
      }
      await send('DATA'); await expect([354], 'DATA');
      await writer.write(enc.encode(buildMessage({ from: user, fromName: 'Friday Soccer', ...m }) + '\r\n.\r\n'));
      await expect([250], 'send');
      results[i] = { ok: true };
    }
    await send('QUIT');
  } catch (e) {
    for (const r of results) if (!r.ok && r.error === 'not sent') r.error = String(e.message || e);
  } finally {
    try { await socket.close(); } catch {}
  }
  return results;
}
