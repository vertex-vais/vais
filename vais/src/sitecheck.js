// Handy-Prüfung für gebaute Seiten: findet typische Ursachen für waagerechtes Scrollen und
// abgeschnittene Navigationen (feste Breiten, nicht umbrechende Menüs, fehlende @media-Regeln).
// Rein statisch (kein Browser) – schnell, und die Liste geht als Auftrag an die Überarbeitung.

const cssOf = (html) => [...String(html ?? '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

// Regeln außerhalb von @media (grob: @media-Blöcke herausnehmen)
function stripMedia(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    i = j;
  }
  return out;
}

// Gibt es eine @media-Regel, die genau dieses Menü auf dem Handy umbaut (ausblenden, untereinander, scrollen, umbrechen)?
function mediaBlocks(css) {
  const out = [];
  let i = 0;
  while ((i = css.indexOf('@media', i)) !== -1) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    out.push(css.slice(open + 1, j - 1));
    i = j;
  }
  return out;
}
function navHandledOnMobile(nav, css) {
  const classes = [...new Set([...nav.matchAll(/\bclass=["']([^"']+)["']/gi)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean))];
  const ids = [...nav.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targets = [/(^|[\s,>+~])(nav|header)(?![\w-])/i, ...classes.map((c) => new RegExp(`\\.${esc(c)}(?![\\w-])`)), ...ids.map((d) => new RegExp(`#${esc(d)}(?![\\w-])`))];
  return mediaBlocks(css).some((block) => [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(([, sel, body]) => targets.some((re) => re.test(sel))
    && /(display\s*:\s*none|flex-direction\s*:\s*column|overflow-x\s*:\s*(auto|scroll)|flex-wrap\s*:\s*wrap)/i.test(body)));
}

export function mobileProblemsCss(css, { scope = '' } = {}) {
  const problems = [];
  const plain = stripMedia(String(css ?? ''));
  const where = scope ? ` (${scope})` : '';
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().slice(0, 60);
    const body = m[2];
    const w = body.match(/(?:^|;|\s)(min-)?width\s*:\s*(\d{3,4})px/i);
    if (w && Number(w[2]) > 380 && !/max-width/i.test(body) && !(w[1] && /\btable\b|\bpre\b/i.test(sel))) problems.push(`„${sel}“ hat eine feste ${w[1] ? 'Mindest-' : ''}Breite von ${w[2]}px${where} – auf dem Handy entsteht waagerechtes Scrollen. Nutze max-width/% oder eine @media-Regel.`);
    if (/width\s*:\s*100vw/i.test(body)) problems.push(`„${sel}“ nutzt width:100vw${where} – das erzeugt auf dem Handy oft eine waagerechte Scrollleiste. Nutze width:100%.`);
    const cols = body.match(/grid-template-columns\s*:\s*repeat\(\s*(\d+)\s*,\s*(\d{3,4})px/i);
    if (cols && Number(cols[1]) >= 2 && Number(cols[2]) * Number(cols[1]) > 380) problems.push(`„${sel}“ hat ein starres Raster (${cols[1]} × ${cols[2]}px)${where}. Nutze repeat(auto-fit, minmax(…, 1fr)) oder einspaltig auf dem Handy.`);
    if (/white-space\s*:\s*nowrap/i.test(body) && /(nav|menu|menü|links|tabs)/i.test(sel) && !/overflow(-x)?\s*:\s*(auto|scroll|hidden)/i.test(body)) problems.push(`„${sel}“ bricht nicht um (white-space:nowrap)${where} – das Menü läuft auf dem Handy über den Rand. Auf dem Handy umbrechen, scrollen lassen oder ins Menü-Panel packen.`);
  }
  return problems;
}

// Ganze Seite prüfen. Gibt eine Liste von Problemen (Deutsch) zurück.
export function mobileProblems(html) {
  const src = String(html ?? '');
  const problems = [];
  if (!/<meta[^>]+name=["']?viewport/i.test(src)) problems.push('Es fehlt <meta name="viewport" content="width=device-width, initial-scale=1">.');
  const css = cssOf(src);
  if (css && !/@media/i.test(css) && !/(auto-fit|auto-fill|clamp\(|flex-wrap\s*:\s*wrap)/i.test(css)) problems.push('Kein einziges @media-Breakpoint und keine flexiblen Raster – die Seite passt sich dem Handy nicht an.');
  const nav = src.match(/<(header|nav)\b[\s\S]*?<\/\1>/i)?.[0] ?? '';
  const links = (nav.match(/<a\b/gi) ?? []).length;
  if (links >= 5 && !/data-nav-toggle|aria-expanded|menu-toggle|burger|hamburger|nav-toggle|menu-btn|menuButton|<details/i.test(nav) && !navHandledOnMobile(nav, css)) {
    problems.push(`Die Navigation hat ${links} Links, aber keinen Menü-Knopf und keine Handy-Regel – sie läuft auf dem Handy waagerecht über den Rand. Baue ein ausklappbares Handy-Menü (data-nav-toggle / data-nav).`);
  }
  problems.push(...mobileProblemsCss(css).slice(0, 8));
  if (/<table\b/i.test(src) && !/overflow-x\s*:\s*auto/i.test(css)) problems.push('Tabellen ohne Scroll-Rahmen (overflow-x:auto) sprengen auf dem Handy die Breite.');
  return [...new Set(problems)];
}
