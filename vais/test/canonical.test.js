// Kanonische Adresse: Umleitung alter Hosts und bevorzugte öffentliche URL
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCanonical, publicOrigin, canonicalRedirect } from '../src/canonical.js';

process.env.DATABASE_URL = process.env.DATABASE_URL || `file:${join(mkdtempSync(join(tmpdir(), 'vais-canon-unit-')), 'u.db')}`;
const { telegramConfig } = await import('../src/telegram.js');

test('parseCanonical: gesetzt, leer oder ungültig', () => {
  assert.equal(parseCanonical({}), null);
  assert.equal(parseCanonical({ CANONICAL_URL: '' }), null);
  assert.equal(parseCanonical({ CANONICAL_URL: '  ' }), null);
  assert.equal(parseCanonical({ CANONICAL_URL: 'not-a-url' }), null);
  assert.equal(parseCanonical({ CANONICAL_URL: 'https://apex-35m7.onrender.com' }), 'https://apex-35m7.onrender.com');
  assert.equal(parseCanonical({ CANONICAL_URL: 'https://apex-35m7.onrender.com/' }), 'https://apex-35m7.onrender.com');
  assert.equal(parseCanonical({ CANONICAL_URL: 'https://apex-35m7.onrender.com/ignored' }), 'https://apex-35m7.onrender.com');
});

test('publicOrigin: CANONICAL_URL vor APP_URL und RENDER_EXTERNAL_URL', () => {
  assert.equal(publicOrigin(undefined, { CANONICAL_URL: 'https://apex-35m7.onrender.com/', APP_URL: 'https://old.example', RENDER_EXTERNAL_URL: 'https://other.onrender.com' }), 'https://apex-35m7.onrender.com');
  assert.equal(publicOrigin(undefined, { APP_URL: 'https://app.example/', RENDER_EXTERNAL_URL: 'https://render.example' }), 'https://app.example');
  assert.equal(publicOrigin(undefined, { RENDER_EXTERNAL_URL: 'https://render.example/' }), 'https://render.example');
  assert.equal(publicOrigin(undefined, {}), '');
  const req = { protocol: 'https', get: () => 'vais-dvvk.onrender.com' };
  assert.equal(publicOrigin(req, {}), 'https://vais-dvvk.onrender.com');
  assert.equal(publicOrigin(req, { CANONICAL_URL: 'https://apex-35m7.onrender.com' }), 'https://apex-35m7.onrender.com');
});

test('Telegram-Webhook nutzt CANONICAL_URL vor RENDER_EXTERNAL_URL', () => {
  const c = telegramConfig({
    TELEGRAM_BOT_TOKEN: '123456:SECRET-TOKEN-abcdefghijklmnop',
    RENDER_EXTERNAL_URL: 'https://vais-dvvk.onrender.com',
    APP_URL: 'https://old.example',
    CANONICAL_URL: 'https://apex-35m7.onrender.com/',
  });
  assert.equal(c.publicUrl, 'https://apex-35m7.onrender.com');
});

function fakeRes() {
  const res = { statusCode: 200, location: null, headers: {} };
  res.redirect = (code, url) => { res.statusCode = code; res.location = url; return res; };
  return res;
}

test('Middleware: 301 nur bei abweichendem Host und GET/HEAD', () => {
  const prev = process.env.CANONICAL_URL;
  process.env.CANONICAL_URL = 'https://apex-35m7.onrender.com';
  const run = (req) => {
    const res = fakeRes();
    let next = false;
    canonicalRedirect(req, res, () => { next = true; });
    return { res, next };
  };
  try {
    const base = { method: 'GET', path: '/login', originalUrl: '/login', get: () => 'vais-dvvk.onrender.com' };
    const moved = run(base);
    assert.equal(moved.next, false);
    assert.equal(moved.res.statusCode, 301);
    assert.equal(moved.res.location, 'https://apex-35m7.onrender.com/login');

    const withQuery = run({ ...base, path: '/s/abc', originalUrl: '/s/abc?x=1&y=2' });
    assert.equal(withQuery.res.location, 'https://apex-35m7.onrender.com/s/abc?x=1&y=2');

    const head = run({ ...base, method: 'HEAD' });
    assert.equal(head.res.statusCode, 301);

    const same = run({ ...base, get: () => 'apex-35m7.onrender.com' });
    assert.equal(same.next, true);
    assert.equal(same.res.statusCode, 200);

    const mixedCase = run({ ...base, get: () => 'Apex-35m7.onrender.com' });
    assert.equal(mixedCase.next, true);

    for (const path of ['/healthz', '/api/status', '/api/telegram/secret']) {
      const skip = run({ ...base, path, originalUrl: path });
      assert.equal(skip.next, true, path);
    }

    const post = run({ ...base, method: 'POST', path: '/api/auth/start', originalUrl: '/api/auth/start' });
    assert.equal(post.next, true);
  } finally {
    if (prev === undefined) delete process.env.CANONICAL_URL;
    else process.env.CANONICAL_URL = prev;
  }
});

test('Ohne CANONICAL_URL macht die Middleware nichts', () => {
  const prev = process.env.CANONICAL_URL;
  delete process.env.CANONICAL_URL;
  try {
    const res = fakeRes();
    let next = false;
    canonicalRedirect({ method: 'GET', path: '/', originalUrl: '/', get: () => 'vais-dvvk.onrender.com' }, res, () => { next = true; });
    assert.equal(next, true);
    assert.equal(res.statusCode, 200);
  } finally {
    if (prev !== undefined) process.env.CANONICAL_URL = prev;
  }
});

const PORT = String(5100 + Math.floor(Math.random() * 800));
const BASE = `http://localhost:${PORT}`;
const CANONICAL = 'https://apex-35m7.onrender.com';
let server;
let log = '';

before(async () => {
  const env = {
    ...process.env,
    PORT,
    CANONICAL_URL: CANONICAL,
    DATABASE_URL: `file:${join(mkdtempSync(join(tmpdir(), 'vais-canon-')), 'c.db')}`,
    AUTH_RATE_LIMIT: '1000',
    SIGNUPS_PER_IP_DAY: '1000',
    CODES_PER_IP_DAY: '1000',
  };
  for (const k of ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'BREVO_API_KEY', 'SMTP_HOST', 'GOOGLE_CLIENT_ID', 'APP_URL', 'RENDER_EXTERNAL_URL']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server startet nicht:\n${log}`);
});
after(() => server?.kill());

function call(path, { method = 'GET', host = 'vais-dvvk.onrender.com', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: Number(PORT),
      path,
      method,
      headers: { Host: host, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: { get: (name) => res.headers[name.toLowerCase()] ?? null },
          text: async () => buf.toString(),
          json: async () => JSON.parse(buf.toString()),
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('Live-Server: alter Host wird umgeleitet, kanonischer nicht', async () => {
  const res = await call('/login?next=1');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), `${CANONICAL}/login?next=1`);

  const same = await call('/login', { host: 'apex-35m7.onrender.com' });
  assert.equal(same.status, 200);
  const html = await same.text();
  assert.match(html, /property="og:url" content="https:\/\/apex-35m7\.onrender\.com\/"/);
  assert.match(html, /property="og:image" content="https:\/\/apex-35m7\.onrender\.com\/og\.jpg/);
});

test('Live-Server: healthz, Status und Telegram werden nicht umgeleitet', async () => {
  const health = await call('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('location'), null);
  assert.deepEqual(await health.json(), { ok: true });

  const status = await call('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('location'), null);

  const tg = await call('/api/telegram/testsecret');
  assert.notEqual(tg.status, 301);

  const post = await call('/api/auth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://vais-dvvk.onrender.com', 'Content-Length': String(Buffer.byteLength('{"email":"a@b.de"}')) },
    body: '{"email":"a@b.de"}',
  });
  assert.notEqual(post.status, 301);
});
