// Kurze Fragen gehen sofort an ein schnelles Modell. Eine Websuche bleibt beim großen Modell und schickt Werkzeuge mit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'vais-quick-')), 'q.db')}`;
for (const k of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'GITHUB_MODELS_TOKEN']) delete process.env[k];
process.env.GROQ_API_KEY = 'test-key-groq-0000000000';
process.env.DISABLE_FREE_IMAGES = 'true';

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('api.groq.com') && u.endsWith('/models')) {
    return json({ data: [
      { id: 'openai/gpt-oss-20b', active: true, owned_by: 'OpenAI' },
      { id: 'openai/gpt-oss-120b', active: true, owned_by: 'OpenAI' },
    ] });
  }
  if (u.endsWith('/chat/completions')) {
    calls.push(JSON.parse(opts.body));
    return json({ choices: [{ message: { role: 'assistant', content: 'Canberra.' }, finish_reason: 'stop' }] });
  }
  return json({}, 404);
};

const { runAgent } = await import('../src/agent.js');

async function ask(text) {
  calls.length = 0;
  let out = '';
  await runAgent({
    messages: [{ role: 'user', content: text }],
    onText: (s) => { out += s; },
    onStep: () => {},
    personal: {},
  });
  return { out, first: calls[0] };
}

test('Kurze Sachfrage: schnelles Modell, kein Werkzeug, Stream an', async () => {
  const { out, first } = await ask('Wie hauptstadt Australien');
  assert.match(out, /Canberra/);
  assert.equal(first.model, 'openai/gpt-oss-20b');
  assert.equal(first.stream, true);
  assert.equal(first.tools, undefined);
  assert.match(first.messages[0].content, /Kein Vorspann/);
  assert.match(first.messages[0].content, /Keine Schlussfrage/);
});

test('Wettersuche: großes Modell mit Werkzeugen, ohne Stream-Abbruch', async () => {
  const { first } = await ask('Wetter Berlin heute');
  assert.equal(first.model, 'openai/gpt-oss-120b');
  assert.equal(first.stream, false);
  assert.ok(first.tools?.some((tool) => tool.function?.name === 'web_search'));
});
