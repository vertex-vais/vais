// Öffentliche Adresse der App: CANONICAL_URL hat Vorrang (alte Hosts leiten dorthin um).
// Danach APP_URL, danach RENDER_EXTERNAL_URL (setzt Render automatisch).

export function parseCanonical(env = process.env) {
  const raw = String(env.CANONICAL_URL || '').trim().replace(/\/$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || !url.host) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function publicOrigin(req, env = process.env) {
  const raw = parseCanonical(env) || String(env.APP_URL || env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
  if (raw) {
    try { return new URL(raw).origin; } catch { /* ungültig – Anfrage als Fallback */ }
  }
  if (req) return `${req.protocol}://${req.get('host')}`;
  return '';
}

const SKIP = new Set(['/healthz', '/api/status']);

// 301 zur kanonischen Adresse, wenn der Host nicht übereinstimmt.
// Ausnahmen: Gesundheits-Checks, Status, Telegram-Webhook und alle nicht-GET/HEAD-Anfragen.
export function canonicalRedirect(req, res, next) {
  const canonical = parseCanonical();
  if (!canonical) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const path = req.path || '';
  if (SKIP.has(path) || path.startsWith('/api/telegram')) return next();
  const got = String(req.get('host') || '').toLowerCase();
  const want = new URL(canonical).host.toLowerCase();
  if (!got || got === want) return next();
  return res.redirect(301, canonical + (req.originalUrl || '/'));
}
