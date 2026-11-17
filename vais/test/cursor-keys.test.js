// Cursor-API-Keys: Verschlüsselung, Maske, Reihum, nur Admins
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'apex-ck-'));
process.env.DATABASE_URL = `file:${join(dir, 'k.db')}`;
process.env.KEY_ENCRYPTION_SECRET = 'unit-test-secret-apex-cursor-keys';
delete process.env.CURSOR_API_KEY;
for (const name of ['DATABASE_TOKEN', 'SMTP_PASS', 'BREVO_API_KEY', 'GOOGLE_CLIENT_SECRET']) delete process.env[name];

const ck = await import('../src/cursorKeys.js');
const KEY_A = 'crsr_alpha_key_1234567890aaaa';
const KEY_B = 'crsr_bravo_key_1234567890bbbb';

test('Verschlüsselung: hin und zurück, Geheimtext enthält den Schlüssel nicht', () => {
  const stored = ck.encryptSecret(KEY_A);
  assert.equal(ck.decryptSecret(stored), KEY_A);
  assert.equal(ck.decryptSecret(ck.encryptSecret(KEY_A)) !== stored, true);
  assert.ok(!stored.includes('crsr_alpha'));
  assert.equal(ck.decryptSecret(`${stored.slice(0, -4)}AAAA`), null);
  const prev = process.env.KEY_ENCRYPTION_SECRET;
  process.env.KEY_ENCRYPTION_SECRET = 'ein-anderes-geheimnis-123456';
  assert.equal(ck.decryptSecret(stored), null);
  process.env.KEY_ENCRYPTION_SECRET = prev;
  assert.equal(ck.decryptSecret(stored), KEY_A);
});

test('Maske zeigt nur die letzten 4 Zeichen', () => {
  assert.deepEqual(ck.maskKey(KEY_A), { last4: 'aaaa', masked: '••••aaaa' });
  assert.ok(!ck.maskKey(KEY_A).masked.includes('crsr_'));
});

test('Reihum, Pause nach 401/429, sonst CURSOR_API_KEY', async () => {
  ck.resetCursorRotation();
  const a = await ck.addCursorKey('Alpha', KEY_A);
  const b = await ck.addCursorKey('Bravo', KEY_B);
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push((await ck.getActiveCursorKey()).key);
  assert.deepEqual(seen, [KEY_A, KEY_B, KEY_A, KEY_B]);

  ck.noteCursorKeyFailure(a.id, 401);
  assert.equal((await ck.getActiveCursorKey()).key, KEY_B);
  assert.equal((await ck.getActiveCursorKey()).key, KEY_B);
  ck.noteCursorKeyFailure(a.id, 401, Date.now() - ck.CURSOR_COOLDOWN_MS[401] - 5);
  const again = [];
  for (let i = 0; i < 2; i++) again.push((await ck.getActiveCursorKey()).id);
  assert.deepEqual(again.sort(), [a.id, b.id].sort());

  ck.resetCursorRotation();
  ck.noteCursorKeyFailure(b.id, 429);
  assert.equal((await ck.getActiveCursorKey()).id, a.id);
  ck.noteCursorKeyFailure(b.id, 429, Date.now() - ck.CURSOR_COOLDOWN_MS[429] - 5);

  await ck.setCursorKeyEnabled(a.id, false);
  await ck.setCursorKeyEnabled(b.id, false);
  assert.equal(await ck.getActiveCursorKey(), null);
  process.env.CURSOR_API_KEY = 'crsr_env_fallback_key_9999zzzz';
  const env = await ck.getActiveCursorKey();
  assert.equal(env.source, 'env');
  assert.equal(env.key, process.env.CURSOR_API_KEY);
  assert.equal(env.masked, '••••zzzz');
  delete process.env.CURSOR_API_KEY;

  const pub = await ck.listCursorKeysPublic();
  const dumped = JSON.stringify(pub);
  assert.ok(!dumped.includes(KEY_A));
  assert.ok(!dumped.includes(KEY_B));
  assert.ok(dumped.includes('••••aaaa'));
  assert.equal(pub.encryption, 'env');
  assert.equal(pub.envConfigured, false);
});

test('Testen ruft /v0/me mit Basic-Auth auf und meldet OK oder Fehler', async () => {
  const row = (await ck.listCursorKeysPublic()).keys.find((k) => k.label === 'Alpha');
  await ck.setCursorKeyEnabled(row.id, true);
  let seen;
  const ok = await ck.testCursorKey(row.id, async (url, opts) => {
    seen = { url, auth: opts.headers.Authorization };
    return new Response(JSON.stringify({ apiKeyName: 'Alpha' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(seen.url, 'https://api.cursor.com/v0/me');
  assert.equal(seen.auth, `Basic ${Buffer.from(`${KEY_A}:`, 'utf8').toString('base64')}`);
  assert.deepEqual({ ok: ok.ok, message: ok.message }, { ok: true, message: 'OK' });
  assert.ok(!JSON.stringify(ok).includes(KEY_A));

  const bad = await ck.testCursorKey(row.id, async () => new Response('no', { status: 401 }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Fehler \(401\)/);
  assert.equal(await ck.getActiveCursorKey(), null);
});

test('Ohne KEY_ENCRYPTION_SECRET wird gewarnt und trotzdem ver- und entschlüsselt', () => {
  const db = `file:${join(dir, 'fallback.db')}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.DATABASE_URL = ${JSON.stringify(db)};
    delete process.env.KEY_ENCRYPTION_SECRET;
    for (const name of ['DATABASE_TOKEN', 'SMTP_PASS', 'BREVO_API_KEY', 'GOOGLE_CLIENT_SECRET', 'CURSOR_API_KEY']) delete process.env[name];
    const { encryptSecret, decryptSecret, encryptionSource } = await import(${JSON.stringify(new URL('../src/cursorKeys.js', import.meta.url).pathname)});
    if (encryptionSource() !== 'fallback') process.exit(3);
    const c = encryptSecret('crsr_fallback_key_1234567890');
    if (c.includes('crsr_fallback')) process.exit(4);
    if (decryptSecret(c) !== 'crsr_fallback_key_1234567890') process.exit(2);
  `], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /KEY_ENCRYPTION_SECRET/);
});

test('Panel vor Umgebung, NVIDIA nie für normale Nutzer, eigener Endpunkt', async () => {
  process.env.GROQ_API_KEY = 'gsk_env_fallback_key_123456zzzz';
  process.env.NVIDIA_API_KEY = 'nvapi-env-key-1234567890zzzz';
  const pk = await import('../src/providerKeys.js');
  const nv = await pk.addProviderKey({ provider: 'nvidia', label: 'NIM', key: 'nvapi-panel-key-1234567890abcd' });
  assert.equal(await pk.getActiveProviderKey('nvidia'), null);
  assert.equal(await pk.getActiveProviderKey('nvidia', { admin: false }), null);
  assert.equal(pk.peekProviderKey('nvidia'), null);
  assert.deepEqual(pk.keysForUser('nvidia'), []);
  const asAdmin = await pk.getActiveProviderKey('nvidia', { admin: true });
  assert.equal(asAdmin.source, 'admin');
  assert.equal(asAdmin.key, 'nvapi-panel-key-1234567890abcd');
  assert.equal(asAdmin.adminOnly, true);
  assert.ok(!JSON.stringify(await pk.listProviderKeysPublic()).includes('nvapi-panel'));

  const groq = await pk.addProviderKey({ provider: 'groq', label: 'Groq', key: 'gsk_panel_key_1234567890abcd' });
  assert.equal((await pk.getActiveProviderKey('groq')).key, 'gsk_panel_key_1234567890abcd');
  await pk.setProviderKeyEnabled(groq.id, false);
  assert.equal((await pk.getActiveProviderKey('groq')).source, 'env');
  await pk.setProviderKeyEnabled(groq.id, true);

  const models = await import('../src/models.js');
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    seen.push(String(opts.headers?.Authorization ?? ''));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await models.complete({ model: 'groq:openai/gpt-oss-120b', messages: [{ role: 'user', content: 'x' }] });
    assert.ok(seen[0].includes('gsk_panel_key_1234567890abcd'));
    assert.ok(!seen[0].includes('gsk_env_fallback'));
    const roster = models.keyStatus().find((p) => p.provider === 'groq');
    assert.ok(roster.keys.some((k) => k.source === 'panel'));
    assert.ok(roster.keys.some((k) => k.source === 'render'));
    assert.ok(!models.keyStatus().some((p) => p.provider === 'nvidia'));
  } finally { globalThis.fetch = orig; }

  const custom = await pk.addProviderKey({ provider: 'custom', label: 'Eigen', key: 'sk-custom-key-1234567890abcd', baseUrl: 'https://api.example.com/v1', model: 'my-model' });
  const got = await pk.getActiveProviderKey('custom');
  assert.equal(got.baseUrl, 'https://api.example.com/v1');
  assert.equal(got.model, 'my-model');
  assert.equal(got.id, custom.id);
  await assert.rejects(() => pk.addProviderKey({ provider: 'custom', label: 'Offen', key: 'sk-custom-key-22222222222222', baseUrl: 'http://example.com/v1', model: 'm' }));
  let called;
  const result = await pk.testProviderKey(custom.id, async (url, opts) => {
    called = { url, auth: opts.headers.Authorization };
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(called.url, 'https://api.example.com/v1/models');
  assert.equal(result.ok, true);
  await pk.removeProviderKey(nv.id);
  delete process.env.NVIDIA_API_KEY;
  delete process.env.GROQ_API_KEY;
});

const PORT = String(4600 + Math.floor(Math.random() * 800));
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let log = '';

before(async () => {
  const env = {
    ...process.env,
    PORT,
    DATABASE_URL: `file:${join(dir, 'http.db')}`,
    ADMIN_EMAILS: 'admin@example.com',
    KEY_ENCRYPTION_SECRET: 'http-test-secret-apex-cursor',
    AUTH_RATE_LIMIT: '1000',
    SIGNUPS_PER_IP_DAY: '1000',
    CODES_PER_IP_DAY: '1000',
  };
  delete env.CURSOR_API_KEY;
  for (const k of ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'BREVO_API_KEY', 'SMTP_HOST', 'GOOGLE_CLIENT_ID']) delete env[k];
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

function client() {
  let cookie = '';
  const call = async (path, body) => {
    const res = await fetch(BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: BASE },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set?.includes('vais_session=')) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  return { call };
}
const lastCode = () => [...log.matchAll(/(\d{6})\s*$/gm)].at(-1)?.[1];
async function signUp(email) {
  const c = client();
  assert.equal((await c.call('/api/auth/start', { email })).data.mode, 'register');
  assert.equal((await c.call('/api/auth/register', { email, password: 'geheim1234' })).status, 200);
  await new Promise((r) => setTimeout(r, 80));
  const v = await c.call('/api/auth/verify', { email, code: lastCode() });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return c;
}

test('Cursor-Keys nur für Admins, Antwort ohne den Schlüssel', async () => {
  const user = await signUp('normal@example.com');
  assert.equal((await user.call('/api/admin/cursor-keys')).status, 404);
  assert.equal((await user.call('/api/admin/cursor-keys', { label: 'Nein', key: KEY_A })).status, 404);
  const anon = await fetch(`${BASE}/api/admin/cursor-keys`);
  assert.equal(anon.status, 404);

  const admin = await signUp('admin@example.com');
  const added = await admin.call('/api/admin/cursor-keys', { label: 'Hauptkonto', key: KEY_A });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const dumped = JSON.stringify(added.data);
  assert.ok(!dumped.includes(KEY_A));
  assert.ok(dumped.includes('••••aaaa'));
  assert.equal(added.data.keys[0].label, 'Hauptkonto');
  assert.equal(added.data.keys[0].enabled, true);

  const off = await admin.call('/api/admin/cursor-keys/toggle', { id: added.data.keys[0].id, enabled: false });
  assert.equal(off.data.keys[0].enabled, false);
  const on = await admin.call('/api/admin/cursor-keys/toggle', { id: added.data.keys[0].id, enabled: true });
  assert.equal(on.data.keys[0].enabled, true);

  const users = await admin.call('/api/admin/users');
  const normal = users.data.users.find((u) => u.email === 'normal@example.com');
  assert.equal((await admin.call('/api/admin/role', { userId: normal.id, role: 'mod' })).status, 200);
  assert.equal((await user.call('/api/admin/cursor-keys')).status, 403);

  const removed = await admin.call('/api/admin/cursor-keys/remove', { id: added.data.keys[0].id });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.keys.length, 0);
  assert.ok(!JSON.stringify(removed.data).includes(KEY_A));
});
