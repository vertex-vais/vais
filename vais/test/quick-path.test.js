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
let modelLists = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('api.groq.com') && u.endsWith('/models')) {
    modelLists += 1;
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

const { runAgent, fitToolText, shouldRetrySameModel } = await import('../src/agent.js');
const { stripUngrounded } = await import('../src/secrecy.js');
const { dateProblems, fixPageDates } = await import('../src/sitebuilder.js');

async function ask(text) {
  calls.length = 0;
  let out = '';
  await runAgent({
    messages: [{ role: 'user', content: text }],
    onText: (s) => { out += s; },
    onStep: () => {},
    personal: {},
  });
  return { out, first: calls[0], last: calls.at(-1) };
}

test('Kurze Sachfrage: schnelles Modell, kein Werkzeug, kaum Denken, keine Modellliste', async () => {
  modelLists = 0;
  const started = Date.now();
  const { out, first } = await ask('Wie hauptstadt Australien');
  const ms = Date.now() - started;
  console.log(`ApeX Messung kurze Frage: ${ms} ms bis zur Antwort (Mock)`);
  assert.ok(ms < 1500, `zu langsam: ${ms} ms`);
  assert.match(out, /Canberra/);
  assert.equal(first.model, 'llama-3.1-8b-instant');
  assert.equal(first.stream, true);
  assert.equal(first.reasoning_effort, undefined);
  assert.equal(first.tools, undefined);
  assert.equal(modelLists, 0);
  assert.match(first.messages[0].content, /Kein Vorspann/);
  assert.match(first.messages[0].content, /Keine Schlussfrage/);
});

test('Erfundene Suche und Denk-Notizen bleiben unsichtbar', () => {
  const raw = 'Der Nutzer möchte das Wetter.\nIch werde jetzt eine Suche starten.\nNach der Suche: sonnig [1]';
  const out = stripUngrounded(raw, { sources: false });
  assert.doesNotMatch(out, /Der Nutzer möchte|Ich werde jetzt|Nach der Suche|\[1\]/);
});

test('Countdown-Widerspruch und altes Silvester-Jahr werden erkannt und vereinheitlicht', () => {
  const html = '<p>SILVESTER 2025</p><b>364 Tage</b><b>43 Tage</b>';
  assert.ok(dateProblems(html, new Date('2026-11-18')).length >= 2);
  const fixed = fixPageDates(html, new Date('2026-11-18'));
  assert.match(fixed, /2026/);
  assert.match(fixed, /data-countdown/);
  assert.doesNotMatch(fixed, /364 Tage|43 Tage/);
  const icons = fixPageDates('<i class="fas fa-star"></i><div class="icon" style="background:#f5c518"></div><p>SILVESTER 2026</p>');
  assert.match(icons, /<svg class="icon"/);
  assert.doesNotMatch(icons, /fa-star|font-awesome|#f5c518/);
});

test('Suchtext wird auf ein Groq-Budget gekürzt, ein Tageslimit wechselt das Modell', () => {
  assert.ok(fitToolText('x'.repeat(3000)).length < 2000);
  assert.equal(fitToolText('kurz'), 'kurz');
  assert.equal(shouldRetrySameModel({ status: 413, message: 'Request too large' }), true);
  assert.equal(shouldRetrySameModel({ status: 429, raw: 'Rate limit reached, tokens per minute (TPM)' }), true);
  assert.equal(shouldRetrySameModel({ status: 429, raw: 'tokens per day (TPD)' }), false);
});

test('Bau-Auftrag blockiert den Chat nicht und startet einen Hintergrundjob', async () => {
  let started = null;
  const begun = Date.now();
  await runAgent({
    messages: [{ role: 'user', content: 'Bau mir bitte im Hintergrund eine kleine Webseite mit einem Countdown bis Silvester' }],
    onText: (s) => { started = (started || '') + s; },
    onStep: () => {},
    personal: {},
    onBackground: (spec) => { started = `${started}|${spec.title}`; },
  });
  assert.ok(Date.now() - begun < 1500);
  assert.match(started, /im Hintergrund/);
  assert.match(started, /Webseite/);
});

test('Wettersuche sucht selbst und schreibt mit einem schnellen Modell, nicht mit gpt-oss-120b', async () => {
  const { last } = await ask('Wetter Berlin heute');
  assert.notEqual(last?.model, 'openai/gpt-oss-120b');
  assert.equal(last?.tools, undefined);
});
