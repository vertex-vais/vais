// Betreiber-Angaben (Impressum) und Admins – per Umgebungsvariablen änderbar
export const OWNER = {
  name: process.env.OWNER_NAME?.trim() || 'Leeam Thiemann',
  email: process.env.OWNER_EMAIL?.trim() || 'leeam.thiemann18@gmail.com',
  address: process.env.IMPRESSUM_ADDRESS?.trim() || '', // z. B. "Musterstraße 1, 12345 Musterstadt"
};

// Admins: Konten mit diesen E-Mail-Adressen (durch Komma getrennt)
export const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || OWNER.email)
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export const isAdmin = (user) => !!user && ADMIN_EMAILS.includes(String(user.email).toLowerCase());

// Moderatoren: vom Admin ernannt (Spalte users.role = 'mod')
export const isMod = (user) => !!user && user.role === 'mod' && !isAdmin(user);
export const isStaff = (user) => isAdmin(user) || isMod(user);
// Testmodus (pro Konto, Spalte users.test_mode, Standard: aus). Nur Admins und Mods können ihn einschalten.
// Aus: man erlebt ApeX genau wie ein normaler Nutzer (nur ApeX, gleiche Limits) – nur der Admin-Bereich bleibt offen.
// An: Test-Module (Battle, Direkt …) und Modell-Bestenliste; Admins zusätzlich ohne Tages-/Rate-Limits.
//     Mods behalten im Testmodus ihr normales (ggf. vom Admin gesetztes) Tageslimit – unbegrenzt nur für Admins.
export const inTestMode = (user) => isStaff(user) && Number(user?.test_mode) === 1;
export const isUnlimited = (user) => isAdmin(user) && Number(user?.test_mode) === 1;
