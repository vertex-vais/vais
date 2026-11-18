// Tagesbudget pro Nutzer: jeder bekommt pro Tag gleich viele Credits. Was eine Antwort kostet, hängt davon ab,
// wie viel ApeX dafür wirklich gearbeitet hat (Suchen, Bilder, Webseiten, viele Schritte …) – so reicht es für alle.
// Budget, Kosten und Schutz-Grenzen sind im Admin-Bereich einstellbar. Neu um Mitternacht (deutsche Zeit).
import { get, run, all, getSetting, setSetting } from './db.js';
import { t } from './i18n.js';
import { HttpError } from './auth.js';
import { isUnlimited } from './config.js';

export const LIMIT_FIELDS = {
  budget: { min: 0, max: 1000000, def: Number(process.env.USER_DAILY_CREDITS) || 100 }, // Credits pro Tag
  image: { min: 0, max: 100000, def: 20 }, // Sicherheits-Grenze: höchstens so viele Bilder pro Tag
  paidDaily: { min: 0, max: 10000, def: Number(process.env.PAID_DAILY_LIMIT ?? 20) }, // Premium-Antworten pro Tag
  burst: { min: 1, max: 1000, def: 40 }, // höchstens so viele Anfragen in 5 Minuten
  maxChats: { min: 0, max: 1000, def: 200 }, // so viele aktive Chats pro Person (0 = unbegrenzt). Darüber wird der älteste still archiviert, nicht gelöscht.
};
// Was welche Arbeit kostet (Credits). Grundpreis + Zuschläge, gedeckelt pro Auftrag.
export const COST_FIELDS = {
  answer: { min: 0, max: 100, def: 1 }, // jede Antwort (Grundpreis)
  long: { min: 0, max: 100, def: 1 }, // Zuschlag: lange oder gründlich durchdachte Antwort
  web: { min: 0, max: 100, def: 2 }, // Zuschlag: Websuche
  webMore: { min: 0, max: 100, def: 1 }, // je weitere Suche / gelesene Seite
  deep: { min: 0, max: 200, def: 8 }, // Zuschlag: Tiefe Recherche (viele Quellen)
  image: { min: 0, max: 200, def: 4 }, // je Bild
  heavy: { min: 0, max: 200, def: 9 }, // Zuschlag: schwere Frage, mehrere Durchgänge mit Gegenprüfung
  site: { min: 0, max: 500, def: 14 }, // je gebaute Webseite / App
  siteEdit: { min: 0, max: 500, def: 4 }, // je Änderung an einer Webseite
  step: { min: 0, max: 100, def: 1 }, // je weiterer Arbeitsschritt ab dem 4.
  max: { min: 1, max: 1000, def: 30 }, // höchstens so viel pro Auftrag
};
export const FREE_STEPS = 3;
const LONG_CHARS = 3000;

// Was hat eine Antwort gekostet? work = das, was die Pipeline wirklich gemacht hat.
// { answered, chars, reasoning, think, calls, searches, reads, deep, heavy, images, sites, siteEdits, rounds }
export function workCost(work = {}, C = defaultCosts()) {
  const n = (x) => Math.max(0, Number(x) || 0);
  if (!work.answered && !n(work.images)) return 0;
  let cost = n(C.answer);
  const long = work.reasoning || work.think || n(work.chars) > LONG_CHARS || n(work.calls) >= 3;
  if (long) cost += n(C.long);
  const looked = n(work.searches) + n(work.reads);
  if (work.deep) cost += n(C.deep);
  else if (looked > 0) cost += n(C.web) + n(C.webMore) * (looked - 1);
  if (work.heavy) cost += n(C.heavy);
  cost += n(C.image) * n(work.images);
  cost += n(C.site) * n(work.sites) + n(C.siteEdit) * n(work.siteEdits);
  cost += n(C.step) * Math.max(0, n(work.rounds) - FREE_STEPS);
  return Math.max(Math.min(cost, n(C.max) || cost), 0);
}
export const defaultCosts = () => Object.fromEntries(Object.entries(COST_FIELDS).map(([k, f]) => [k, f.def]));

let costCache = null;
let costAt = 0;
export async function costSettings() {
  if (costCache && Date.now() - costAt < 30_000) return costCache;
  let saved = {};
  try { saved = JSON.parse(await getSetting('credit_costs', '{}')) || {}; } catch { saved = {}; }
  costCache = Object.fromEntries(Object.entries(COST_FIELDS).map(([k, f]) => [k, Number.isFinite(saved[k]) ? saved[k] : f.def]));
  costAt = Date.now();
  return costCache;
}
export async function saveCostSettings(input) {
  const next = { ...(await costSettings()) };
  for (const [k, f] of Object.entries(COST_FIELDS)) {
    if (input?.[k] === undefined) continue;
    const v = Math.round(Number(input[k]));
    if (!Number.isFinite(v) || v < f.min || v > f.max) throw new HttpError(400, t(`Ungültiger Wert für „${k}“ (${f.min}–${f.max}).`, `Invalid value for “${k}” (${f.min}–${f.max}).`));
    next[k] = v;
  }
  await setSetting('credit_costs', JSON.stringify(next));
  costCache = next;
  costAt = Date.now();
  return next;
}

let cached = null;
let cachedAt = 0;
export async function limitSettings() {
  if (cached && Date.now() - cachedAt < 30_000) return cached;
  let saved = {};
  try { saved = JSON.parse(await getSetting('limits', '{}')) || {}; } catch { saved = {}; }
  cached = Object.fromEntries(Object.entries(LIMIT_FIELDS).map(([k, f]) => [k, Number.isFinite(saved[k]) ? saved[k] : f.def]));
  cachedAt = Date.now();
  return cached;
}
export async function saveLimitSettings(input) {
  const cur = await limitSettings();
  const next = { ...cur };
  for (const [k, f] of Object.entries(LIMIT_FIELDS)) {
    if (input?.[k] === undefined) continue;
    const n = Math.round(Number(input[k]));
    if (!Number.isFinite(n) || n < f.min || n > f.max) throw new HttpError(400, t(`Ungültiger Wert für „${k}“ (${f.min}–${f.max}).`, `Invalid value for “${k}” (${f.min}–${f.max}).`));
    next[k] = n;
  }
  await setSetting('limits', JSON.stringify(next));
  cached = next;
  cachedAt = Date.now();
  return next;
}

// Der Tag wechselt um Mitternacht deutscher Zeit
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayKey = (d = new Date()) => DAY_FMT.format(d);
export function nextReset() {
  // Mitternacht liegt immer auf einer Viertelstunde → in 15-Minuten-Schritten suchen (klappt auch bei Zeitumstellung)
  const step = 15 * 60 * 1000;
  const today = dayKey();
  let ts = Math.floor(Date.now() / step) * step;
  while (dayKey(new Date(ts)) === today) ts += step;
  return ts;
}

// Eigenes Limit eines Nutzers (vom Admin): null = Standard, -1 = unbegrenzt, sonst Prozent vom Standard (200 = doppelt)
// Admins sind nur im Testmodus unbegrenzt – sonst gelten für sie dieselben Limits wie für alle
async function userFactor(user) {
  if (isUnlimited(user)) return null;
  const own = (await get('SELECT daily_limit FROM users WHERE id = ?', user.id))?.daily_limit;
  if (own === -1 || own === '-1') return null;
  return own === null || own === undefined ? 1 : Math.max(0, Number(own)) / 100;
}
export const scaled = (base, factor) => (factor === null ? null : Math.round(base * factor));

// Gleiche Tabelle wie früher (keine Migration nötig): kind = 'credits' (verbrauchte Credits) bzw. 'image' (Anzahl Bilder)
await run(`CREATE TABLE IF NOT EXISTS usage_kinds (
  user_id INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
)`);
export const KINDS = ['credits', 'image'];

async function countsToday(userId) {
  const rows = await all("SELECT kind, n FROM usage_kinds WHERE user_id = ? AND day = ? AND kind IN ('credits', 'image')", userId, dayKey());
  return Object.fromEntries(KINDS.map((k) => [k, Number(rows.find((r) => r.kind === k)?.n ?? 0)]));
}
const add = (userId, kind, n) => run('INSERT INTO usage_kinds (user_id, day, kind, n) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, day, kind) DO UPDATE SET n = MAX(0, n + excluded.n)', userId, dayKey(), kind, n);

// Budget heute: limit/left = null → unbegrenzt
export async function budgetOf(user) {
  const [L, factor, used] = await Promise.all([limitSettings(), userFactor(user), countsToday(user.id)]);
  const limit = scaled(L.budget, factor);
  const imageLimit = scaled(L.image, factor);
  return {
    unlimited: factor === null,
    limit,
    used: used.credits,
    left: limit === null ? null : Math.max(0, limit - used.credits),
    imageLimit,
    imagesUsed: used.image,
    imagesLeft: imageLimit === null ? null : Math.max(0, imageLimit - used.image),
  };
}

// Verbrauch heute – für „Meine Statistik“ und die Warnung bei wenig Credits
export async function usageOf(user) {
  const [b, costs] = await Promise.all([budgetOf(user), costSettings()]);
  const percent = b.limit === null ? 0 : b.limit === 0 ? 100 : Math.min(100, Math.round((b.used / b.limit) * 100));
  return {
    unlimited: b.unlimited,
    credits: { used: b.used, limit: b.limit, left: b.left, percent },
    images: { used: b.imagesUsed, limit: b.imageLimit },
    percent,
    resetsAt: nextReset(),
    costs,
  };
}

const outOfCredits = (b, need) => new HttpError(429, b.limit === 0
  ? t('ApeX ist für dein Konto gerade nicht freigeschaltet.', 'ApeX is not enabled for your account right now.')
  : b.left > 0
    ? t(`Dafür brauchst du mindestens ${need} Credits – du hast heute nur noch ${b.left}. Um Mitternacht gibt es neue.`, `This needs at least ${need} credits – you only have ${b.left} left today. New ones arrive at midnight.`)
    : t(`Dein Tagesbudget ist aufgebraucht (${b.limit} von ${b.limit} Credits). Um Mitternacht gibt es neue Credits.`, `Your daily budget is used up (${b.limit} of ${b.limit} credits). New credits arrive at midnight.`),
{ usage: true, credits: { left: b.left, limit: b.limit } });

// Vorab: mindestens „amount“ Credits reservieren (gegen Doppelklicks). Abgerechnet wird am Ende mit settle().
// images: so viele Bilder sollen entstehen (Sicherheits-Grenze pro Tag)
export async function reserve(user, amount = 1, { images = 0 } = {}) {
  const need = Math.max(0, Math.round(Number(amount) || 0));
  const b = await budgetOf(user);
  if (b.limit !== null && (b.left < need || (need === 0 && b.left <= 0))) throw outOfCredits(b, need);
  if (images && b.imagesLeft !== null && b.imagesLeft < images) {
    throw new HttpError(429, b.imageLimit === 0
      ? t('Bilder sind für dich gerade nicht freigeschaltet.', 'Images are not enabled for you right now.')
      : t(`Du hast heute schon ${b.imageLimit} Bilder erstellt – das ist die Grenze pro Tag. Um Mitternacht geht es weiter.`, `You already created ${b.imageLimit} images today – that is the daily maximum. It resets at midnight.`), { usage: true });
  }
  if (need) await add(user.id, 'credits', need);
  return need;
}
// Am Ende: tatsächliche Kosten abrechnen (Differenz zur Reservierung). Nie unter 0 Credits übrig.
// Gibt zurück, was wirklich abgezogen wurde.
export async function settle(user, reserved, actual) {
  const r = Math.max(0, Number(reserved) || 0);
  const want = Math.max(0, Math.round(Number(actual) || 0));
  if (want === r) return want;
  if (want < r) { await add(user.id, 'credits', want - r); return want; }
  const b = await budgetOf(user);
  const extra = b.left === null ? want - r : Math.min(want - r, b.left);
  if (extra > 0) await add(user.id, 'credits', extra);
  return r + extra;
}
// Hat ApeX gar nicht geantwortet, kostet es nichts
export async function refund(user, amount) {
  const n = Math.max(0, Number(amount) || 0);
  if (!user || !n) return;
  await add(user.id, 'credits', -n).catch(() => {});
}
export async function countImages(user, n) {
  if (n > 0) await add(user.id, 'image', n).catch(() => {});
}
export async function resetUsage(userId) {
  await run('DELETE FROM usage_kinds WHERE user_id = ? AND day = ?', userId, dayKey());
  await run('DELETE FROM usage WHERE user_id = ? AND day = ?', userId, dayKey()).catch(() => {});
}
// Für den Admin: Verbrauch heute je Nutzer → { credits, image }
export async function usageMap() {
  const rows = await all("SELECT user_id, kind, n FROM usage_kinds WHERE day = ? AND kind IN ('credits', 'image')", dayKey());
  const map = new Map();
  for (const r of rows) {
    const id = Number(r.user_id);
    if (!map.has(id)) map.set(id, Object.fromEntries(KINDS.map((k) => [k, 0])));
    map.get(id)[r.kind] = Number(r.n);
  }
  return map;
}
export async function usageHistory(userId) {
  const rows = await all('SELECT day, kind, n FROM usage_kinds WHERE user_id = ? ORDER BY day', userId);
  const days = new Map();
  for (const r of rows) { if (!days.has(r.day)) days.set(r.day, { day: r.day }); days.get(r.day)[r.kind] = Number(r.n); }
  return [...days.values()];
}
// Alte Tage aufräumen (älter als 60 Tage)
setInterval(() => {
  const old = dayKey(new Date(Date.now() - 60 * 24 * 3600 * 1000));
  run('DELETE FROM usage_kinds WHERE day < ?', old).catch(() => {});
  run('DELETE FROM usage WHERE day < ?', old).catch(() => {});
}, 6 * 3600 * 1000).unref();
