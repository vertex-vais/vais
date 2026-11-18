// API-Keys aus dem Admin-Bereich, für alle Anbieter.
// Gespeichert wird nur Geheimtext (AES-256-GCM). An den Browser gehen danach nur Bezeichnung,
// Anbieter und die letzten 4 Zeichen. Gespeicherte, aktivierte Schlüssel werden reihum benutzt
// und haben Vorrang. Umgebungsvariablen (z. B. GROQ_API_KEY) sind nur der Ersatz, wenn kein
// gespeicherter Schlüssel frei ist. 401 und 429 setzen eine Pause.
//
// NVIDIA (kostenloses Kontingent auf build.nvidia.com) bleibt adminOnly: getActiveProviderKey
// und keysForUser liefern die Schlüssel ohne { admin: true } nie. Ausnahme nur der ApeX-Ersatz,
// wenn die Einstellung nvidia_fallback an ist (Standard: an). Aus = wieder nur für Admins.
//
// Verschlüsselung: KEY_ENCRYPTION_SECRET (langer Zufallswert). Fehlt sie, wird aus einem vorhandenen
// Server-Geheimnis abgeleitet (DATABASE_TOKEN, sonst SMTP_PASS, sonst BREVO_API_KEY, sonst
// GOOGLE_CLIENT_SECRET) und eine Warnung geloggt. Ohne jedes dieser Geheimnisse bleibt nur ein
// lokaler Ersatz – nicht für Produktion. Ein späterer Wechsel macht gespeicherte Keys unlesbar.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { all, get, run, getSetting, setSetting } from './db.js';
import { t } from './i18n.js';

// Reihenfolge = Reihenfolge im Admin-Bereich
export const CATALOG = {
  cursor: { label: 'Cursor', labelEn: 'Cursor', env: ['CURSOR_API_KEY'], test: { type: 'basic-get', url: 'https://api.cursor.com/v0/me' } },
  groq: { label: 'Groq', labelEn: 'Groq', env: ['GROQ_API_KEY'], test: { type: 'bearer-get', url: 'https://api.groq.com/openai/v1/models' } },
  openrouter: { label: 'OpenRouter', labelEn: 'OpenRouter', env: ['OPENROUTER_API_KEY'], test: { type: 'bearer-get', url: 'https://openrouter.ai/api/v1/key' } },
  gemini: { label: 'Google AI Studio (Gemini)', labelEn: 'Google AI Studio (Gemini)', env: ['GEMINI_API_KEY'], test: { type: 'gemini' } },
  cerebras: { label: 'Cerebras', labelEn: 'Cerebras', env: ['CEREBRAS_API_KEY'], test: { type: 'bearer-get', url: 'https://api.cerebras.ai/v1/models' } },
  mistral: { label: 'Mistral', labelEn: 'Mistral', env: ['MISTRAL_API_KEY'], test: { type: 'bearer-get', url: 'https://api.mistral.ai/v1/models' } },
  nvidia: { label: 'NVIDIA NIM', labelEn: 'NVIDIA NIM', env: ['NVIDIA_API_KEY'], adminOnly: true, test: { type: 'bearer-get', url: 'https://integrate.api.nvidia.com/v1/models' } },
  custom: { label: 'Benutzerdefiniert (OpenAI-kompatibel)', labelEn: 'Custom (OpenAI-compatible)', env: ['CUSTOM_OPENAI_API_KEY'], needsEndpoint: true, test: { type: 'custom' } },
  pollinations: { label: 'Pollinations (Bilder)', labelEn: 'Pollinations (images)', env: ['POLLINATIONS_API_KEY'], test: { type: 'bearer-get', url: 'https://gen.pollinations.ai/image/models' } },
  together: { label: 'Together', labelEn: 'Together', env: ['TOGETHER_API_KEY'], test: { type: 'bearer-get', url: 'https://api.together.xyz/v1/models' } },
  tavily: { label: 'Tavily (Websuche)', labelEn: 'Tavily (web search)', env: ['TAVILY_API_KEY'], test: { type: 'tavily' } },
  exa: { label: 'Exa (Websuche)', labelEn: 'Exa (web search)', env: ['EXA_API_KEY'], test: { type: 'exa' } },
  jina: { label: 'Jina (Websuche)', labelEn: 'Jina (web search)', env: ['JINA_API_KEY'], test: { type: 'bearer-get', url: 'https://s.jina.ai/?q=ping', headers: { Accept: 'application/json', 'X-Respond-With': 'no-content' } } },
  // GitHub Models wurde im Juli 2026 eingestellt. Bleibt nur sichtbar, damit alte Schlüssel gelöscht werden können.
  github: { label: 'GitHub Models', labelEn: 'GitHub Models', env: ['GITHUB_MODELS_TOKEN'], retired: true, retiredNote: 'eingestellt (Juli 2026)', retiredNoteEn: 'retired (July 2026)', test: { type: 'bearer-get', url: 'https://models.github.ai/inference/models' } },
};

export const CURSOR_COOLDOWN_MS = { 401: 10 * 60 * 1000, 429: 60 * 1000 };
const COOLDOWNS = new Map();
const ENV_COOLDOWNS = new Map();
const ROTATE = new Map();
let warned = false;
let keyCache = null;
let plainCache = new Map();

await run(`CREATE TABLE IF NOT EXISTS provider_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  secret TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  last4 TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  base_url TEXT,
  model_name TEXT,
  created_at INTEGER NOT NULL
)`);

const SOURCES = ['DATABASE_TOKEN', 'SMTP_PASS', 'BREVO_API_KEY', 'GOOGLE_CLIENT_SECRET'];

export function encryptionSource() {
  if (process.env.KEY_ENCRYPTION_SECRET?.trim()) return 'env';
  if (SOURCES.some((name) => process.env[name]?.trim())) return 'derived';
  return 'fallback';
}

function material() {
  const explicit = process.env.KEY_ENCRYPTION_SECRET?.trim();
  if (explicit) return explicit;
  const found = SOURCES.find((name) => process.env[name]?.trim());
  if (found) {
    if (!warned) {
      console.warn(`KEY_ENCRYPTION_SECRET ist nicht gesetzt. API-Keys werden mit einem Schlüssel verschlüsselt, der aus ${found} abgeleitet wird. Setze KEY_ENCRYPTION_SECRET (langer Zufallswert), bevor du Keys in Produktion speicherst. Ein späterer Wechsel macht bereits gespeicherte Keys unlesbar.`);
      warned = true;
    }
    return `derived:${found}:${process.env[found].trim()}`;
  }
  if (!warned) {
    console.warn('KEY_ENCRYPTION_SECRET ist nicht gesetzt und kein Server-Geheimnis (DATABASE_TOKEN, SMTP_PASS, BREVO_API_KEY, GOOGLE_CLIENT_SECRET) vorhanden. API-Keys werden mit einem lokalen Ersatz verschlüsselt. Setze KEY_ENCRYPTION_SECRET, bevor du Keys in Produktion speicherst.');
    warned = true;
  }
  return 'local-fallback:vais-provider-keys';
}

function key32() {
  const raw = material();
  if (!keyCache || keyCache.raw !== raw) keyCache = { raw, key: scryptSync(raw, 'vais-cursor-keys-v1', 32) };
  return keyCache.key;
}

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key32(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored) {
  try {
    const [ver, ivB64, tagB64, dataB64] = String(stored ?? '').split(':');
    if (ver !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', key32(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function maskKey(key) {
  const s = String(key ?? '');
  const last4 = s.slice(-4);
  return { last4, masked: `••••${last4}` };
}

const hashKey = (provider, key) => createHash('sha256').update(`${provider}\0${key}`).digest('hex');

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export const isAdminOnlyProvider = (provider) => !!CATALOG[provider]?.adminOnly;

function envValues(names = []) {
  const raw = [];
  for (const name of names) {
    raw.push(process.env[name]);
    for (let i = 2; i <= 9; i++) raw.push(process.env[`${name}_${i}`]);
  }
  return [...new Set(raw.flatMap((v) => String(v ?? '').split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean))];
}

export function catalogPublic() {
  return Object.entries(CATALOG).map(([id, spec]) => ({
    id,
    label: spec.label,
    labelEn: spec.labelEn,
    adminOnly: !!spec.adminOnly,
    needsEndpoint: !!spec.needsEndpoint,
    retired: !!spec.retired,
    retiredNote: spec.retired ? spec.retiredNote : null,
    retiredNoteEn: spec.retired ? spec.retiredNoteEn : null,
    env: spec.env[0],
    envConfigured: envValues(spec.env).length > 0,
  }));
}

function rowPublic(r, readable) {
  const spec = CATALOG[r.provider] ?? { label: r.provider, labelEn: r.provider };
  return {
    id: Number(r.id),
    provider: r.provider,
    providerLabel: spec.label,
    providerLabelEn: spec.labelEn,
    label: r.label,
    masked: `••••${r.last4}`,
    enabled: Number(r.enabled) === 1,
    adminOnly: !!spec.adminOnly,
    baseUrl: r.base_url || null,
    model: r.model_name || null,
    created: Number(r.created_at),
    readable,
  };
}

export async function refreshKeyCache() {
  const rows = await all('SELECT id, provider, label, secret, last4, base_url, model_name FROM provider_api_keys WHERE enabled = 1 ORDER BY id');
  const next = new Map();
  for (const r of rows) {
    const key = decryptSecret(r.secret);
    if (!key) continue;
    const list = next.get(r.provider) ?? [];
    list.push({
      id: Number(r.id), provider: r.provider, label: r.label, key, last4: r.last4,
      baseUrl: r.base_url || null, model: r.model_name || null, adminOnly: isAdminOnlyProvider(r.provider),
    });
    next.set(r.provider, list);
  }
  plainCache = next;
}

export function cachedKeys(provider) {
  return plainCache.get(provider) ?? [];
}

// Schlüssel, die für normale Nutzer benutzt werden dürfen. adminOnly (NVIDIA) ist hier immer leer.
// Der ApeX-Ersatz liest NVIDIA separat über nvidiaFallbackOn() in models.js – nicht über diese Funktion.
export function keysForUser(provider) {
  if (isAdminOnlyProvider(provider)) return [];
  return cachedKeys(provider).map((k) => k.key);
}

// NVIDIA als Ersatz für normale Nutzer, wenn andere Anbieter voll sind. Standard an.
// adminOnly selbst bleibt: getActiveProviderKey('nvidia') ohne { admin: true } liefert weiter null.
let nvidiaFallback = true;
export function nvidiaFallbackOn() { return nvidiaFallback; }
export async function loadNvidiaFallback() {
  try { nvidiaFallback = (await getSetting('nvidia_fallback', 'on')) !== 'off'; } catch { nvidiaFallback = true; }
  return nvidiaFallback;
}
export async function setNvidiaFallback(on) {
  nvidiaFallback = !!on;
  await setSetting('nvidia_fallback', on ? 'on' : 'off');
  return nvidiaFallback;
}

function endpointOf(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw fail(t('Die Basis-URL ist ungültig.', 'The base URL is invalid.')); }
  if (url.protocol !== 'https:') throw fail(t('Die Basis-URL muss mit https:// beginnen.', 'The base URL must start with https://.'));
  if (url.username || url.password) throw fail(t('Die Basis-URL darf keinen Schlüssel enthalten.', 'The base URL must not contain a secret.'));
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === 'metadata.google.internal' || host === '0.0.0.0') throw fail(t('Diese Basis-URL ist nicht erlaubt.', 'This base URL is not allowed.'));
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) throw fail(t('Diese Basis-URL ist nicht erlaubt.', 'This base URL is not allowed.'));
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export async function listProviderKeysPublic() {
  const rows = await all('SELECT id, provider, label, secret, last4, enabled, base_url, model_name, created_at FROM provider_api_keys ORDER BY provider, id');
  return {
    providers: catalogPublic(),
    keys: rows.map((r) => rowPublic(r, decryptSecret(r.secret) !== null)),
    encryption: encryptionSource(),
  };
}

export async function addProviderKey({ provider, label: labelRaw, key: keyRaw, baseUrl, model } = {}) {
  const spec = CATALOG[provider];
  if (!spec) throw fail(t('Unbekannter Anbieter.', 'Unknown provider.'));
  if (spec.retired) throw fail(t(`${spec.label} wurde ${spec.retiredNote} – neue Schlüssel sind nicht mehr möglich.`, `${spec.labelEn} was ${spec.retiredNoteEn} – new keys are no longer possible.`));
  const key = String(keyRaw ?? '').trim();
  let label = String(labelRaw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!label) label = `${spec.label.replace(/\s*\(.*\)$/, '')} ••••${key.slice(-4)}`.slice(0, 40);
  if (label.length < 2) throw fail(t('Die Bezeichnung ist zu kurz.', 'The label is too short.'));
  if (!/^[\x21-\x7e]{16,400}$/.test(key)) throw fail(t('Das sieht nicht wie ein Schlüssel aus.', 'That does not look like a key.'));
  let base = null;
  let modelName = null;
  if (spec.needsEndpoint) {
    base = endpointOf(baseUrl);
    modelName = String(model ?? '').trim();
    if (!/^[\w.\-:/@]{1,120}$/.test(modelName)) throw fail(t('Bitte einen Modellnamen eintragen.', 'Please enter a model name.'));
  }
  const keyHash = hashKey(provider, key);
  if (await get('SELECT id FROM provider_api_keys WHERE provider = ? AND key_hash = ?', provider, keyHash)) throw fail(t('Diesen Schlüssel gibt es schon.', 'This key already exists.'));
  const { last4 } = maskKey(key);
  await run(
    'INSERT INTO provider_api_keys (provider, label, secret, key_hash, last4, enabled, base_url, model_name, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
    provider, label, encryptSecret(key), keyHash, last4, base, modelName, Date.now(),
  );
  await refreshKeyCache();
  const row = await get('SELECT id, label, last4 FROM provider_api_keys WHERE provider = ? AND key_hash = ?', provider, keyHash);
  return { id: Number(row.id), provider, label: row.label, masked: `••••${row.last4}` };
}

export async function setProviderKeyEnabled(idRaw, enabled) {
  const id = Number(idRaw);
  const row = Number.isInteger(id) ? await get('SELECT id FROM provider_api_keys WHERE id = ?', id) : null;
  if (!row) throw fail(t('Schlüssel nicht gefunden.', 'Key not found.'));
  await run('UPDATE provider_api_keys SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id);
  await refreshKeyCache();
}

export async function removeProviderKey(idRaw) {
  const id = Number(idRaw);
  const row = Number.isInteger(id) ? await get('SELECT id, provider, label, last4 FROM provider_api_keys WHERE id = ?', id) : null;
  if (!row) throw fail(t('Schlüssel nicht gefunden.', 'Key not found.'));
  await run('DELETE FROM provider_api_keys WHERE id = ?', id);
  COOLDOWNS.delete(id);
  await refreshKeyCache();
  return { id, provider: row.provider, label: row.label, masked: `••••${row.last4}` };
}

function cooled(mapKey, now) {
  return (COOLDOWNS.get(mapKey) ?? ENV_COOLDOWNS.get(mapKey) ?? 0) > now;
}

export function noteProviderKeyFailure(id, status, now = Date.now()) {
  const ms = CURSOR_COOLDOWN_MS[Number(status)];
  if (!ms || id == null) return;
  COOLDOWNS.set(Number(id), now + ms);
}

export function noteFailureBySecret(provider, secret, status, now = Date.now()) {
  const ms = CURSOR_COOLDOWN_MS[Number(status)];
  if (!ms || !secret) return;
  const row = cachedKeys(provider).find((k) => k.key === secret);
  if (row) COOLDOWNS.set(row.id, now + ms);
  else ENV_COOLDOWNS.set(`${provider}:${secret}`, now + ms);
}

export function resetCursorRotation() {
  ROTATE.clear();
  COOLDOWNS.clear();
  ENV_COOLDOWNS.clear();
}
export const resetProviderRotation = resetCursorRotation;

function envFallback(provider, spec, now) {
  const list = envValues(spec.env).filter((k) => !cooled(`${provider}:${k}`, now));
  if (!list.length) return null;
  const at = ROTATE.get(`env:${provider}`) ?? 0;
  ROTATE.set(`env:${provider}`, (at + 1) >>> 0);
  const key = list[at % list.length];
  const { last4, masked } = maskKey(key);
  const baseUrl = provider === 'custom' ? String(process.env.CUSTOM_OPENAI_BASE_URL ?? '').trim() || null : null;
  const model = provider === 'custom' ? String(process.env.CUSTOM_OPENAI_MODEL ?? '').trim() || null : null;
  return { id: null, provider, key, source: 'env', label: spec.env[0], last4, masked, baseUrl, model, adminOnly: !!spec.adminOnly };
}

// Reihum unter den aktivierten Panel-Schlüsseln. Danach die passende Umgebungsvariable.
// adminOnly-Anbieter (NVIDIA) liefern ohne { admin: true } immer null – auch die Env-Variable nicht.
export async function getActiveProviderKey(provider, { admin = false, now = Date.now() } = {}) {
  const spec = CATALOG[provider];
  if (!spec) return null;
  if (spec.adminOnly && !admin) return null;
  const usable = cachedKeys(provider).filter((r) => !cooled(r.id, now));
  if (usable.length) {
    const at = ROTATE.get(provider) ?? 0;
    ROTATE.set(provider, (at + 1) >>> 0);
    const pick = usable[at % usable.length];
    return { ...pick, source: 'admin', masked: `••••${pick.last4}` };
  }
  return envFallback(provider, spec, now);
}

export function peekProviderKey(provider, opts = {}) {
  const spec = CATALOG[provider];
  if (!spec || (spec.adminOnly && !opts.admin)) return null;
  const now = Date.now();
  const usable = cachedKeys(provider).filter((r) => !cooled(r.id, now));
  if (usable.length) {
    const at = ROTATE.get(provider) ?? 0;
    const pick = usable[at % usable.length];
    return { ...pick, source: 'admin', masked: `••••${pick.last4}` };
  }
  const list = envValues(spec.env).filter((k) => !cooled(`${provider}:${k}`, now));
  if (!list.length) return null;
  const at = ROTATE.get(`env:${provider}`) ?? 0;
  const key = list[at % list.length];
  const { last4, masked } = maskKey(key);
  return { id: null, provider, key, source: 'env', label: spec.env[0], last4, masked, adminOnly: !!spec.adminOnly };
}

async function testRequest(row, key, fetchImpl) {
  const spec = CATALOG[row.provider];
  const test = spec?.test ?? { type: 'bearer-get' };
  const bearer = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  if (test.type === 'basic-get') {
    const token = Buffer.from(`${key}:`, 'utf8').toString('base64');
    return fetchImpl(test.url, { headers: { Authorization: `Basic ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  }
  if (test.type === 'gemini') {
    return fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(12_000) });
  }
  if (test.type === 'tavily') {
    return fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'ping', max_results: 1, search_depth: 'basic', include_answer: false }),
      signal: AbortSignal.timeout(12_000),
    });
  }
  if (test.type === 'exa') {
    return fetchImpl('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: 'ping', numResults: 1 }),
      signal: AbortSignal.timeout(12_000),
    });
  }
  if (test.type === 'custom') {
    const base = row.base_url || String(process.env.CUSTOM_OPENAI_BASE_URL ?? '').trim();
    if (!base) throw fail(t('Für den Test fehlt die Basis-URL.', 'The test needs a base URL.'));
    const root = endpointOf(base);
    const modelsRes = await fetchImpl(`${root}/models`, { headers: bearer, signal: AbortSignal.timeout(12_000) });
    // Cloudflare Workers AI (…/ai/v1) hat kein GET /models (404 oder 405). Dann ein winziger Chat mit dem gespeicherten Modell.
    if (modelsRes.ok || (modelsRes.status !== 404 && modelsRes.status !== 405)) return modelsRes;
    const model = String(row.model_name || row.model || process.env.CUSTOM_OPENAI_MODEL || '').trim();
    if (!model) return modelsRes;
    return fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(12_000),
    });
  }
  return fetchImpl(test.url, { headers: { ...bearer, ...(test.headers ?? {}) }, signal: AbortSignal.timeout(12_000) });
}

export async function testProviderKey(idRaw, fetchImpl = globalThis.fetch) {
  const id = Number(idRaw);
  const row = Number.isInteger(id) ? await get('SELECT id, provider, secret, label, base_url, model_name FROM provider_api_keys WHERE id = ?', id) : null;
  if (!row) throw fail(t('Schlüssel nicht gefunden.', 'Key not found.'));
  const key = decryptSecret(row.secret);
  if (!key) throw fail(t('Der Schlüssel lässt sich nicht lesen. Bitte neu eintragen.', 'The key cannot be read. Please add it again.'));
  let res;
  try { res = await testRequest(row, key, fetchImpl); } catch (err) {
    if (err?.status === 400) throw err;
    return { ok: false, status: 0, message: t('Fehler: keine Verbindung.', 'Error: no connection.') };
  }
  if (res.status === 401 || res.status === 429) noteProviderKeyFailure(id, res.status);
  if (res.ok) return { ok: true, status: res.status, message: 'OK' };
  return { ok: false, status: res.status, message: t(`Fehler (${res.status})`, `Error (${res.status})`) };
}

// Ältere Schlüssel übernehmen:
// 1. Tabelle cursor_api_keys (schon verschlüsselt, PR #1) – einmalig.
// 2. Einstellung api_keys: der frühere Bereich „API-Schlüssel“ hat Schlüssel im KLARTEXT als JSON
//    ({ groq: ['gsk_…'], … }) gespeichert. Bei jedem Start wird übernommen, was dort noch steht,
//    verschlüsselt gespeichert und danach aus der Einstellung gelöscht. Ein Schlüssel, der nicht
//    übernommen werden konnte, bleibt stehen (nichts geht verloren) und wird beim nächsten Start erneut versucht.
const LEGACY_LABEL = 'Übernommen';
export async function migrateLegacy() {
  if (!(await getSetting('provider_keys_migrated', null))) {
    try {
      const old = await all('SELECT label, secret, last4, enabled, created_at FROM cursor_api_keys');
      for (const r of old) {
        const plain = decryptSecret(r.secret);
        if (!plain) continue;
        const keyHash = hashKey('cursor', plain);
        if (await get('SELECT id FROM provider_api_keys WHERE provider = ? AND key_hash = ?', 'cursor', keyHash)) continue;
        await run(
          'INSERT INTO provider_api_keys (provider, label, secret, key_hash, last4, enabled, base_url, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
          'cursor', r.label, r.secret, keyHash, r.last4, Number(r.enabled) ? 1 : 0, Number(r.created_at) || Date.now(),
        );
      }
    } catch { /* alte Tabelle gibt es nicht */ }
    await setSetting('provider_keys_migrated', '1');
  }
  let parsed = {};
  try { parsed = JSON.parse(await getSetting('api_keys', '{}') || '{}') || {}; } catch { parsed = {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) return { moved: 0, kept: 0 };
  const keep = {};
  let moved = 0;
  for (const [provider, keys] of Object.entries(parsed)) {
    if (!Array.isArray(keys)) continue;
    for (const raw of keys) {
      const key = String(raw ?? '').trim();
      if (!CATALOG[provider] || !/^[\x21-\x7e]{16,400}$/.test(key)) continue; // unbrauchbar → verwerfen
      const keyHash = hashKey(provider, key);
      try {
        if (!(await get('SELECT id FROM provider_api_keys WHERE provider = ? AND key_hash = ?', provider, keyHash))) {
          const secret = encryptSecret(key);
          if (decryptSecret(secret) !== key) throw new Error('Verschlüsselung prüft nicht');
          await run(
            'INSERT INTO provider_api_keys (provider, label, secret, key_hash, last4, enabled, base_url, model_name, created_at) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?)',
            provider, LEGACY_LABEL, secret, keyHash, maskKey(key).last4, Date.now(),
          );
        }
        moved++;
      } catch {
        (keep[provider] ??= []).push(key);
      }
    }
  }
  const kept = Object.values(keep).reduce((n, l) => n + l.length, 0);
  await setSetting('api_keys', JSON.stringify(keep));
  if (moved) {
    await refreshKeyCache();
    console.log(`API-Keys: ${moved} ältere Schlüssel verschlüsselt übernommen${kept ? `, ${kept} noch offen` : ''}.`);
  }
  return { moved, kept };
}

try { await migrateLegacy(); } catch (err) { console.error('API-Keys übernehmen fehlgeschlagen:', err.message); }
await refreshKeyCache();
await loadNvidiaFallback();

// Ein Schlüssel ohne Speichern testen (für „vor dem Speichern testen“). Liefert nie den Schlüssel zurück.
export async function testPlainKey({ provider, key, baseUrl, model } = {}, fetchImpl = globalThis.fetch) {
  if (!CATALOG[provider]) throw fail(t('Unbekannter Anbieter.', 'Unknown provider.'));
  const row = { provider, base_url: provider === 'custom' ? endpointOf(baseUrl) : null, model_name: model || null };
  try {
    const res = await testRequest(row, String(key ?? '').trim(), fetchImpl);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    if (err?.status === 400) throw err;
    return { ok: false, status: 0 };
  }
}

// Ein Bereich für alles: pro Anbieter die gespeicherten Schlüssel und die aus der Umgebung (Render),
// jeweils nur mit den letzten 4 Zeichen. runtime(provider, key) liefert Zustand und Verbrauch
// (kommt aus models.js; der Schlüssel selbst verlässt den Server nie).
export async function listUnifiedKeys(runtime = () => ({})) {
  const rows = await all('SELECT id, provider, label, secret, last4, enabled, base_url, model_name, created_at FROM provider_api_keys ORDER BY provider, id');
  const now = Date.now();
  const flat = [];
  const providers = catalogPublic().map((p) => {
    const spec = CATALOG[p.id];
    const saved = rows.filter((r) => r.provider === p.id).map((r) => {
      const plain = decryptSecret(r.secret);
      const base = rowPublic(r, plain !== null);
      const rt = plain ? runtime(p.id, plain) ?? {} : {};
      const paused = COOLDOWNS.get(Number(r.id)) ?? 0;
      const out = {
        ...base,
        source: 'saved',
        state: paused > now ? 'full' : rt.state ?? 'ok',
        until: paused > now ? Math.max(paused, rt.until ?? 0) : rt.until ?? null,
        usage: rt.usage ?? null,
        tracked: !!rt.tracked,
      };
      flat.push(out);
      return out;
    });
    const savedPlain = new Set(cachedKeys(p.id).map((k) => k.key));
    const env = envValues(spec.env).filter((k) => !savedPlain.has(k)).map((k, i) => {
      const rt = runtime(p.id, k) ?? {};
      const paused = ENV_COOLDOWNS.get(`${p.id}:${k}`) ?? 0;
      return {
        id: null,
        provider: p.id,
        source: 'env',
        label: i ? `${spec.env[0]} (${i + 1})` : spec.env[0],
        masked: `••••${maskKey(k).last4}`,
        enabled: true,
        readable: true,
        adminOnly: !!spec.adminOnly,
        state: paused > now ? 'full' : rt.state ?? 'ok',
        until: paused > now ? Math.max(paused, rt.until ?? 0) : rt.until ?? null,
        usage: rt.usage ?? null,
        tracked: !!rt.tracked,
      };
    });
    return { ...p, keys: [...saved, ...env] };
  });
  return { providers, keys: flat, encryption: encryptionSource(), nvidiaFallback: nvidiaFallbackOn() };
}

// Cursor-Aliase, damit bestehende Aufrufe gleich bleiben.
export const listCursorKeysPublic = async () => {
  const data = await listProviderKeysPublic();
  return { ...data, keys: data.keys.filter((k) => k.provider === 'cursor'), envConfigured: envValues(['CURSOR_API_KEY']).length > 0 };
};
export const addCursorKey = (label, key) => addProviderKey({ provider: 'cursor', label, key });
export const setCursorKeyEnabled = setProviderKeyEnabled;
export const removeCursorKey = removeProviderKey;
export const testCursorKey = testProviderKey;
export const noteCursorKeyFailure = noteProviderKeyFailure;
export const getActiveCursorKey = (now = Date.now()) => getActiveProviderKey('cursor', { now });
