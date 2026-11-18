// Voller Groq-Schlüssel: Tageslimit pro Modell, nicht noch einmal anrufen, Zähler für Tokens/Tag
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'vais-fb-')), 'f.db')}`;
for (const k of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY']) delete process.env[k];
const KEY = 'gsk_fallback_test_key_123456';
process.env.GROQ_API_KEY = KEY;

let calls = 0;
let next = { status: 200, message: 'ok' };
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (u.endsWith('/models')) return json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3-turbo' }] });
  if (u.includes('/chat/completions') || u.includes('/audio/')) {
    calls += 1;
    const headers = { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '1000', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '8000' };
    if (next.status === 200) return json({ choices: [{ message: { content: 'hi' } }] }, 200, headers);
    return json({ error: { message: next.message } }, next.status, headers);
  }
  return json({}, 404);
};

const m = await import('../src/models.js');

test('TPD sperrt nur das betroffene Modell und sagt nicht, man solle ein Modell wählen', async () => {
  next = { status: 429, message: 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 200000' };
  await assert.rejects(
    () => m.complete({ model: 'groq:openai/gpt-oss-120b', messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      assert.equal(err.status, 429);
      assert.match(err.message, /Tageslimit von Groq/);
      assert.doesNotMatch(err.message, /Wähle|choose a model|Choose a model|anderes Modell wählen/i);
      return true;
    },
  );
  const rt = m.keyRuntime('groq', KEY);
  assert.equal(rt.usage.tpdExhausted, true);
  assert.equal(rt.usage.rpdExhausted, false);
  assert.equal(rt.usage.limits.reqLeft, 1000);
  assert.equal(rt.until, null);
  assert.equal(rt.state, 'partly');
  const after = calls;
  await assert.rejects(() => m.complete({ model: 'groq:openai/gpt-oss-120b', messages: [{ role: 'user', content: 'y' }] }), /nicht verfügbar/);
  assert.equal(calls, after, 'voller Schlüssel wird nicht noch einmal aufgerufen');
});

test('Whisper und ein anderes Groq-Modell laufen weiter, „quota“ sperrt nicht bis Mitternacht', async () => {
  const before = calls;
  next = { status: 200, message: 'ok' };
  await m.complete({ model: 'groq:whisper-large-v3-turbo', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls, before + 1);
  next = { status: 429, message: 'quota exceeded' };
  await assert.rejects(() => m.complete({ model: 'groq:qwen/qwen3.8-27b', messages: [{ role: 'user', content: 'x' }] }));
  const rt = m.keyRuntime('groq', KEY);
  assert.equal(rt.usage.tpdExhausted, true);
  assert.equal(rt.until, null);
  assert.notEqual(rt.state, 'full');
});

test('Tageslimit ohne Modellbezug sperrt den ganzen Schlüssel', async () => {
  next = { status: 429, message: 'daily limit reached' };
  await assert.rejects(() => m.complete({ model: 'groq:openai/gpt-oss-20b', messages: [{ role: 'user', content: 'x' }] }));
  const rt = m.keyRuntime('groq', KEY);
  assert.ok(rt.until > Date.now());
  assert.equal(rt.state, 'full');
  const after = calls;
  await assert.rejects(() => m.complete({ model: 'groq:whisper-large-v3-turbo', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(calls, after);
});
