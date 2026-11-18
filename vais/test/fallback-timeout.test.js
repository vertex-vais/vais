// Zeitüberschreitung eines Anbieters beendet die Antwort nicht: das nächste schnelle Modell übernimmt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'vais-stall-')), 's.db')}`;
for (const k of ['OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'GITHUB_MODELS_TOKEN']) delete process.env[k];
process.env.GROQ_API_KEY = 'test-key-groq-0000000000';
process.env.GEMINI_API_KEY = 'test-key-gemini-00000000';
process.env.NVIDIA_API_KEY = 'test-key-nvidia-00000000';
process.env.DISABLE_FREE_IMAGES = 'true';

const calls = [];
let failAll = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('api.groq.com') && u.endsWith('/models')) {
    return json({ data: [
      { id: 'openai/gpt-oss-20b', active: true, owned_by: 'OpenAI' },
      { id: 'openai/gpt-oss-120b', active: true, owned_by: 'OpenAI' },
    ] });
  }
  if (u.includes('generativelanguage.googleapis.com') && u.includes('/models')) {
    return json({ models: [{ name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }] });
  }
  if (u.includes('integrate.api.nvidia.com') && u.endsWith('/models')) {
    return json({ data: [{ id: 'moonshotai/kimi-k3.1-pro', owned_by: 'moonshot' }] });
  }
  if (u.endsWith('/chat/completions')) {
    const body = JSON.parse(opts.body);
    calls.push({ host: u, model: body.model, stream: body.stream });
    if (failAll || u.includes('api.groq.com')) {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    return json({ choices: [{ message: { role: 'assistant', content: 'Hallo! Wie geht es dir?' }, finish_reason: 'stop' }] });
  }
  return json({}, 404);
};

const { runAgent, isSmallTalk, isQuick, canSwitchModel } = await import('../src/agent.js');

test('„Hallo“ ist Smalltalk, eine Recherche nicht', () => {
  assert.equal(isSmallTalk('Hallo'), true);
  assert.equal(isSmallTalk('Hi'), true);
  assert.equal(isSmallTalk('Bau mir eine Webseite'), false);
  assert.equal(isSmallTalk('Was ist die Hauptstadt von Frankreich?'), false);
});

test('Kurze Sachfragen sind schnell, Wetter und Bauen nicht', () => {
  assert.equal(isQuick('Wie hauptstadt Australien'), true);
  assert.equal(isQuick('Was ist die Hauptstadt von Frankreich?'), true);
  assert.equal(isQuick('Hallo'), true);
  assert.equal(isQuick('Wetter Berlin heute'), false);
  assert.equal(isQuick('Bau mir eine Webseite'), false);
});

test('Timeout ohne Status wechselt das Modell', () => {
  assert.equal(canSwitchModel({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' }), true);
  assert.equal(canSwitchModel({ name: 'AbortError', message: 'The operation was aborted due to timeout' }), true);
});

test('Groq-Timeout bei „Hallo“ nimmt Gemini Flash, nie Kimi', async () => {
  failAll = false;
  calls.length = 0;
  let out = '';
  const fallbacks = [];
  await runAgent({
    messages: [{ role: 'user', content: 'Hallo' }],
    onText: (s) => { out += s; },
    onStep: () => {},
    onFallback: (f) => fallbacks.push(f.to.id),
    personal: {},
  });
  assert.match(out, /Hallo/);
  assert.equal(calls[0].model, 'openai/gpt-oss-20b');
  assert.equal(calls[0].stream, true);
  assert.ok(calls.some((c) => c.model === 'gemini-3-flash'), calls.map((c) => c.model).join(','));
  assert.ok(!calls.some((c) => /kimi/i.test(c.model)));
  assert.ok(fallbacks.some((id) => id.startsWith('gemini:')));
  assert.doesNotMatch(out, /operation was aborted|aborted due to timeout/i);
});

test('Scheitern alle schnellen Modelle, kommt ein ruhiger deutscher Satz und kein Kimi', async () => {
  failAll = true;
  calls.length = 0;
  await assert.rejects(
    () => runAgent({
      messages: [{ role: 'user', content: 'Hallo' }],
      onText: () => {},
      onStep: () => {},
      personal: {},
    }),
    /Gerade antwortet kein Modell/,
  );
  assert.ok(calls.length >= 2);
  assert.ok(!calls.some((c) => /kimi/i.test(c.model)));
});
