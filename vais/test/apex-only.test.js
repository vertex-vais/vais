// Nur ApeX – für ALLE: auch Admins und Mods im Testmodus haben keine Module (Battle, Side by Side, Direkt, Agentenchats),
// keinen Modus-Umschalter und keine Web/Bild/Code-Schnellwahl. Testmodus heißt nur noch: Admin ohne Limits.
// Dieser Server läuft wie live – OHNE APEX_LEGACY_MODULES.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = String(5000 + Math.floor(Math.random() * 800));
const BASE = `http://localhost:${PORT}`;
let server;
let log = '';

before(async () => {
  const env = { ...process.env, PORT, DATABASE_URL: `file:${join(mkdtempSync(join(tmpdir(), 'vais-apexonly-')), 'a.db')}`, ADMIN_EMAILS: 'boss@example.com', AUTH_RATE_LIMIT: '1000', SIGNUPS_PER_IP_DAY: '1000', CODES_PER_IP_DAY: '1000' };
  for (const k of ['APEX_LEGACY_MODULES', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'BREVO_API_KEY', 'SMTP_HOST', 'GOOGLE_CLIENT_ID']) delete env[k];
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
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set?.includes('vais_session=')) cookie = set.split(';')[0];
    return res;
  };
  return { call, json: async (path, body) => { const r = await call(path, body); return { status: r.status, data: await r.json().catch(() => ({})) }; } };
}
const lastCode = () => [...log.matchAll(/(\d{6})\s*$/gm)].at(-1)?.[1];
async function signUp(email) {
  const c = client();
  await c.json('/api/auth/start', { email });
  assert.equal((await c.json('/api/auth/register', { email, password: 'geheim1234' })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await c.json('/api/auth/verify', { email, code: lastCode() })).status, 200);
  return c;
}
async function stream(c, chatId, text, turn = 0) {
  const res = await c.call('/api/chat/stream', { chatId, side: 0, turn, messages: [{ role: 'user', content: text }], display: { text } });
  const lines = (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, lines };
}
// Jeder Versuch, ein Modul zu starten, landet bei ApeX
async function assertApexOnly(c) {
  const models = (await c.json('/api/chat/models')).data;
  assert.equal(models.apexOnly, true);
  assert.deepEqual(models.models.map((m) => m.id), ['agent']);
  for (const body of [
    { mode: 'battle', modality: 'text', title: 'b' },
    { mode: 'sxs', modality: 'web', models: ['x', 'y'], title: 's' },
    { mode: 'direct', modality: 'image', models: ['x'], title: 'd' },
    { mode: 'life', title: 'l' },
  ]) {
    const start = await c.json('/api/chat/start', body);
    assert.equal(start.status, 200, JSON.stringify(start.data));
    const chat = (await c.json(`/api/chat/${start.data.id}`)).data;
    assert.equal(chat.mode, 'agent', `${body.mode} → ApeX`);
    assert.equal(chat.modality, 'auto');
  }
  assert.equal((await c.json('/api/chat/leaderboard')).status, 404);
  assert.equal((await c.json('/api/chat/vote', { chatId: 'x', winner: 'a' })).status, 404);
  const stats = (await c.json('/api/chat/stats')).data;
  assert.deepEqual(stats.favorites, []);
  assert.deepEqual(stats.mostUsed, []);
}

test('Admin mit Testmodus AN: trotzdem nur ApeX – Testmodus heißt nur „keine Limits“', async () => {
  await signUp('boss@example.com');
  const a = client();
  await a.json('/api/auth/login', { email: 'boss@example.com', password: 'geheim1234' });
  const on = (await a.json('/api/admin/test-mode', { on: true })).data;
  assert.equal(on.on, true);
  assert.equal(on.unlimited, true);
  const me = (await a.json('/api/auth/me')).data.user;
  assert.equal(me.testMode, true);
  assert.equal(me.unlimited, true);
  await assertApexOnly(a);
  assert.equal((await a.json('/api/chat/usage')).data.unlimited, true);
  // ApeX antwortet ganz normal (und entscheidet selbst, ob es sucht)
  const start = await a.json('/api/chat/start', { mode: 'agent', title: 'x' });
  const out = await stream(a, start.data.id, 'Erzähl mir einen Witz');
  assert.equal(out.status, 200);
  assert.ok(out.lines.some((l) => l.done));
  // Testmodus aus: weiterhin nur ApeX, jetzt mit normalen Limits
  assert.equal((await a.json('/api/admin/test-mode', { on: false })).data.on, false);
  await assertApexOnly(a);
  assert.equal((await a.json('/api/chat/usage')).data.unlimited, false);
});

test('Mod mit Testmodus AN: nur ApeX und weiterhin normale Limits', async () => {
  const m = await signUp('mod@example.com');
  const a = client();
  await a.json('/api/auth/login', { email: 'boss@example.com', password: 'geheim1234' });
  const id = (await a.json('/api/admin/users')).data.users.find((u) => u.email === 'mod@example.com').id;
  assert.equal((await a.json('/api/admin/role', { userId: id, role: 'mod' })).status, 200);
  assert.equal((await m.json('/api/admin/test-mode', { on: true })).data.on, true);
  assert.equal((await m.json('/api/auth/me')).data.user.unlimited, undefined);
  await assertApexOnly(m);
  assert.equal((await m.json('/api/chat/usage')).data.unlimited, false);
});

test('Normaler Nutzer: nur ApeX, Testmodus nicht setzbar', async () => {
  const u = await signUp('user@example.com');
  assert.equal((await u.json('/api/admin/test-mode', { on: true })).status, 404);
  assert.equal((await u.json('/api/auth/me')).data.user.testMode, undefined);
  await assertApexOnly(u);
});

test('Oberfläche: kein Modus-Umschalter, kein Modul-Menü, keine Web/Bild/Code-Schnellwahl – für niemanden', async () => {
  const c = client();
  await c.json('/api/auth/login', { email: 'boss@example.com', password: 'geheim1234' });
  const html = await (await c.call('/')).text();
  assert.match(html, /id="composer"/);
  assert.doesNotMatch(html, /id="mode-btn"|id="modality-btn"|id="mode-menu"|id="modality-menu"|id="mode-pills"|class="ctrl model-chip"/);
  const app = await (await fetch(`${BASE}/app.js`)).text();
  assert.doesNotMatch(app, /modeBtn|modalityBtn|renderModeMenu|toggleModeMenu|renderPills|Admin-Test/);
  assert.doesNotMatch(app, /ico: '🌐', label: \(\) => 'Web'|ico: '🎨'/);
  assert.match(app, /state\.mode = 'agent'; state\.modality = 'auto'; \/\/ alle/);
  assert.match(app, /async function refreshTestMode\(\)/); // Testmodus-Wechsel ohne Neuladen
  assert.match(app, /addEventListener\('pageshow'/);
  const admin = await (await fetch(`${BASE}/admin.js`)).text();
  assert.doesNotMatch(admin, /Test-Module/);
  const adminHtml = await (await c.call('/admin')).text();
  assert.doesNotMatch(adminHtml, /Test-Module|Battle, Direkt/);
  const tour = await (await fetch(`${BASE}/tour.js`)).text();
  assert.doesNotMatch(tour, /Battle|Side by Side|Direkt|Agentenchats|#mode-btn/);
  assert.match(tour, /ganz von selbst/); // ApeX sucht, malt und programmiert automatisch
});
