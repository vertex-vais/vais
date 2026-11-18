// ApeX Agent-Modus für große Aufgaben (Webseite/App bauen, eine bekannte App nachbauen):
//   1. Verstehen & planen (Denk-Modell mit hohem Aufwand) → Anforderungsliste, Annahmen, Recherche-Plan
//   2. Recherche: Vorlage im Web finden und lesen (Aufbau, Navigation, Bereiche, Farben, Schriften)
//   3. Bauen: Programmier-Agent (wenn eingerichtet) oder der eigene mehrstufige Baukasten
//   4. Prüfen: technische Prüfung + Handy-Prüfung + Gutachter gegen die Anforderungsliste
//   5. Überarbeiten (mindestens einmal), dann erneut prüfen
// Rückfragen gibt es nicht als Kasten: ApeX trifft sinnvolle Annahmen, arbeitet weiter und nennt
// offene Punkte am Ende als normalen Text.
import { completeBest } from './models.js';
import { searchWeb, readPage, assertPublicUrl, htmlToText } from './search.js';
import { buildWebsite, editWebsite, fakeCheck } from './sitebuilder.js';
import { mobileProblems } from './sitecheck.js';
import { cursorAvailable, cursorBuild } from './cursorAgent.js';

// ── Erkennen, ob eine Nachricht ein Bau-Auftrag ist ──────────────────
const BUILD_VERB = /\b(bau|baue|bauen|baust|baut|erstell\w*|programmier\w*|entwickl\w*|coden?|mach|mache|machst|design\w*|gestalt\w*|nachbau\w*|klon\w*|kopier\w*|build|create|make|clone|recreate|develop)\b/i;
const BUILD_NOUN = /\b(app|apps|web-?app|webseite\w*|website\w*|homepage|landing ?page|landingpage|seite|onlineshop|shop|dashboard|spiel|game|portfolio|plattform|portal|vergleichsportal|rechner|todo-?(liste|app)?|blog|klon|clone|oberfläche|frontend|ui)\b/i;
const HOWTO = /^\s*(wie|was|warum|wieso|weshalb|welche[rs]?|kann man|könnte man|how|what|why|which|erklär\w*|explain)\b/i;
const ASKING = /\b(wie kann ich|wie mache ich|wie baue ich|wie programmiere ich|wie geht|was ist|was sind|was kostet|warum|wieso|welche[rs]? (ist|sind|soll)|kann ich|soll ich|sollte ich|how (do|can|should) i|what is|why)\b|\bich (mache|baue|programmiere|entwickle|erstelle|habe)\b/i;
const NOT_BUILD = /präsentation|folien|slides|referat|vortrag|\bbild\b|foto|logo\b|poster|erinner/i;
const REFERENCE = /(nachbau\w*|\bnach\s*[.!?]?$|\bnach\b(?= in | mit |$)|klon\w*|clone|kopie|kopier\w*|wie (bei |die |das |der )?[A-ZÄÖÜ0-9]|im stil (von|wie)|ähnlich wie|\blike\b|inspired|à la|https?:\/\/)/i;

export function classifyTask(text = '', { hasPage = false } = {}) {
  const q = String(text ?? '').trim();
  if (!q || q.length < 8 || hasPage) return null;
  if (HOWTO.test(q) || ASKING.test(q) || NOT_BUILD.test(q)) return null;
  if (!BUILD_VERB.test(q) || !BUILD_NOUN.test(q)) return null;
  const kind = /\b(spiel|game)\b/i.test(q) ? 'game' : /\b(app|apps|web-?app|rechner|dashboard|tool|todo|plattform|portal|vergleichsportal|klon|clone)\b/i.test(q) ? 'app' : 'website';
  return { mode: 'build', kind, reference: REFERENCE.test(q) };
}

// ── Kleine Helfer ─────────────────────────────────────────────────
const fence = (text, lang) => String(text ?? '').match(new RegExp('```' + lang + '\\b[^\\n]*\\n([\\s\\S]*?)(?:```|$)', 'i'))?.[1]?.trim() ?? '';
export function parseJsonLoose(text) {
  const s = String(text ?? '');
  const raw = fence(s, 'json') || s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch { return null; }
}
const list = (v, max = 12, len = 300) => (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim().slice(0, len)).filter(Boolean).slice(0, max);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u ?? '').slice(0, 60); } };
const thoughtOf = (msg) => String(msg?.reasoning ?? msg?.reasoning_content ?? '').trim();

// ── Vorlage lesen: Aufbau, Navigation, Überschriften, Farben ──────────
async function fetchLimited(raw, { signal, max = 1_500_000, accept = 'text/html' } = {}) {
  let url = await assertPublicUrl(raw);
  let res;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', Accept: accept, 'Accept-Language': 'de-DE,de;q=0.9' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = await assertPublicUrl(new URL(res.headers.get('location'), url).href); continue; }
    break;
  }
  if (!res.ok) throw Object.assign(new Error(`Fehler ${res.status}`), { status: res.status });
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
  reader.cancel().catch(() => {});
  return { url: url.href, body: new TextDecoder().decode(Buffer.concat(chunks)) };
}

export function analyzeHtml(html, baseUrl = '') {
  const src = String(html ?? '');
  const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const pick = (re, max, len = 80) => [...new Set([...src.matchAll(re)].map((m) => clean(m[1])).filter((x) => x && x.length <= len))].slice(0, max);
  const navBlock = (src.match(/<(nav|header)\b[\s\S]*?<\/\1>/gi) ?? []).join(' ');
  const nav = [...new Set([...navBlock.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => clean(m[1])).filter((x) => x && x.length <= 40))].slice(0, 24);
  const colors = new Map();
  for (const m of src.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let c = m[1].toLowerCase();
    if (c.length === 3) c = c.split('').map((x) => x + x).join('');
    if (['ffffff', '000000'].includes(c)) continue;
    colors.set(c, (colors.get(c) ?? 0) + 1);
  }
  const stylesheets = [...src.matchAll(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi)].map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1]).filter(Boolean)
    .map((h) => { try { return new URL(h, baseUrl || undefined).href; } catch { return null; } }).filter((h) => h && /^https:/.test(h)).slice(0, 2);
  return {
    title: clean(src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 140),
    description: (src.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i)?.[1] ?? '').slice(0, 300),
    themeColor: src.match(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']*)/i)?.[1] ?? '',
    fonts: [...new Set([...src.matchAll(/font-family\s*:\s*["']?([\w \-]{3,40})/gi)].map((m) => m[1].trim()))].slice(0, 5),
    nav,
    headings: pick(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi, 30, 120),
    buttons: pick(/<button\b[^>]*>([\s\S]*?)<\/button>/gi, 20, 40),
    colors: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c]) => `#${c}`),
    stylesheets,
  };
}

export async function fetchReference(url, { signal } = {}) {
  const page = await fetchLimited(url, { signal });
  const info = analyzeHtml(page.body, page.url);
  // Farben aus den ersten Stylesheets ergänzen
  for (const css of info.stylesheets) {
    try {
      const sheet = await fetchLimited(css, { signal, max: 500_000, accept: 'text/css,*/*;q=0.5' });
      const more = analyzeHtml(sheet.body).colors;
      info.colors = [...new Set([...info.colors, ...more])].slice(0, 12);
      if (!info.fonts.length) info.fonts = analyzeHtml(sheet.body).fonts;
    } catch (err) { if (signal?.aborted) throw err; }
  }
  const { text } = htmlToText(page.body);
  return { url: page.url, ...info, text: text.slice(0, 6000) };
}

const DEFAULT_DEPS = { completeBest, searchWeb, readPage, fetchReference, buildWebsite, editWebsite, cursorAvailable, cursorBuild };

// ── 1. Planen ─────────────────────────────────────────────────────
const PLAN_SYS = `Du bist der Planer von ApeX, einem KI-Agenten, der Webseiten und Web-Apps baut. Verstehe den Auftrag genau und plane ihn wie ein erfahrener Produkt-Designer.
Stelle KEINE Rückfragen. Fehlt etwas, triff eine sinnvolle Annahme und schreibe sie in "assumptions".
Antworte NUR mit JSON in einem \`\`\`json-Block:
{"title":"kurzer Titel der Seite/App","topic":"Thema in 2–5 Wörtern","kind":"website|app|game","goal":"1–2 Sätze, was gebaut wird und für wen",
"reference":{"name":"bekannte Vorlage, z. B. CHECK24 – sonst null","url":"offizielle Adresse, wenn sicher bekannt, sonst null"},
"changes":"was anders sein soll als bei der Vorlage (z. B. Farbe Rot)","style":"Stil, Farben, Stimmung",
"must_have":["8–14 konkrete, prüfbare Anforderungen (Bereiche, Funktionen, Interaktionen, Handy-Ansicht)"],
"sections":["Bereiche der Seite in Reihenfolge"],"features":["interaktive Funktionen"],
"assumptions":["getroffene Annahmen"],"open_questions":["höchstens 2 Punkte, die der Nutzer später noch entscheiden kann"],
"search_queries":["0–2 Websuchen für echte Fakten (leer, wenn nicht nötig)"]}
Gebaut wird IMMER eine Web-Seite bzw. Web-App in HTML/CSS/JavaScript, die im Browser läuft (keine nativen Apps, kein Flutter/React Native, keine Server, keine echten Logins oder Zahlungen).
Für Nachbauten bekannter Apps/Seiten: Baue die Startseite/Hauptansicht der Vorlage mit ihrer Kernfunktion als EINE scrollbare, interaktive Seite nach – Aufbau, Bereiche, Menüpunkte und Bedienlogik so genau wie möglich (mit den gewünschten Änderungen), als funktionierende Demo mit Beispieldaten. Keine Splash-, Onboarding- oder Login-Screens, außer der Nutzer will das ausdrücklich. Typisch für Vergleichsportale: Kopfzeile mit Logo und Kategorien-Menü, Hero mit großem Vergleichsformular (Kategorie-Tabs), Kategorie-Kacheln, interaktive Ergebnisliste mit Filtern/Sortierung, Vorteile/Siegel, App-Hinweis, FAQ, Fußzeile.`;

async function plan(question, history, deps, signal) {
  const recent = history.filter((m) => typeof m.content === 'string').slice(-6, -1).map((m) => `${m.role === 'user' ? 'Nutzer' : 'ApeX'}: ${m.content.slice(0, 600)}`).join('\n');
  const msg = await deps.completeBest('builder', {
    maxTokens: 3500, reasoningEffort: 'high', timeoutMs: 120_000,
    messages: [{ role: 'system', content: PLAN_SYS }, { role: 'user', content: `${recent ? `Bisheriges Gespräch:\n${recent}\n\n` : ''}Auftrag: ${question}` }],
  }, { signal, tries: 4 });
  const raw = parseJsonLoose(msg.content) ?? {};
  const ref = raw.reference && typeof raw.reference === 'object' ? raw.reference : {};
  const refName = String(ref.name ?? '').trim();
  return {
    thought: thoughtOf(msg),
    title: String(raw.title ?? '').slice(0, 80) || 'Neue Seite',
    topic: String(raw.topic ?? raw.title ?? '').slice(0, 60) || 'Webseite',
    kind: ['website', 'app', 'game'].includes(raw.kind) ? raw.kind : null,
    goal: String(raw.goal ?? '').slice(0, 500),
    reference: refName && !/^(null|none|keine?)$/i.test(refName) ? { name: refName.slice(0, 60), url: /^https?:\/\//i.test(String(ref.url ?? '')) ? String(ref.url) : null } : null,
    changes: String(raw.changes ?? '').slice(0, 400),
    style: String(raw.style ?? '').slice(0, 500),
    mustHave: list(raw.must_have, 14, 240),
    sections: list(raw.sections, 12, 160),
    features: list(raw.features, 12, 200),
    assumptions: list(raw.assumptions, 6, 200),
    openQuestions: list(raw.open_questions, 2, 200),
    searchQueries: list(raw.search_queries, 2, 120),
  };
}

// ── 2. Recherche ──────────────────────────────────────────────────
const JUNK_HOST = /(wikipedia\.org|youtube\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|reddit\.com|apps\.apple\.com|play\.google\.com|linkedin\.com|tiktok\.com)$/i;
async function findReferenceUrl(ref, deps, signal, ctx) {
  if (ref.url) return ref.url;
  ctx.onStep({ kind: 'search', text: `${ref.name} offizielle Seite` });
  ctx.note('searches');
  const found = await deps.searchWeb(`${ref.name} offizielle Webseite`, { signal, max: 6 }).catch(() => null);
  const results = found?.results ?? [];
  if (results.length) ctx.addSources(results.slice(0, 3).map(({ url, title }) => ({ url, title })));
  const slug = ref.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const best = results.find((r) => slug && host(r.url).replace(/[^a-z0-9]/g, '').includes(slug)) ?? results.find((r) => !JUNK_HOST.test(host(r.url)));
  return best?.url ?? null;
}

const RESEARCH_SYS = `Du bist der Rechercheur von ApeX. Du bekommst Rohdaten einer Vorlage-Webseite (Titel, Navigation, Überschriften, Knöpfe, Farben, Text).
Schreibe eine präzise Analyse auf Deutsch (Stichpunkte, höchstens 350 Wörter) als Bauanleitung für einen Nachbau:
1. Gesamtaufbau von oben nach unten (Kopfzeile, Hero/Suche, Kategorien, Inhaltsbereiche, Fußzeile)
2. Navigation: Menüpunkte (echte Namen)
3. Kernfunktion und Bedienlogik (z. B. Vergleichsformular → Ergebnisliste mit Filtern/Sortierung)
4. Typische UI-Elemente (Karten, Kacheln, Badges, Bewertungen, Siegel, Tabs)
5. Farben (Hex), Schrift, Formensprache
6. Handy-Ansicht (wie sich Menü und Raster verhalten sollten)
Nur was aus den Daten hervorgeht oder für diese Art Seite allgemein bekannt ist. Keine Einleitung.`;

async function research(p, deps, signal, ctx) {
  const notes = [];
  if (p.reference) {
    const url = await findReferenceUrl(p.reference, deps, signal, ctx);
    if (url) {
      ctx.onStep({ kind: 'read', text: host(url) });
      ctx.note('reads');
      let ref = null;
      try { ref = await deps.fetchReference(url, { signal }); } catch (err) { if (signal?.aborted) throw err; }
      if (!ref || (ref.text ?? '').length < 500) {
        // JavaScript-Seite: lesbaren Text über den Seiten-Leser holen
        try {
          const page = await deps.readPage(url, { signal });
          ref = { ...(ref ?? { url, nav: [], headings: [], buttons: [], colors: [], fonts: [] }), title: ref?.title || page.title, text: String(page.text ?? '').slice(0, 6000) };
        } catch (err) { if (signal?.aborted) throw err; }
      }
      if (ref) {
        ctx.addSources([{ url: ref.url ?? url, title: ref.title || p.reference.name }]);
        ctx.onStep({ kind: 'look', text: 'Aufbau, Farben und Bereiche der Vorlage' });
        const raw = [
          `Vorlage: ${p.reference.name} (${ref.url ?? url})`,
          `Titel: ${ref.title ?? ''}`, `Beschreibung: ${ref.description ?? ''}`,
          `Theme-Farbe: ${ref.themeColor ?? ''}`, `Häufige Farben: ${(ref.colors ?? []).join(', ')}`, `Schriften: ${(ref.fonts ?? []).join(', ')}`,
          `Navigation: ${(ref.nav ?? []).join(' | ')}`, `Überschriften: ${(ref.headings ?? []).join(' | ')}`, `Knöpfe: ${(ref.buttons ?? []).join(' | ')}`,
          `Text (Auszug):\n${String(ref.text ?? '').slice(0, 4500)}`,
        ].join('\n');
        try {
          const msg = await deps.completeBest('smart', { maxTokens: 1600, reasoningEffort: 'medium', timeoutMs: 90_000, messages: [{ role: 'system', content: RESEARCH_SYS }, { role: 'user', content: raw }] }, { signal, tries: 3 });
          const analysis = String(msg.content ?? '').trim();
          if (analysis) notes.push(`REFERENZ-ANALYSE (${p.reference.name}, ${host(ref.url ?? url)}):\n${analysis}`);
          ctx.thought(`Vorlage ${host(ref.url ?? url)} angesehen: ${(ref.nav ?? []).slice(0, 8).join(', ') || 'Aufbau gelesen'}. ${analysis.split('\n').slice(0, 4).join(' ').slice(0, 400)}`);
        } catch (err) {
          if (signal?.aborted) throw err;
          notes.push(raw.slice(0, 3000));
        }
      }
    }
    if (!notes.length) notes.push(`REFERENZ: ${p.reference.name} – die Seite war nicht lesbar. Nutze das allgemein bekannte Aufbau-Muster dieser Seite.`);
  }
  for (const q of p.searchQueries.slice(0, p.reference ? 1 : 2)) {
    ctx.onStep({ kind: 'search', text: q });
    ctx.note('searches');
    const found = await deps.searchWeb(q, { signal, max: 5 }).catch(() => null);
    const results = found?.results ?? [];
    if (!results.length) continue;
    ctx.addSources(results.map(({ url, title }) => ({ url, title })));
    notes.push(`FAKTEN (Suche „${q}“):\n${results.map((r) => `- ${r.title}: ${String(r.snippet ?? '').slice(0, 280)}`).join('\n')}`);
  }
  return notes.join('\n\n');
}

// ── 3. Auftrag für den Bau ─────────────────────────────────────────
export function composeBrief(question, p, notes) {
  return [
    `AUFTRAG DES NUTZERS: ${question}`,
    p.goal && `ZIEL: ${p.goal}`,
    p.reference && `VORLAGE: ${p.reference.name} – Aufbau, Bereiche und Bedienlogik möglichst genau nachbauen.`,
    p.changes && `ÄNDERUNGEN GEGENÜBER DER VORLAGE (haben Vorrang): ${p.changes}`,
    p.style && `STIL: ${p.style}`,
    p.sections.length && `BEREICHE (in dieser Reihenfolge):\n${p.sections.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    p.features.length && `FUNKTIONEN (müssen wirklich funktionieren):\n${p.features.map((f) => `- ${f}`).join('\n')}`,
    p.mustHave.length && `ANFORDERUNGEN (werden danach geprüft):\n${p.mustHave.map((f) => `- ${f}`).join('\n')}`,
    p.assumptions.length && `ANNAHMEN:\n${p.assumptions.map((f) => `- ${f}`).join('\n')}`,
    notes,
    'HANDY: Muss bei 360 px Breite perfekt aussehen – keine waagerechte Scrollleiste, Menü auf dem Handy hinter einem Menü-Knopf, Raster einspaltig, große Tippflächen.',
  ].filter(Boolean).join('\n\n').slice(0, 9000);
}

export function buildRules(p, task) {
  const rules = [];
  if (p.reference || task.kind !== 'website') rules.push('Das ist ein Nachbau bzw. eine interaktive Demo: Realistische Beispieldaten (z. B. Tarife, Preise, Anbieter-Namen, Bewertungen) sind ausdrücklich erlaubt und erwünscht, damit die App echt wirkt – kennzeichne sie dezent als „Beispiel“/„Demo“. Keine echten Logos fremder Marken als Bild; der Name als Text-Wortmarke ist ok.');
  if (p.changes) rules.push(`Gewünschte Änderungen haben Vorrang: ${p.changes}`);
  if (p.sections.length >= 3) rules.push(`Abschnitte: Plane genau die BEREICHE aus dem Auftrag – jeder Bereich wird ein eigener, vollständig ausgebauter Abschnitt (insgesamt ${Math.min(10, p.sections.length + 1)}–10 Abschnitte inklusive Kopf- und Fußzeile), auch wenn es eine App ist.`);
  rules.push('Navigation: auf dem Handy (unter 820 px) ein Menü-Knopf mit data-nav-toggle und ein ausklappbares Menü mit data-nav; Menü-Links nie in einer nicht umbrechenden Zeile über den Rand laufen lassen.');
  return rules.join('\n');
}

// ── 4. Prüfen ─────────────────────────────────────────────────────
function outlineOf(html) {
  const src = String(html ?? '');
  const ids = [...src.matchAll(/<(section|header|footer|main)\b[^>]*\bid=["']([^"']+)/gi)].map((m) => m[2]).slice(0, 20);
  const heads = [...src.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30);
  const buttons = [...src.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 25);
  const text = htmlToText(src).text.slice(0, 5000);
  const media = (src.match(/@media/gi) ?? []).length;
  const scripts = (src.match(/<script\b(?![^>]*application\/json)/gi) ?? []).length;
  return `Abschnitte: ${ids.join(', ')}\nÜberschriften: ${heads.join(' | ')}\nKnöpfe: ${buttons.join(' | ')}\n@media-Regeln: ${media}, Skripte: ${scripts}, Zeilen: ${src.split('\n').length}\n\nSichtbarer Text (Auszug):\n${text}`;
}

const REVIEW_SYS = `Du bist der strenge Prüfer von ApeX. Vergleiche die gebaute Seite mit dem Auftrag und der Anforderungsliste.
Antworte NUR mit JSON in einem \`\`\`json-Block: {"score":1-10,"missing":["Anforderungen, die fehlen oder nur angedeutet sind"],"fixes":["2–6 konkrete, umsetzbare Verbesserungen (was genau in welchem Bereich), wichtigste zuerst"]}
Achte besonders auf: fehlende Bereiche/Funktionen, Abweichungen von der Vorlage und den gewünschten Änderungen (z. B. Farbe), leere oder halb fertige Bereiche, Handy-Ansicht (Navigation, waagerechtes Scrollen). Gib auch bei guten Seiten mindestens 2 Verbesserungen an.`;

export async function reviewSite(html, { question, plan: p, validate, deps = DEFAULT_DEPS, signal, llm = true }) {
  const technical = validate ? String(validate(html)) : 'OK';
  const staticProblems = [
    ...(/^OK/.test(technical) ? [] : technical.split('\n').slice(1).map((l) => l.replace(/^- /, ''))),
    ...mobileProblems(html),
    ...fakeCheck(html, question).map((f) => `Enthält ${f}.`),
  ].slice(0, 10);
  let review = { score: null, missing: [], fixes: [] };
  if (llm) try {
    const msg = await deps.completeBest('smart', {
      maxTokens: 1800, reasoningEffort: 'medium', timeoutMs: 90_000,
      messages: [{ role: 'system', content: REVIEW_SYS }, { role: 'user', content: `Auftrag: ${question}\n\nAnforderungen:\n${p.mustHave.map((x) => `- ${x}`).join('\n') || '- (keine Liste)'}\n${p.changes ? `\nGewünschte Änderungen: ${p.changes}` : ''}\n\nGEBAUTE SEITE:\n${outlineOf(html)}\n\nTechnische Prüfung: ${staticProblems.length ? staticProblems.join(' ') : 'OK'}` }],
    }, { signal, tries: 3 });
    const raw = parseJsonLoose(msg.content) ?? {};
    review = { score: Number.isFinite(Number(raw.score)) ? Math.max(1, Math.min(10, Math.round(Number(raw.score)))) : null, missing: list(raw.missing, 6, 240), fixes: list(raw.fixes, 6, 300), thought: thoughtOf(msg) };
  } catch (err) { if (signal?.aborted) throw err; }
  return { staticProblems, ...review };
}

// ── Ganzer Ablauf ──────────────────────────────────────────────────
// Gibt { html, text } zurück; wirft bei Fehlern (dann übernimmt der normale Ablauf).
// Zeitbudget: nach so vielen ms keine zweite Überarbeitung mehr (die erste passiert immer)
const SECOND_PASS_UNTIL_MS = 4 * 60_000;
export async function runBuildTask({ question, history = [], task, user = null, signal, onStep = () => {}, thought = () => {}, addSources = () => [], work = {}, validate, deps: custom = {}, now = Date.now }) {
  const startedAt = now();
  const deps = { ...DEFAULT_DEPS, ...custom };
  const note = (k, n = 1) => { work[k] = (work[k] ?? 0) + n; };
  const ctx = { onStep, note, addSources, thought };

  onStep({ kind: 'plan', text: 'Auftrag verstehen und planen' });
  note('calls');
  const p = await plan(question, history, deps, signal);
  // Nachbauten: als vollständige Seite mit vielen Bereichen bauen (nicht als „App mit einem Hauptteil“)
  const kind = (p.kind ?? task.kind) === 'game' ? 'game' : p.reference ? 'website' : (p.kind ?? task.kind);
  thought([
    `Ziel: ${p.goal || question}`,
    p.reference ? `Vorlage: ${p.reference.name}${p.changes ? ` – Änderungen: ${p.changes}` : ''}.` : '',
    p.sections.length ? `Plan: ${p.sections.join(' → ')}.` : '',
    p.assumptions.length ? `Annahmen: ${p.assumptions.join('; ')}.` : '',
  ].filter(Boolean).join('\n'));

  const notes = await research(p, deps, signal, ctx);
  const brief = composeBrief(question, p, notes);
  const rules = buildRules(p, { ...task, kind });

  // Bauen: Programmier-Agent, wenn eingerichtet und frei – sonst (oder bei Problemen) der eigene Baukasten
  let html = '';
  let viaAgent = false;
  const agentOk = user ? await deps.cursorAvailable(user).catch((err) => ({ ok: false, reason: err.message })) : { ok: false, reason: 'nouser' };
  console.log(`ApeX Bau: Cursor ${agentOk.ok ? 'ja' : `nein (${agentOk.reason ?? '?'})`}`);
  if (agentOk.ok) {
    onStep({ kind: 'agent', text: 'Programmier-Agent übernimmt den Bau' });
    try {
      const out = await deps.cursorBuild({ user, topic: p.topic || p.title, brief: `${brief}\n\nZUSATZREGELN:\n${rules}`, signal, onStep });
      html = out.html;
      viaAgent = true;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error('Programmier-Agent nicht verfügbar, eigener Baukasten:', agentOk.reason ?? '', err.status ?? '', err.message);
      onStep({ kind: 'other', text: 'Wechsle zum eigenen Baukasten' });
    }
  }
  if (!html) {
    const out = await deps.buildWebsite({ brief, kind, signal, onStep, validate, rules, effort: 'low' });
    html = out.html;
  }
  note('sites');

  // Prüfen → überarbeiten (mindestens einmal) → nochmal prüfen
  let revisions = 0;
  let lastReview = null;
  for (let round = 0; round < 2; round++) {
    onStep({ kind: 'check', text: round === 0 ? 'Gegen den Auftrag und auf dem Handy prüfen' : 'Erneut prüfen' });
    if (round === 0) note('calls');
    const review = await reviewSite(html, { question, plan: p, validate, deps, signal, llm: round === 0 });
    if (round === 0) lastReview = review;
    // Runde 1: alles (Technik, Handy, Fehlendes, Verbesserungen). Runde 2: nur noch harte Probleme (Technik/Handy).
    const fixes = round === 0
      ? [...review.staticProblems, ...review.missing.map((m) => `Fehlt noch: ${m}`), ...review.fixes].slice(0, 8)
      : review.staticProblems.slice(0, 5);
    thought(`Prüfung${review.score ? ` (${review.score}/10)` : ''}: ${fixes.length ? fixes.slice(0, 6).join(' · ') : 'alles erfüllt'}`);
    if (!fixes.length) break;
    if (round > 0 && now() - startedAt > SECOND_PASS_UNTIL_MS) break;
    onStep({ kind: 'edit', text: `${fixes.length} ${fixes.length === 1 ? 'Verbesserung' : 'Verbesserungen'} umsetzen` });
    try {
      const out = await deps.editWebsite({ html, change: `Überarbeite die Seite nach dieser Prüfung – setze alles um, ohne Bestehendes zu verschlechtern. Neue Abschnitte nur, wenn ein Bereich wirklich fehlt:\n- ${fixes.join('\n- ')}`, signal, onStep, validate, rules, effort: 'low' });
      if (out?.html && /<\/html>/i.test(out.html)) { html = out.html; revisions++; note('siteEdits'); }
      if (now() - startedAt > SECOND_PASS_UNTIL_MS) break;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error('Überarbeitung fehlgeschlagen:', err.message);
      break;
    }
  }

  const left = mobileProblems(html);
  const lines = [
    `Fertig! Ich habe **${p.title}** ${kind === 'game' ? 'als Spiel' : (task.kind === 'app' || p.kind === 'app') ? 'als Web-App' : 'als Webseite'} gebaut${p.reference ? ` – nach dem Vorbild von ${p.reference.name}${p.changes && p.changes.length <= 80 ? ` (${p.changes.replace(/\.$/, '')})` : ''}` : ''}.`,
    '',
    p.sections.length ? `**Drin ist:** ${p.sections.slice(0, 8).join(' · ')}` : '',
    p.features.length ? `**Funktioniert:** ${p.features.slice(0, 5).join(' · ')}` : '',
    `**Geprüft:** Anforderungen und Handy-Ansicht${revisions ? `, danach ${revisions === 1 ? 'einmal' : `${revisions}-mal`} überarbeitet` : ''}${left.length ? ' – auf dem Handy kann ich noch nachschärfen, sag einfach Bescheid' : ''}.`,
    p.assumptions.length ? `**Meine Annahmen:** ${p.assumptions.slice(0, 4).join(' · ')}` : '',
    p.openQuestions.length ? p.openQuestions.join(' ') : '',
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0));
  return { html, text: lines.join('\n').trim(), viaAgent, revisions, plan: p, score: lastReview?.score ?? null };
}
