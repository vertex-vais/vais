// Agent-Modus: Bau-Aufträge erkennen, planen → recherchieren → bauen → prüfen → überarbeiten,
// Programmier-Agent mit strikter Trennung, Geheimhaltung und keine Rückfragen-Kästen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'vais-loop-')), 'l.db')}`;
for (const k of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'CURSOR_AGENT_BUILDS', 'CURSOR_USER_DAILY_LIMIT', 'CURSOR_GLOBAL_DAILY_LIMIT']) delete process.env[k];
process.env.GROQ_API_KEY = 'test-key-groq-0000000000';
process.env.CURSOR_API_KEY = 'test-cursor-key-1234567890';
process.env.ADMIN_EMAILS = 'chef@example.com';
process.env.DISABLE_FREE_IMAGES = 'true';

let replies = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.endsWith('/models')) return json({ data: [{ id: 'openai/gpt-oss-120b', owned_by: 'OpenAI' }] });
  if (u.endsWith('/chat/completions')) return json({ choices: [{ message: { role: 'assistant', content: replies.length ? replies.shift() : 'Standard' }, finish_reason: 'stop' }] });
  return json({}, 404);
};

const { classifyTask, runBuildTask, analyzeHtml, composeBrief, buildRules } = await import('../src/agentloop.js');
const { scrubAnswer, scrubThoughts, plainQuestions } = await import('../src/secrecy.js');
const { mobileProblems } = await import('../src/sitecheck.js');
const { cursorBuild, cursorAvailable, agentName, cursorPrompt } = await import('../src/cursorAgent.js');
const { runAgent, validateHtml } = await import('../src/agent.js');

const GOOD_HTML = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vergleich</title><style>.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}@media (max-width:820px){[data-nav]{display:none}}</style></head><body><header id="nav"><a href="#a">A</a><button data-nav-toggle aria-label="Menü">☰</button><nav data-nav><a href="#b">B</a></nav></header><section id="hero"><h1>Vergleichen</h1></section></body></html>';
const BAD_NAV_HTML = GOOD_HTML.replace('<style>', '<style>.menu{display:flex;white-space:nowrap} .wrap{width:1100px}').replace(/<header[\s\S]*<\/header>/, '<header><nav class="menu"><a>Strom</a><a>Gas</a><a>Kredit</a><a>Reise</a><a>Handy</a><a>DSL</a></nav></header>');

test('Bau-Aufträge werden erkannt – Fragen und andere Wünsche nicht', () => {
  assert.deepEqual(classifyTask('Bau die CHECK24 App in rot nach'), { mode: 'build', kind: 'app', reference: true });
  assert.equal(classifyTask('Programmier mir ein Snake Spiel').kind, 'game');
  assert.equal(classifyTask('Kannst du mir eine Webseite für meinen Fußballverein bauen?').kind, 'website');
  for (const q of ['Wie baue ich eine Webseite?', 'Mach mir ein Logo', 'Erstelle eine Präsentation über Hunde', 'Erkläre Cursor Agenten', 'Ich mache gerade eine App, wie kann ich Login einbauen?', 'Hi']) assert.equal(classifyTask(q), null, q);
  // Gibt es schon eine Seite im Gespräch, läuft die Änderung über den normalen Ablauf
  assert.equal(classifyTask('Bau mir eine Todo App', { hasPage: true }), null);
});

test('Geheimhaltung: keine internen Werkzeug- oder Modellnamen, Code bleibt unberührt', () => {
  const out = scrubAnswer('Ich habe dafür `build_website` verwendet, nicht Cursor. Danach habe ich web_search genutzt.\n\n```js\nbuild_website()\n```');
  assert.doesNotMatch(out.replace(/```[\s\S]*```/, ''), /build_website|web_search|Cursor/);
  assert.match(out, /ApeX von VERTEX/);
  assert.match(out, /```js\nbuild_website\(\)\n```/);
  assert.match(scrubAnswer('Ich basiere auf Llama 3.'), /^Ich bin ApeX von VERTEX/);
  // Wissensfragen über Modelle bleiben erlaubt
  assert.equal(scrubAnswer('Gemini ist ein Modell von Google.'), 'Gemini ist ein Modell von Google.');
  assert.doesNotMatch(scrubThoughts('I should call build_website with gpt-oss now.'), /build_website|gpt-oss/);
});

test('Rückfragen- und Plan-Kästen werden zu normalem Text', () => {
  const out = plainQuestions('Kurz:\n\n```questions\nWofür ist die Seite? | Verein | Portfolio\nFarben?\n```\n\n```plan\n1. Planen\n2. Bauen\n```');
  assert.doesNotMatch(out, /```/);
  assert.match(out, /- Wofür ist die Seite\? \(z\. B\. Verein, Portfolio\)/);
  assert.match(out, /1\. Planen\n2\. Bauen/);
});

test('Handy-Prüfung findet überlaufende Navigation und feste Breiten', () => {
  const bad = mobileProblems(BAD_NAV_HTML);
  assert.ok(bad.some((p) => /Navigation hat 6 Links/.test(p)), bad.join('\n'));
  assert.ok(bad.some((p) => /white-space:nowrap/.test(p)));
  assert.ok(bad.some((p) => /1100px/.test(p)));
  assert.deepEqual(mobileProblems(GOOD_HTML), []);
});

test('Vorlage analysieren: Navigation, Überschriften, Farben', () => {
  const info = analyzeHtml('<title>CHECK24</title><meta name="theme-color" content="#063773"><header><nav><a>Strom</a><a>Kfz</a></nav></header><h1>Vergleichen &amp; sparen</h1><button>Jetzt vergleichen</button><style>.a{color:#063773}.b{color:#063773}.c{background:#ffbb1c}</style>');
  assert.equal(info.title, 'CHECK24');
  assert.deepEqual(info.nav, ['Strom', 'Kfz']);
  assert.deepEqual(info.headings, ['Vergleichen & sparen']);
  assert.equal(info.colors[0], '#063773');
  assert.equal(info.themeColor, '#063773');
});

function fakeDeps(over = {}) {
  const calls = { search: [], fetched: [], build: [], edit: [], cursor: [], review: 0 };
  const PLAN = { title: 'CHECK24 in Rot', topic: 'CHECK24 in Rot', kind: 'app', goal: 'Vergleichsportal-Demo', reference: { name: 'CHECK24', url: null }, changes: 'Hauptfarbe Rot statt Blau', style: 'klar, freundlich', must_have: ['Kategorie-Kacheln', 'Vergleichsformular', 'Ergebnisliste mit Sortierung', 'Handy-Menü'], sections: ['Kopfzeile', 'Suche', 'Kategorien', 'Ergebnisse', 'Fußzeile'], features: ['Tarife filtern'], assumptions: ['Beispieldaten statt echter Tarife'], open_questions: ['Soll ein Login dazu?'], search_queries: [] };
  const deps = {
    completeBest: async (task, params) => {
      const sys = params.messages[0].content;
      if (/Planer von ApeX/.test(sys)) return { content: `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``, reasoning: 'Der Nutzer will CHECK24 in Rot. Ich nutze build_website.' };
      if (/Rechercheur/.test(sys)) return { content: '- Kopfzeile mit Kategorien Strom, Gas, Kfz\n- Großes Vergleichsformular' };
      if (/Prüfer/.test(sys)) { calls.review++; return { content: `\`\`\`json\n{"score":${calls.review === 1 ? 6 : 9},"missing":${calls.review === 1 ? '["Sortierung der Ergebnisse"]' : '[]'},"fixes":["Ergebnisliste sortierbar machen","Hero kontrastreicher"]}\n\`\`\`` }; }
      return { content: '' };
    },
    searchWeb: async (q) => { calls.search.push(q); return { results: [{ url: 'https://www.check24.de/', title: 'CHECK24 – Vergleichsportal', snippet: 'Vergleichen' }] }; },
    readPage: async () => ({ title: 'CHECK24', text: 'x'.repeat(800) }),
    fetchReference: async (url) => { calls.fetched.push(url); return { url, title: 'CHECK24', nav: ['Strom', 'Gas', 'Kfz'], headings: ['Vergleichen'], buttons: [], colors: ['#063773'], fonts: [], text: 'Text '.repeat(200) }; },
    buildWebsite: async (args) => { calls.build.push(args); args.onStep({ kind: 'section', text: 'Abschnitt „nav“' }); return { html: BAD_NAV_HTML, report: 'ok' }; },
    editWebsite: async (args) => { calls.edit.push(args); return { html: GOOD_HTML, report: 'ok' }; },
    cursorAvailable: async () => ({ ok: false }),
    cursorBuild: async (args) => { calls.cursor.push(args); return { html: GOOD_HTML, name: agentName(args.user, args.topic) }; },
    ...over,
  };
  return { deps, calls };
}

test('Agent-Modus: plant, recherchiert die Vorlage, baut, prüft und überarbeitet', async () => {
  const { deps, calls } = fakeDeps();
  const steps = [];
  const thoughts = [];
  const sources = [];
  const work = {};
  const out = await runBuildTask({ question: 'Bau die CHECK24 App in rot nach', task: classifyTask('Bau die CHECK24 App in rot nach'), onStep: (s) => steps.push(s), thought: (t) => thoughts.push(t), addSources: (l) => { sources.push(...l); return []; }, work, validate: validateHtml, deps });
  assert.deepEqual(calls.search, ['CHECK24 offizielle Webseite']);
  assert.deepEqual(calls.fetched, ['https://www.check24.de/']);
  const b = calls.build[0];
  assert.match(b.brief, /VORLAGE: CHECK24/);
  assert.match(b.brief, /Rot statt Blau/);
  assert.match(b.brief, /REFERENZ-ANALYSE/);
  assert.match(b.brief, /360 px/);
  assert.match(b.rules, /Beispieldaten/);
  assert.equal(b.effort, 'low');
  assert.equal(b.kind, 'website'); // Nachbau → vollständige Seite mit allen Bereichen
  // mindestens eine Überarbeitung mit den Handy-Problemen und den Punkten des Prüfers
  assert.ok(calls.edit.length >= 1);
  assert.match(calls.edit[0].change, /Navigation hat 6 Links/);
  assert.match(calls.edit[0].change, /Sortierung der Ergebnisse/);
  assert.equal(out.html, GOOD_HTML);
  assert.ok(out.revisions >= 1);
  for (const kind of ['plan', 'search', 'read', 'look', 'section', 'check', 'edit']) assert.ok(steps.some((s) => s.kind === kind), kind);
  assert.ok(sources.some((s) => /check24/.test(s.url)));
  assert.match(thoughts.join('\n'), /Vorlage: CHECK24/);
  assert.match(out.text, /CHECK24/);
  assert.match(out.text, /Soll ein Login dazu\?/); // offene Frage als normaler Satz
  assert.doesNotMatch(out.text, /```questions/);
  assert.equal(work.sites, 1);
  assert.ok(work.siteEdits >= 1);
  assert.ok(work.searches >= 1 && work.reads >= 1);
});

test('Agent-Modus: Programmier-Agent, wenn verfügbar – sonst Rückfall auf den eigenen Baukasten', async () => {
  const user = { id: 7, email: 'leeam@example.com' };
  const a = fakeDeps({ cursorAvailable: async () => ({ ok: true }) });
  const out = await runBuildTask({ question: 'Bau die CHECK24 App in rot nach', task: classifyTask('Bau die CHECK24 App in rot nach'), user, validate: validateHtml, deps: a.deps });
  assert.equal(out.viaAgent, true);
  assert.equal(a.calls.build.length, 0);
  assert.equal(a.calls.cursor[0].user, user);
  assert.equal(a.calls.cursor[0].topic, 'CHECK24 in Rot');

  const b = fakeDeps({ cursorAvailable: async () => ({ ok: true }), cursorBuild: async () => { throw Object.assign(new Error('no-repo agents not enabled'), { status: 403 }); } });
  const out2 = await runBuildTask({ question: 'Bau die CHECK24 App in rot nach', task: classifyTask('Bau die CHECK24 App in rot nach'), user, validate: validateHtml, deps: b.deps });
  assert.equal(out2.viaAgent, false);
  assert.equal(b.calls.build.length, 1);
});

test('Programmier-Agent: ohne Repository, Name „username – Thema“, Ergebnis aus dem Artefakt', async () => {
  const user = { id: 11, email: 'max@example.com' };
  assert.equal(agentName(user, 'Portfolio-Website'), 'max – Portfolio-Website');
  assert.match(cursorPrompt('Bau X'), /Do NOT clone, open, list, read or modify any git repository/);
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    seen.push({ u, opts });
    const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.endsWith('/v1/agents') && opts.method === 'POST') return json({ agent: { id: 'bc-1', latestRunId: 'run-1' }, run: { id: 'run-1', status: 'CREATING' } });
    if (u.endsWith('/v1/agents/bc-1/runs/run-1')) return json({ id: 'run-1', status: 'FINISHED', result: 'Fertig.' });
    if (u.endsWith('/v1/agents/bc-1/artifacts')) return json({ items: [{ path: 'artifacts/notes.txt' }, { path: 'artifacts/index.html' }] });
    if (u.includes('/artifacts/download?path=artifacts%2Findex.html')) return json({ url: 'https://s3.example.com/index.html?sig=1' });
    if (u.startsWith('https://s3.example.com/')) return new Response(GOOD_HTML, { status: 200 });
    return json({}, 404);
  };
  assert.equal((await cursorAvailable(user)).ok, true);
  const out = await cursorBuild({ user, topic: 'CHECK24 in Rot', brief: 'Baue CHECK24 in Rot', fetchImpl, pollMs: 1 });
  assert.equal(out.html, GOOD_HTML);
  assert.equal(out.name, 'max – CHECK24 in Rot');
  const create = seen.find((s) => s.u.endsWith('/v1/agents'));
  const body = JSON.parse(create.opts.body);
  assert.deepEqual(body.repos, []); // nie Zugriff auf Repos
  assert.equal(body.name, 'max – CHECK24 in Rot');
  assert.match(create.opts.headers.Authorization, /^Basic /);
  assert.ok(!JSON.stringify(body).includes('test-cursor-key'));
  // Tageslimit pro Person (Standard 2), andere Nutzer sind davon unabhängig
  await cursorBuild({ user, topic: 'Zweite', brief: 'b', fetchImpl, pollMs: 1 });
  assert.deepEqual(await cursorAvailable(user), { ok: false, reason: 'user-limit' });
  assert.equal((await cursorAvailable({ id: 12, email: 'anna@example.com' })).ok, true);
  // Admin im Testmodus: höheres Limit; Testmodus aus = normales Limit
  const admin = { id: 13, email: 'chef@example.com', test_mode: 1 };
  await cursorBuild({ user: admin, topic: 'a', brief: 'b', fetchImpl, pollMs: 1 });
  await cursorBuild({ user: admin, topic: 'b', brief: 'b', fetchImpl, pollMs: 1 });
  assert.equal((await cursorAvailable(admin)).ok, true);
  assert.deepEqual(await cursorAvailable({ ...admin, test_mode: 0 }), { ok: false, reason: 'user-limit' });
  process.env.CURSOR_AGENT_BUILDS = 'staff';
  assert.deepEqual(await cursorAvailable({ id: 98, email: 'y@example.com' }), { ok: false, reason: 'staff-only' });
  assert.equal((await cursorAvailable({ id: 97, email: 'chef@example.com' })).ok, true);
  process.env.CURSOR_AGENT_BUILDS = '0';
  assert.deepEqual(await cursorAvailable({ id: 99, email: 'z@example.com' }), { ok: false, reason: 'off' });
  delete process.env.CURSOR_AGENT_BUILDS;
});

test('Programmier-Agent: Fehler der API → Fehler (Agent-Modus baut dann selbst)', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'No-repo agents are not enabled' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(cursorBuild({ user: { id: 21, email: 'x@example.com' }, topic: 't', brief: 'b', fetchImpl, pollMs: 1 }), /not enabled/);
});

test('runAgent: Bau-Auftrag läuft im Agent-Modus, Antwort mit Seite und ohne interne Namen', async () => {
  const { deps } = fakeDeps();
  let out = '';
  let thinking = '';
  const steps = [];
  const work = {};
  await runAgent({ messages: [{ role: 'user', content: 'Bau die CHECK24 App in rot nach' }], onText: (s) => { out += s; }, onReasoning: (r) => { thinking += r; }, onStep: (s) => steps.push(s), personal: {}, work, agentDeps: deps });
  assert.match(out, /```html\n<!doctype html>/);
  assert.match(out, /CHECK24/);
  assert.doesNotMatch(out.replace(/```html[\s\S]*```/, ''), /build_website|```questions/);
  assert.ok(thinking.length > 20);
  assert.doesNotMatch(thinking, /build_website/);
  assert.match(steps[0]?.text ?? '', /Ich lese deine Frage/);
  assert.ok(steps.some((s) => s.kind === 'plan'));
  assert.equal(work.agentMode, true);
});

test('runAgent: normale Antwort verrät keine Werkzeug-Namen und schickt keinen Rückfragen-Kasten', async () => {
  replies = ['Nein, ich habe dafür build_website verwendet und keinen Cursor-Agenten.'];
  let out = '';
  await runAgent({ messages: [{ role: 'user', content: 'Hast du dafür Cursor Agenten verwendet?' }], onText: (s) => { out += s; }, onStep: () => {}, personal: {} });
  assert.doesNotMatch(out, /build_website|Cursor/);
  assert.match(out, /ApeX von VERTEX/);
  replies = ['Gern!\n\n```questions\nWofür ist die Seite? | Verein | Shop\n```'];
  out = '';
  await runAgent({ messages: [{ role: 'user', content: 'Hilf mir bei meinem Verein' }], onText: (s) => { out += s; }, onStep: () => {}, personal: {} });
  assert.doesNotMatch(out, /```questions/);
  assert.match(out, /Wofür ist die Seite\?/);
});

test('Auftrag und Regeln für den Bau', () => {
  const p = { goal: 'Demo', reference: { name: 'CHECK24' }, changes: 'Rot', style: '', sections: ['Kopf'], features: [], mustHave: ['Menü'], assumptions: [] };
  assert.match(composeBrief('Bau CHECK24', p, 'NOTIZ'), /NOTIZ/);
  assert.match(buildRules(p, { kind: 'app' }), /data-nav-toggle/);
  assert.doesNotMatch(buildRules({ ...p, reference: null, changes: '' }, { kind: 'website' }), /Beispieldaten/);
});
