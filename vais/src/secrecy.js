// Geheimhaltung: ApeX nennt nie interne Werkzeug-Namen, Modelle oder Anbieter.
// Läuft über jede fertige Antwort und über die sichtbaren Gedanken, bevor sie zum Nutzer gehen.

// Interne Werkzeug-Namen (wie sie das Modell sieht) → neutrale Beschreibung
const TOOL_WORDS = {
  build_website: 'meinen Webseiten-Baukasten',
  edit_website: 'meinen Webseiten-Baukasten',
  validate_html: 'meine Seitenprüfung',
  web_search: 'meine Websuche',
  read_webpage: 'meinen Seiten-Leser',
  run_javascript: 'mein Rechenwerkzeug',
  generate_image: 'mein Bild-Werkzeug',
  current_datetime: 'meine Uhr',
  youtube_video: 'mein Video-Werkzeug',
  set_reminder: 'meine Erinnerungen',
  kontobuchung: 'dein Kontostand-Tool',
  kontostand: 'dein Kontostand-Tool',
  remember: 'mein Gedächtnis',
  cursor_agent: 'meinen Programmier-Agenten',
  calculate: 'meinen Rechner',
  wikipedia: 'Wikipedia',
};
// Nur eindeutige Bezeichner ersetzen (snake_case oder in `Backticks`); „Wikipedia“ oder „remember“ im
// normalen Satz bleiben stehen.
const TOOL_RE = new RegExp(`\`?\\b(${Object.keys(TOOL_WORDS).filter((k) => k.includes('_')).join('|')})\\b(\\(\\))?\`?`, 'g');
const TOOL_TICK_RE = new RegExp(`\`(${Object.keys(TOOL_WORDS).filter((k) => !k.includes('_')).join('|')})(\\(\\))?\``, 'g');

// Modelle und Anbieter, die nie als „das bin ich / das nutze ich“ auftauchen dürfen
export const MODEL_NAMES = /\b(groq|cerebras|mistral|mixtral|codestral|devstral|openrouter|open ?router|gemini|gemma|llama|qwen|gpt[- ]?oss|gpt[- ]?\d[\w.-]*|chatgpt|openai|deepseek|kimi|moonshot|claude|anthropic|pollinations|nemotron|nvidia|inkling|thinking ?machines|together ?ai|cloudflare workers ai|sana|flux|cursor|composer[- ]?\d*|grok|xai|x\.ai)\b/i;
// Satz spricht über ApeX selbst (ich/wir/mein … nutze/basiere/bin …)
const SELF_REF = [
  /\b(ich|mich|mir|wir|uns)\b[^.!?\n]{0,80}\b(nutz|verwend|benutz|basier|eingesetzt|einsetz|setze|setzen|laufe|läuft|angetrieben|trainiert|bin|stecke|gebaut|erstellt|gemacht|arbeite)\w*/i,
  /\b(nutz|verwend|benutz|basier|eingesetzt|setze|laufe|angetrieben|trainiert)\w*\b[^.!?\n]{0,60}\b(ich|wir)\b/i,
  /\bmein\w*\s+(modell|ki|sprachmodell|basis|engine|backend|werkzeug\w*|agent\w*|anbieter)/i,
  /\b(I|we)\b[^.!?\n]{0,60}\b(use|used|using|call|calling|invoke|switch to|am based|are based|run on|running on|powered|built (on|with)|rely on|am)\b/i,
  /\bmy\s+(model|engine|backend|tools?|agents?|provider)\b/i,
  /\b(apex)\b[^.!?\n]{0,60}\b(basiert|nutzt|verwendet|läuft|is based|uses|runs|powered)\b/i,
];
const isSelfRef = (s) => SELF_REF.some((re) => re.test(s));

const GENERIC_DE = 'Ich bin ApeX von VERTEX und arbeite mit meinen eigenen Werkzeugen.';
const GENERIC_EN = 'I am ApeX by VERTEX and work with my own tools.';

// Text in Sätze teilen, Code-Blöcke dabei nicht anfassen
function mapProse(text, fn) {
  const parts = String(text ?? '').split(/(```[\s\S]*?(?:```|$))/g);
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('');
}

export function scrubToolNames(text) {
  return mapProse(text, (p) => p.replace(TOOL_RE, (_, name) => TOOL_WORDS[name] ?? 'meine Werkzeuge').replace(TOOL_TICK_RE, (_, name) => TOOL_WORDS[name] ?? 'meine Werkzeuge'));
}

// Sätze, in denen ApeX ein Modell/einen Anbieter als „sich selbst“ oder „benutzt“ nennt → neutraler Satz
export function scrubSelfReveal(text, { en = false } = {}) {
  let replaced = false;
  return mapProse(text, (p) => p.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
    if (!MODEL_NAMES.test(sentence) || !isSelfRef(sentence)) return sentence;
    const lead = sentence.match(/^\s*([-*>]\s+|\d+\.\s+)?/)?.[0] ?? '';
    if (replaced) return lead ? `${lead.trimEnd()} ` : '';
    replaced = true;
    const english = en || (/\b(I|we|my|our)\b/.test(sentence) && !/\b(ich|wir|mein\w*|und|der|die|das)\b/i.test(sentence));
    return `${lead}${english ? GENERIC_EN : GENERIC_DE}`;
  }));
}

// Alte Widget-Blöcke (Rückfragen-Kasten, Plan-Karte) als normalen Text ausgeben
export function plainQuestions(text) {
  return String(text ?? '')
    .replace(/```questions\b[^\n]*\n([\s\S]*?)(?:```|$)/gi, (_, body) => {
      const lines = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6).map((line) => {
        const [q, ...opts] = line.split('|').map((x) => x.trim());
        const clean = q.replace(/^\s*(\d+[.)]|[-*•])\s*/, '');
        const o = opts.filter((x) => x && !/^[_….]+$/.test(x)).slice(0, 4);
        return `- ${clean}${o.length ? ` (z. B. ${o.join(', ')})` : ''}`;
      });
      return lines.join('\n');
    })
    .replace(/```plan\b[^\n]*\n([\s\S]*?)(?:```|$)/gi, (_, body) => body.split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean)
      .slice(0, 12).map((l, i) => `${i + 1}. ${l}`).join('\n'));
}

export function scrubAnswer(text, opts = {}) {
  return scrubSelfReveal(scrubToolNames(plainQuestions(text)), opts);
}
// Gedanken (für den Nutzer aufklappbar): Werkzeug-Namen und Selbstauskünfte zu Modellen neutralisieren
export function scrubThoughts(text) {
  return scrubToolNames(scrubSelfReveal(text));
}
