import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestions, isBadSuggestion, extrasPrompt, demoSuggestions, DEMO_SUGGESTIONS } from '../src/followups.js';

test('Bild-Fragen an den Nutzer fliegen raus', () => {
  assert.deepEqual(cleanSuggestions([
    'Welche Kleidung soll er tragen?',
    'Wie soll die Umgebung aussehen?',
    'Möchtest du den Jungen in Aktion sehen?',
  ]), []);
});

test('Fertige Ideen aus Nutzersicht bleiben erhalten', () => {
  assert.deepEqual(cleanSuggestions([
    'Gib ihm einen roten Anzug',
    'Stell ihn in eine verregnete Großstadt',
    'Mach daraus ein Anime-Bild',
  ]), [
    'Gib ihm einen roten Anzug',
    'Stell ihn in eine verregnete Großstadt',
  ]);
  assert.deepEqual(cleanSuggestions([
    'Erklär das einfacher',
    'Gib mir ein Beispiel mit Code',
    'Fasse es in 3 Punkten zusammen',
  ]), [
    'Erklär das einfacher',
    'Gib mir ein Beispiel mit Code',
  ]);
});

test('Fragezeichen und Anrede werden verworfen, Bitten umgeschrieben', () => {
  assert.equal(cleanSuggestions(['Gib ihm einen roten Anzug?'])[0], 'Gib ihm einen roten Anzug');
  assert.deepEqual(cleanSuggestions(['Kannst du das einfacher erklären?']), ['Erklär das einfacher']);
  assert.deepEqual(cleanSuggestions(['Kannst du mir ein Beispiel geben?']), ['Gib mir ein Beispiel']);
  assert.deepEqual(cleanSuggestions(['Könntest du bitte das Bild dunkler machen?']), ['Mach das Bild dunkler']);
  assert.deepEqual(cleanSuggestions(['Would you like to see him in action?']), []);
  assert.deepEqual(cleanSuggestions(['What should he wear?']), []);
  assert.deepEqual(cleanSuggestions(['How should the background look?']), []);
  assert.deepEqual(cleanSuggestions(['Soll ich den Hintergrund ändern?']), []);
  assert.deepEqual(cleanSuggestions(['Willst du mehr Details?']), []);
  assert.ok(isBadSuggestion('Möchtest du den Jungen in Aktion sehen?'));
  assert.ok(isBadSuggestion('Welche Kleidung soll er tragen?'));
  assert.equal(isBadSuggestion('Gib mir ein Beispiel mit Code'), false);
});

test('Mischt saubere Ideen mit Fragen und begrenzt auf zwei kurze Vorschläge', () => {
  assert.deepEqual(cleanSuggestions([
    'Welche Kleidung soll er tragen?',
    'Gib ihm einen roten Anzug',
    '  „Stell ihn in eine verregnete Großstadt“  ',
    'Möchtest du ihn tanzen sehen?',
    'Mach daraus ein Anime-Bild',
    'Ändere das Licht',
  ]), [
    'Gib ihm einen roten Anzug',
    'Stell ihn in eine verregnete Großstadt',
  ]);
  const long = cleanSuggestions(['Gib mir ein ausführliches Beispiel mit TypeScript und Tests dazu bitte wirklich']);
  assert.equal(long.length, 1);
  assert.ok(long[0].split(/\s+/).length <= 8);
  assert.doesNotMatch(long[0], /\b(und|bitte)\s*$/i);
  assert.deepEqual(cleanSuggestions(['Gib mir ein Beispiel', 'gib mir ein Beispiel', '']), ['Gib mir ein Beispiel']);
  assert.deepEqual(cleanSuggestions(null), []);
  assert.deepEqual(cleanSuggestions(['OK', 'Weiter']), []);
});

test('Demo-Vorschläge sind bereits fertige Aufforderungen', () => {
  for (const pack of [DEMO_SUGGESTIONS.image, DEMO_SUGGESTIONS.text]) {
    for (const list of [pack.de, pack.en]) {
      assert.deepEqual(cleanSuggestions(list), list);
      for (const s of list) {
        assert.doesNotMatch(s, /[?？]/);
        assert.ok(s.split(/\s+/).length <= 8);
      }
    }
  }
  assert.equal(demoSuggestions(true), DEMO_SUGGESTIONS.image);
  assert.equal(demoSuggestions(false), DEMO_SUGGESTIONS.text);
});

test('Prompt verlangt fertige Ideen auf Deutsch und nennt ApeX, keine Modelle', () => {
  const image = extrasPrompt({
    imageMode: true, wantTitle: true, firstTurn: true, currentTitle: '',
    question: 'Ein junger Mann im Anzug', answer: '[Bild]',
  });
  const text = extrasPrompt({
    imageMode: false, wantTitle: false, firstTurn: false, currentTitle: 'Thema',
    question: 'Was ist Recursion?', answer: 'Recursion ist …',
  });
  for (const p of [image, text]) {
    assert.match(p, /ApeX/);
    assert.match(p, /fertig/i);
    assert.match(p, /Fragezeichen/);
    assert.match(p, /Deutsch/);
    assert.doesNotMatch(p, /Folgefragen/);
    assert.doesNotMatch(p, /\b(gpt|claude|grok|gemini|llama)\b/i);
  }
  assert.match(image, /roten Anzug/);
  assert.match(text, /Erklär das einfacher/);
  assert.match(text, /"title": leer lassen/);
  assert.match(image, /Ein junger Mann im Anzug/);
});
