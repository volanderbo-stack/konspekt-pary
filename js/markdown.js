// Конспект зберігається як Markdown: його легко редагувати вручну й експортувати.

import { esc, parseTime } from './util.js';

const TC = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_(.+?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(TC, (m, tc) => {
      const t = parseTime(tc);
      return t == null ? m : `<button class="tc" data-t="${Math.floor(t)}">${tc}</button>`;
    });
}

/** Мінімальний Markdown → HTML: заголовки, списки, жирний, курсив, таймкоди. Увесь текст екранується. */
export function renderMarkdown(md) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { close(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      close();
      const lvl = m[1].length + 1; // # → h2, бо h1 — заголовок сторінки
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('\n');
}

const tc = (t) => (t && /\d:\d{2}/.test(t) ? ` [${t.replace(/^\[|\]$/g, '')}]` : '');

/** JSON-відповідь моделі → Markdown конспекту. */
export function summaryToMarkdown(s, { subject, title, myName }) {
  const L = [];
  L.push(`# Конспект: ${[subject, title].filter(Boolean).join(' — ') || 'пара'}`, '');
  L.push('## Короткий зміст');
  (s.summary || []).forEach((x, i) => L.push(`${i + 1}. ${x}`));
  L.push('');
  if (s.terms?.length) {
    L.push('## Ключові терміни');
    s.terms.forEach((x) => L.push(`- **${x.term}** — ${x.definition}`));
    L.push('');
  }
  L.push('## Що задали і дедлайни');
  if (s.homework?.length) {
    s.homework.forEach((x) => L.push(`- ${x.task}${x.deadline ? ` — **${x.deadline}**` : ''}${tc(x.time)}`));
  } else L.push('- Домашнього завдання в записі не знайдено.');
  L.push('');
  L.push('## Питання до студентів');
  if (s.questions?.length) {
    s.questions.forEach((x) => L.push(`- ${tc(x.time).trim()} ${x.question}${x.to_whom ? ` _(кому: ${x.to_whom})_` : ''}`.replace(/^- \s+/, '- ')));
  } else L.push('- Питань до студентів не знайдено.');
  if (myName) {
    L.push('', `## Згадки про мене (${myName})`);
    if (s.mentions?.length) s.mentions.forEach((x) => L.push(`- ${tc(x.time).trim()} ${x.context}`.replace(/^- \s+/, '- ')));
    else L.push('- Вас не згадували.');
  }
  return L.join('\n');
}

/** Markdown → простий текст для .txt */
export function markdownToText(md) {
  return String(md || '')
    .replace(/^#{1,3}\s+(.*)$/gm, (_, h) => `${h.toUpperCase()}`)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)_(.+?)_/g, '$1$2')
    .replace(/^\s*[-*]\s+/gm, '• ');
}
