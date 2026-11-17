// Tagesbudget (Credits): Kosten nach echter Arbeit, Budget, Reset um Mitternacht, Testmodus – und die Tour-Migration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';

const url = `file:${join(mkdtempSync(join(tmpdir(), 'vais-credits-')), 'credits.db')}`;
process.env.DATABASE_URL = url;
process.env.ADMIN_EMAILS = 'boss@example.com';
delete process.env.USER_DAILY_CREDITS;
// Eine „alte“ Datenbank mit einem Nutzer, der schon vor der Tour-Spalte da war
const old = createClient({ url });
await old.execute('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)');
await old.execute({ sql: 'INSERT INTO users (email, password_hash, verified, created_at) VALUES (?, ?, 1, ?)', args: ['alt@example.com', 'x', Date.now()] });
old.close();

const { get, run } = await import('../src/db.js');
const L = await import('../src/limits.js');
const { canAfford } = await import('../src/agent.js');

test('Tour-Migration: bestehende Konten haben sie gesehen, neue Konten nicht', async () => {
  assert.equal(Number((await get('SELECT tour_seen FROM users WHERE email = ?', 'alt@example.com')).tour_seen), 1);
  await run('INSERT INTO users (email, password_hash, verified, created_at) VALUES (?, ?, 1, ?)', 'neu@example.com', 'x', Date.now());
  assert.equal((await get('SELECT tour_seen FROM users WHERE email = ?', 'neu@example.com')).tour_seen, null);
});

test('Kosten: je mehr Arbeit, desto mehr Credits', () => {
  const C = L.defaultCosts();
  assert.equal(L.workCost({ answered: true, calls: 1, chars: 200 }, C), 1); // kurze Antwort
  assert.equal(L.workCost({ answered: true, chars: 5000 }, C), 2); // lange Antwort
  assert.equal(L.workCost({ answered: true, think: true }, C), 2); // „Denken“
  assert.equal(L.workCost({ answered: true, searches: 1 }, C), 3); // + Websuche
  assert.equal(L.workCost({ answered: true, searches: 2, reads: 2 }, C), 6); // mehrere Quellen
  assert.equal(L.workCost({ answered: true, deep: true, searches: 6, reads: 4, calls: 3 }, C), 10); // tiefe Recherche: pauschal
  assert.equal(L.workCost({ answered: true, images: 1 }, C), 5); // Bild
  assert.equal(L.workCost({ answered: false, images: 1 }, C), 5); // nur Bild, kein Text
  assert.equal(L.workCost({ answered: true, heavy: true, calls: 4 }, C), 11);
  assert.equal(L.workCost({ answered: true, sites: 1, rounds: 4, calls: 5 }, C), 1 + 1 + 14 + 1); // Webseite
  assert.equal(L.workCost({ answered: true, sites: 2, images: 2, deep: true, rounds: 9 }, C), 30); // Deckel pro Auftrag
  assert.equal(L.workCost({ answered: false }, C), 0); // nur Emoji / nichts → kostenlos
  assert.equal(L.workCost({ answered: true, searches: 1 }, { ...C, web: 5 }), 6); // Admin kann Preise ändern
});

test('Budget: vorab reservieren, am Ende nach echter Arbeit abrechnen, nie unter 0', async () => {
  const user = { id: 501, email: 'nutzer@example.com' };
  let b = await L.budgetOf(user);
  assert.equal(b.limit, 100);
  assert.equal(b.left, 100);
  const r = await L.reserve(user, 1);
  assert.equal((await L.budgetOf(user)).used, 1);
  assert.equal(await L.settle(user, r, 6), 6); // Websuche + Quellen
  assert.equal((await L.budgetOf(user)).used, 6);
  await L.settle(user, await L.reserve(user, 1), 0); // nur ein Emoji → zurück
  assert.equal((await L.budgetOf(user)).used, 6);
  await L.refund(user, await L.reserve(user, 1)); // Fehler → zurück
  assert.equal((await L.budgetOf(user)).used, 6);
  // fast leer: teure Arbeit wird gedeckelt, Budget geht nicht ins Minus
  await L.saveLimitSettings({ budget: 10 });
  assert.equal(await L.settle(user, await L.reserve(user, 1), 20), 4);
  b = await L.budgetOf(user);
  assert.equal(b.left, 0);
  await assert.rejects(() => L.reserve(user, 1), (err) => err.status === 429 && /Tagesbudget/.test(err.message));
  const u = await L.usageOf(user);
  assert.equal(u.credits.percent, 100);
  assert.equal(u.costs.image, 4);
  await L.saveLimitSettings({ budget: 100 });
});

test('Budget: nicht genug für teure Arbeit → wird gar nicht erst gestartet', async () => {
  const user = { id: 502, email: 'knapp@example.com' };
  await L.saveLimitSettings({ budget: 3 });
  try {
    await assert.rejects(() => L.reserve(user, 5), (err) => err.status === 429 && /mindestens 5/.test(err.message));
    const b = await L.budgetOf(user);
    const costs = await L.costSettings();
    assert.equal(canAfford({ left: b.left, costs }, 'site'), false);
    assert.equal(canAfford({ left: b.left, costs }, 'web'), true);
    assert.equal(canAfford({ left: null, costs }, 'site'), true); // unbegrenzt
  } finally {
    await L.saveLimitSettings({ budget: 100 });
  }
});

test('Bilder: Sicherheits-Grenze pro Tag trotz Credits', async () => {
  const user = { id: 503, email: 'maler@example.com' };
  await L.saveLimitSettings({ image: 1 });
  try {
    await L.reserve(user, 5, { images: 1 });
    await L.countImages(user, 1);
    await assert.rejects(() => L.reserve(user, 5, { images: 1 }), (err) => err.status === 429 && /Bilder/.test(err.message));
  } finally {
    await L.saveLimitSettings({ image: 20 });
  }
});

test('Reset: gestriger Verbrauch zählt heute nicht mehr, Admin kann zurücksetzen', async () => {
  const user = { id: 504, email: 'gestern@example.com' };
  const yesterday = L.dayKey(new Date(Date.now() - 24 * 3600 * 1000));
  await run("INSERT INTO usage_kinds (user_id, day, kind, n) VALUES (?, ?, 'credits', 100)", user.id, yesterday);
  assert.equal((await L.budgetOf(user)).left, 100);
  await L.reserve(user, 30);
  assert.equal((await L.budgetOf(user)).left, 70);
  await L.resetUsage(user.id);
  assert.equal((await L.budgetOf(user)).left, 100);
  assert.ok(L.nextReset() > Date.now());
});

test('Testmodus: Admin an = unbegrenzt, aus = gleiches Budget wie alle', async () => {
  const on = { id: 505, email: 'boss@example.com', test_mode: 1 };
  const off = { ...on, test_mode: 0 };
  await L.saveLimitSettings({ budget: 2 });
  try {
    for (let i = 0; i < 5; i++) await L.settle(on, await L.reserve(on, 1), 10);
    const u = await L.usageOf(on);
    assert.equal(u.unlimited, true);
    assert.equal(u.credits.left, null);
    assert.equal(u.credits.used, 50); // wird trotzdem mitgezählt (Statistik)
    const b = await L.budgetOf(off);
    assert.equal(b.unlimited, false);
    assert.equal(b.left, 0);
    await assert.rejects(() => L.reserve(off, 1), (err) => err.status === 429);
  } finally {
    await L.saveLimitSettings({ budget: 100 });
  }
});

test('Admin: Kosten-Tabelle speichern und prüfen', async () => {
  const saved = await L.saveCostSettings({ web: 3, site: 20 });
  assert.equal(saved.web, 3);
  assert.equal(saved.site, 20);
  assert.equal((await L.costSettings()).answer, 1);
  await assert.rejects(() => L.saveCostSettings({ max: 0 }), (err) => err.status === 400);
  await L.saveCostSettings(L.defaultCosts());
});
