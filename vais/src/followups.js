// Vorschläge unter einer Antwort: fertige Ideen aus Nutzersicht, keine Fragen an den Nutzer.

const MAX_WORDS = 8;
const MAX_CHARS = 120;
const MAX_ITEMS = 2;

const QUESTION_START = /^(welche[rsn]?|welcher|welches|wie|was|warum|weshalb|wieso|wo|wann|wer|wen|wem|wessen|ob|how|what|why|which|who|when|where|whose|whom)\b/i;

const ADDRESS_USER = /\b(?:möchtest\s+du|willst\s+du|würdest\s+du|kannst\s+du|könntest\s+du|hast\s+du|magst\s+du|sollst\s+du|soll\s+ich|soll\s+er|soll\s+sie|soll\s+es|soll\s+(?:der|die|das|den|dem|ein|eine|einen|einem)|would\s+you|do\s+you|are\s+you|can\s+you|could\s+you|should\s+(?:he|she|it|i|we|the)|shall\s+(?:i|we)|would\s+he)\b/i;

const SECOND_PERSON = /\b(?:du|dir|dich|you)\b/i;

const TRAILING_CUT = /^(und|oder|and|or|mit|with|von|zu|the|a|an|ein|eine|einen|einem|einer|der|die|das|den|dem)$/i;

const INFINITIVE_TO_IMPERATIVE = [
  [/^(.*)\s+erklären$/i, (_, rest) => `Erklär ${rest}`],
  [/^(.*)\s+zeigen$/i, (_, rest) => `Zeig ${rest}`],
  [/^(.*)\s+geben$/i, (_, rest) => `Gib ${rest}`],
  [/^(.*)\s+machen$/i, (_, rest) => `Mach ${rest}`],
  [/^(.*)\s+ändern$/i, (_, rest) => `Ändere ${rest}`],
  [/^(.*)\s+schreiben$/i, (_, rest) => `Schreib ${rest}`],
  [/^(.*)\s+zusammenfassen$/i, (_, rest) => `Fasse ${rest} zusammen`],
  [/^(.*)\s+fassen\s+zusammen$/i, (_, rest) => `Fasse ${rest} zusammen`],
];

export const DEMO_SUGGESTIONS = {
  image: {
    de: ['Gib ihm einen roten Anzug', 'Stell ihn in eine verregnete Großstadt'],
    en: ['Give him a red suit', 'Put him in a rainy city'],
  },
  text: {
    de: ['Erklär das genauer', 'Gib mir ein Beispiel'],
    en: ['Explain that in more detail', 'Give me an example'],
  },
};

export function demoSuggestions(imageMode) {
  return imageMode ? DEMO_SUGGESTIONS.image : DEMO_SUGGESTIONS.text;
}

function capitalize(text) {
  const s = String(text ?? '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function limitWords(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_WORDS) return text;
  const cut = words.slice(0, MAX_WORDS);
  while (cut.length && TRAILING_CUT.test(cut[cut.length - 1])) cut.pop();
  return cut.join(' ');
}

function rewriteSuggestion(text) {
  let s = text.replace(/[?？]+$/g, '').trim();
  const lead = /^(kannst|könntest)\s+du\s+(bitte\s+)?(.+)$/i.exec(s)
    || /^(can|could)\s+you\s+(please\s+)?(.+)$/i.exec(s);
  if (lead) s = lead[3].trim();
  for (const [re, to] of INFINITIVE_TO_IMPERATIVE) {
    if (re.test(s)) {
      s = s.replace(re, to).replace(/\s+/g, ' ').trim();
      break;
    }
  }
  return capitalize(s);
}

export function isBadSuggestion(text) {
  const s = String(text ?? '').trim();
  if (s.length < 2) return true;
  if (/[?？]/.test(s)) return true;
  if (QUESTION_START.test(s)) return true;
  if (ADDRESS_USER.test(s)) return true;
  if (SECOND_PERSON.test(s)) return true;
  if (s.split(/\s+/).filter(Boolean).length < 2) return true;
  return false;
}

export function cleanSuggestions(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    let s = String(raw ?? '').replace(/["„“”«»]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!s) continue;
    s = rewriteSuggestion(s);
    s = limitWords(s).replace(/[.\s]+$/g, '').trim();
    if (isBadSuggestion(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export function extrasPrompt({ imageMode, wantTitle, firstTurn, currentTitle, question, answer }) {
  const titleRule = !wantTitle ? '"title": leer lassen.'
    : firstTurn ? '"title": ein kurzer, treffender Titel für diesen Chat (2–5 Wörter, keine Anführungszeichen, kein Punkt).'
      : `"title": Der Chat heißt bisher „${String(currentTitle ?? '').slice(0, 80)}“. NUR wenn diese neue Frage ein klar anderes Thema hat, gib einen neuen kurzen Titel für das neue Thema (2–5 Wörter). Bei Nachfragen, Details oder demselben Thema: leer lassen.`;
  const suggestionRule = imageMode
    ? '"suggestions": 0 bis 2 kurze Ideen, nur wenn sie wirklich helfen (je max. 8 Wörter). Sonst ein leeres Array. Fertige Aufforderung aus Sicht des Nutzers, als Befehl, kein Fragezeichen. Beispiele: "Gib ihm einen roten Anzug", "Stell ihn in eine verregnete Großstadt".'
    : '"suggestions": 0 bis 2 fertige nächste Schritte, nur wenn sie wirklich helfen (je max. 8 Wörter). Sonst ein leeres Array. Beispiele: "Erklär das einfacher", "Gib mir ein Beispiel". Keine Fragen, kein Fragezeichen, kein du/dir.';
  return [
    'Antworte NUR mit JSON, ohne Erklärung, im Format {"title": "...", "suggestions": ["...", "..."]}.',
    titleRule,
    suggestionRule,
    'Schreibe in derselben Sprache wie die Frage des Nutzers. Wenn die Sprache unklar ist, schreibe auf Deutsch.',
    'Nenne niemals Modellnamen oder interne Systeme. Die KI heißt ApeX (genau so geschrieben).',
    '',
    `Frage des Nutzers: ${String(question ?? '').slice(0, 1500)}`,
    answer ? `Antwort (Auszug): ${String(answer).slice(0, 2000)}` : '',
  ].join('\n');
}
