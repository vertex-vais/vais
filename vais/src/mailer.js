import nodemailer from 'nodemailer';
import { lang } from './i18n.js';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
const BREVO_API_KEY = process.env.BREVO_API_KEY?.trim();
const FROM = process.env.MAIL_FROM || 'ApeX <no-reply@example.com>';

// Zwei Wege: Brevo-API (nur BREVO_API_KEY nötig, läuft über https) oder klassisches SMTP.
const smtpConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
export const mailConfigured = Boolean(BREVO_API_KEY) || smtpConfigured;

const port = Number(SMTP_PORT) || 587;
const transport = !BREVO_API_KEY && smtpConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465 || port === 2465, // sonst STARTTLS (587, 2525)
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

const TEXTS = {
  de: {
    verify: {
      subject: 'Dein ApeX-Bestätigungscode',
      title: 'Bestätige deine E-Mail-Adresse',
      body: 'Gib diesen Code auf ApeX ein, um dein Konto zu aktivieren.',
    },
    reset: {
      subject: 'Dein ApeX-Code zum Zurücksetzen',
      title: 'Passwort zurücksetzen',
      body: 'Gib diesen Code auf ApeX ein, um ein neues Passwort festzulegen.',
    },
    valid: 'Der Code ist 10 Minuten gültig. Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.',
    yourCode: 'Dein Code',
  },
  en: {
    verify: {
      subject: 'Your ApeX verification code',
      title: 'Confirm your email address',
      body: 'Enter this code on ApeX to activate your account.',
    },
    reset: {
      subject: 'Your ApeX reset code',
      title: 'Reset your password',
      body: 'Enter this code on ApeX to set a new password.',
    },
    valid: 'The code is valid for 10 minutes. If you did not request it, you can ignore this email.',
    yourCode: 'Your code',
  },
};

function html({ title, body, valid }, code) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f2ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f1e1c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;padding:36px 32px">
        <tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:-0.5px">ApeX</td></tr>
        <tr><td style="padding-top:28px;font-size:18px;font-weight:600">${title}</td></tr>
        <tr><td style="padding-top:8px;font-size:15px;line-height:1.5;color:#5c5a55">${body}</td></tr>
        <tr><td style="padding-top:24px">
          <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:32px;letter-spacing:10px;font-weight:600;background:#f4f2ee;border-radius:12px;padding:18px 0;text-align:center">${code}</div>
        </td></tr>
        <tr><td style="padding-top:24px;font-size:13px;line-height:1.5;color:#8a877f">${valid}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function sendCode(email, code, purpose) {
  const L = TEXTS[lang()] ?? (lang() === 'de' ? TEXTS.de : TEXTS.en);
  const t = { ...L[purpose], valid: L.valid, yourCode: L.yourCode };
  if (BREVO_API_KEY) return sendViaBrevoApi(email, code, t);
  if (!transport) {
    // Entwicklungsmodus: kein SMTP eingerichtet → Code in der Konsole anzeigen
    console.log(`\n  ✉  [DEV] ${t.subject} für ${email}: ${code}\n`);
    return;
  }
  await transport.sendMail({
    from: fromHeader(),
    to: email,
    subject: t.subject,
    text: `${t.title}\n\n${t.body}\n\n${t.yourCode}: ${code}\n\n${t.valid}`,
    html: html(t, code),
  });
}

// "ApeX <name@example.com>" → { name: 'ApeX', email: 'name@example.com' }
// Ein alter Anzeigename „VAIs“ (z. B. MAIL_FROM auf Render) wird zu ApeX, die Adresse bleibt.
function brandName(name) {
  const clean = String(name ?? '').replace(/^"|"$/g, '').trim();
  if (!clean || /^vais$/i.test(clean)) return 'ApeX';
  return clean;
}
function parseFrom(from) {
  const m = String(from ?? '').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return { name: 'ApeX', email: String(from ?? '').trim() };
  return { name: brandName(m[1]), email: m[2].trim() };
}
function fromHeader() {
  const { name, email } = parseFrom(FROM);
  return email ? `${name} <${email}>` : name;
}

async function sendViaBrevoApi(email, code, t) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: parseFrom(FROM),
      to: [{ email }],
      subject: t.subject,
      htmlContent: html(t, code),
      textContent: `${t.title}\n\n${t.body}\n\n${t.yourCode}: ${code}\n\n${t.valid}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Brevo-API ${res.status}: ${body.message || body.code || 'unbekannter Fehler'}`);
  }
}
