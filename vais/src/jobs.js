// Bau-Aufträge, die den Chat nicht blockieren. Das Ergebnis wird später als Nachricht gespeichert.
import { randomBytes } from 'node:crypto';

const jobs = new Map();

function view(job) {
  return {
    id: job.id,
    chatId: job.chatId,
    turn: job.turn,
    title: job.title,
    status: job.status,
    detail: job.detail || '',
    engine: job.engine || '',
    url: job.url || '',
    note: job.note || '',
    startedAt: job.startedAt,
    text: job.status === 'done' ? job.text : undefined,
    error: job.status === 'error' ? job.error : undefined,
  };
}

export function jobsFor(userId, chatId) {
  return [...jobs.values()]
    .filter((job) => job.userId === userId && (!chatId || job.chatId === chatId))
    .map(view);
}

export function launchJob({ userId, chatId, turn, title, run, onDone }) {
  const job = {
    id: randomBytes(6).toString('hex'),
    userId,
    chatId,
    turn,
    title: String(title || 'Auftrag').slice(0, 80),
    status: 'running',
    detail: 'Startet …',
    engine: 'builder',
    url: '',
    note: '',
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  const report = {
    signal: new AbortController().signal,
    step(step) { if (step?.text) job.detail = String(step.text).slice(0, 140); },
    engine(name, extra = {}) { job.engine = name; if (extra.url) job.url = extra.url; if (extra.note) job.note = extra.note; },
  };
  Promise.resolve()
    .then(() => run(report))
    .then(async (result) => {
      job.status = 'done';
      job.detail = 'Fertig';
      job.engine = result?.viaAgent ? 'cursor' : 'builder';
      job.url = result?.agentId ? `https://cursor.com/agents/${result.agentId}` : '';
      job.note = result?.cursorNote || '';
      const text = String(result?.text || '').trim();
      const html = String(result?.html || '');
      job.text = html && /<\/html>/i.test(html) ? `${text}\n\n\`\`\`html\n${html.trim()}\n\`\`\`` : text;
      await onDone?.(job);
    })
    .catch(async (err) => {
      job.status = 'error';
      job.error = String(err?.message || 'Fehler').slice(0, 240);
      job.detail = job.error;
      job.text = job.error;
      await onDone?.(job);
    });
  return view(job);
}
