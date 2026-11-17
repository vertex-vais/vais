// Ein API-Key-Bereich: alte Klartext-Schlüssel werden verschlüsselt übernommen, eine Liste für alle Anbieter
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'apex-uk-')), 'u.db')}`;
process.env.KEY_ENCRYPTION_SECRET = 'unit-test-secret-apex-unified-keys';
for (const k of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'CURSOR_API_KEY', 'NVIDIA_API_KEY', 'GITHUB_MODELS_TOKEN']) delete process.env[k];
process.env.GROQ_API_KEY = 'gsk_env_render_key_1234567890zzzz';

const OLD_GROQ = 'gsk_old_plaintext_key_1234567890ab';
const OLD_OR = 'sk-or-old-plaintext-key-1234567890cd';
const db = await import('../src/db.js');
// So hat der frühere Bereich „API-Schlüssel“ gespeichert: Klartext-JSON in der Einstellung api_keys
await db.setSetting('api_keys', JSON.stringify({ groq: [OLD_GROQ], openrouter: [OLD_OR], unbekannt: ['xxxxxxxxxxxxxxxxxxxxxxxx'] }));

const pk = await import('../src/providerKeys.js');
const m = await import('../src/models.js');

test('Alte Klartext-Schlüssel werden beim Start verschlüsselt übernommen und aus der Einstellung gelöscht', async () => {
  assert.deepEqual(JSON.parse(await db.getSetting('api_keys', '{}')), {});
  const rows = await db.all('SELECT provider, label, secret, last4 FROM provider_api_keys ORDER BY id');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.provider).sort(), ['groq', 'openrouter']);
  for (const r of rows) {
    assert.ok(r.secret.startsWith('v1:'));
    assert.ok(!r.secret.includes(OLD_GROQ) && !r.secret.includes(OLD_OR));
  }
  assert.equal(pk.decryptSecret(rows.find((r) => r.provider === 'groq').secret), OLD_GROQ);
  // Laufzeit benutzt den übernommenen Schlüssel (vor der Render-Variable)
  assert.equal((await pk.getActiveProviderKey('groq')).key, OLD_GROQ);
});

test('Auch später noch im alten Format gespeicherte Schlüssel werden übernommen, ohne Doppelte', async () => {
  const LATE = 'gsk_late_plaintext_key_1234567890ef';
  await db.setSetting('api_keys', JSON.stringify({ groq: [OLD_GROQ, LATE] }));
  const out = await pk.migrateLegacy();
  assert.equal(out.moved, 2);
  assert.equal(out.kept, 0);
  const groq = await db.all("SELECT label FROM provider_api_keys WHERE provider = 'groq'");
  assert.equal(groq.length, 2);
  assert.deepEqual(JSON.parse(await db.getSetting('api_keys', '{}')), {});
  assert.ok(m.keyStatus().find((p) => p.provider === 'groq').keys.length >= 2);
});

test('Eine Liste für alle Anbieter: gespeichert + Render, nur maskiert, mit Verbrauch und eingestellt-Markierung', async () => {
  const data = await pk.listUnifiedKeys(m.keyRuntime);
  const dump = JSON.stringify(data);
  for (const secret of [OLD_GROQ, OLD_OR, process.env.GROQ_API_KEY]) assert.ok(!dump.includes(secret));
  const ids = data.providers.map((p) => p.id);
  for (const id of ['cursor', 'groq', 'openrouter', 'gemini', 'cerebras', 'mistral', 'nvidia', 'custom', 'github']) assert.ok(ids.includes(id), id);
  assert.equal(data.providers.find((p) => p.id === 'nvidia').adminOnly, true);
  const gh = data.providers.find((p) => p.id === 'github');
  assert.equal(gh.retired, true);
  assert.match(gh.retiredNote, /eingestellt/);
  const groq = data.providers.find((p) => p.id === 'groq');
  assert.deepEqual(groq.keys.map((k) => k.source), ['saved', 'saved', 'env']);
  assert.equal(groq.keys[2].masked, '••••zzzz');
  assert.equal(groq.keys[2].label, 'GROQ_API_KEY');
  assert.ok(groq.keys.every((k) => k.tracked && 'usage' in k && k.state === 'ok'));
  await assert.rejects(() => pk.addProviderKey({ provider: 'github', key: 'ghp_retired_token_1234567890abcd' }), /eingestellt/);
});

test('Bezeichnung ist optional; Test vor dem Speichern meldet abgelehnte Schlüssel', async () => {
  const row = await pk.addProviderKey({ provider: 'cerebras', key: 'csk-new-key-1234567890abcdwxyz' });
  assert.match(row.label, /Cerebras ••••wxyz/);
  const calls = [];
  const fake = async (url, opts) => { calls.push([String(url), opts?.headers?.Authorization]); return new Response('{}', { status: 401 }); };
  const r = await pk.testPlainKey({ provider: 'mistral', key: 'mistral-key-1234567890abcd' }, fake);
  assert.deepEqual(r, { ok: false, status: 401 });
  assert.equal(calls[0][0], 'https://api.mistral.ai/v1/models');
  const offline = await pk.testPlainKey({ provider: 'groq', key: 'gsk_x_1234567890abcdef' }, async () => { throw new Error('down'); });
  assert.deepEqual(offline, { ok: false, status: 0 });
});

test('Admin-Seite hat nur noch einen Schlüssel-Bereich', () => {
  const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
  assert.equal((html.match(/<h2[^>]*>API-(Keys|Schlüssel)<\/h2>/g) ?? []).length, 1);
  assert.ok(!html.includes('id="key-form"') && !html.includes('id="keys"'));
  assert.ok(!/api\('keys/.test(js));
});
