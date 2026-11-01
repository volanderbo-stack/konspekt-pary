// Розбір транскрипцій Teams (.vtt, .docx), вставленого тексту і сегментів Whisper.
// Чисті функції без DOM — їх перевіряють тести в tests/.

import { parseTime } from './util.js';

const TIMING = /^\s*(\d{1,3}:\d{1,2}(?::\d{1,2})?(?:[.,]\d+)?)\s*-->\s*(\d{1,3}:\d{1,2}(?::\d{1,2})?(?:[.,]\d+)?)/;
// "Іван Петренко   1:02:03" або "Іван Петренко 0:03" — заголовок репліки в новому .docx Teams
const SPEAKER_TIME = /^(.{1,80}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
// Службові рядки Teams: «почав(ла) транскрибування», «started transcription» тощо
const SERVICE = /(start|stopp)ed transcription|transcription (started|stopped)|(поча|розпоча|зупини|припини)\S*\s+(транскри|запис)|^transcript$|^транскрипція$|^webvtt/i;

function cleanText(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyName(line) {
  const words = line.trim().split(/\s+/);
  return line.length <= 60 && words.length <= 6 && !/[.!?…,:;]$/.test(line.trim()) && !/\d{1,2}:\d{2}/.test(line);
}

/** Склеює короткі репліки одного мовця в абзаци. cue: {t, end?, speaker, text} */
export function mergeCues(cues, { maxGap = 6, maxLen = 700 } = {}) {
  const out = [];
  for (const c of cues) {
    if (!c.text) continue;
    const prev = out[out.length - 1];
    const gap = prev && c.t != null && prev.end != null ? c.t - prev.end : 0;
    if (prev && prev.speaker === c.speaker && gap <= maxGap && prev.text.length + c.text.length < maxLen) {
      prev.text += ` ${c.text}`;
      prev.end = c.end ?? c.t ?? prev.end;
    } else {
      out.push({ t: c.t ?? null, end: c.end ?? c.t ?? null, speaker: c.speaker || '', text: c.text });
    }
  }
  return out.map((p, i) => ({ id: `p${i}`, t: p.t, speaker: p.speaker, text: p.text, tags: [] }));
}

export function lastTime(paragraphs) {
  for (let i = paragraphs.length - 1; i >= 0; i--) if (paragraphs[i].t != null) return paragraphs[i].t;
  return 0;
}

/** WEBVTT від Teams: ідентифікатори cue, теги <v Ім'я>, таймкоди 00:00:01.234 */
export function parseVtt(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TIMING);
    if (!m) continue;
    const body = [];
    while (i + 1 < lines.length && lines[i + 1].trim() !== '') body.push(lines[++i]);
    const raw = body.join(' ');
    const v = raw.match(/<v(?:\.[^\s>]+)?\s+([^>]+)>/);
    let speaker = v ? v[1].trim() : '';
    let content = cleanText(raw);
    if (!speaker) {
      const colon = content.match(/^([^:]{2,40}):\s+(.+)$/);
      if (colon && isLikelyName(colon[1])) { speaker = colon[1]; content = colon[2]; }
    }
    if (!content || SERVICE.test(content)) continue;
    cues.push({ t: parseTime(m[1]), end: parseTime(m[2]), speaker, text: content });
  }
  return mergeCues(cues);
}

/** Рядки тексту (з .docx або вставлені) у форматах Teams. Повертає [] якщо формат не впізнано. */
export function parseTeamsLines(lines) {
  lines = lines.map((l) => l.replace(/ /g, ' ').replace(/\t/g, '   ').trim());

  // Старий формат: "0:0:0.0 --> 0:0:5.680" / "Ім'я" / текст
  if (lines.some((l) => TIMING.test(l))) {
    const cues = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(TIMING);
      if (!m) continue;
      const body = [];
      while (i + 1 < lines.length && lines[i + 1] && !TIMING.test(lines[i + 1])) body.push(lines[++i]);
      let speaker = '';
      if (body.length >= 2 && isLikelyName(body[0])) speaker = body.shift();
      const content = cleanText(body.join(' '));
      if (content && !SERVICE.test(content)) cues.push({ t: parseTime(m[1]), end: parseTime(m[2]), speaker, text: content });
    }
    return mergeCues(cues);
  }

  // Новий формат: "Ім'я Прізвище   12:34" / текст репліки
  const heads = [];
  lines.forEach((l, i) => {
    const m = l.match(SPEAKER_TIME);
    if (m && isLikelyName(m[1]) && lines[i + 1] !== undefined) heads.push({ i, speaker: m[1].trim(), t: parseTime(m[2]) });
  });
  // Справжній мовець — імʼя з великих літер або трапляється кілька разів, а час не йде назад.
  // Так відсіюємо фрази на кшталт «зустрінемось о 10:30».
  const counts = {};
  heads.forEach((h) => { counts[h.speaker] = (counts[h.speaker] || 0) + 1; });
  const properName = (n) => n.split(/\s+/).every((w) => /^[\p{Lu}(]/u.test(w));
  const real = [];
  for (const h of heads) {
    const prevT = real.length ? real[real.length - 1].t : 0;
    if ((counts[h.speaker] >= 2 || properName(h.speaker)) && h.t >= prevT - 1) real.push(h);
  }
  if (!real.length) return [];

  const cues = [];
  real.forEach((h, k) => {
    const endIdx = k + 1 < real.length ? real[k + 1].i : lines.length;
    const content = cleanText(lines.slice(h.i + 1, endIdx).filter((l) => !SERVICE.test(l)).join(' '));
    if (content) cues.push({ t: h.t, end: k + 1 < real.length ? real[k + 1].t : h.t, speaker: h.speaker, text: content });
  });
  return mergeCues(cues);
}

/** document.xml із .docx → масив рядків (абзаців). Без DOMParser, щоб працювало і в Node. */
export function docxXmlToLines(xml) {
  const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
  return xml.split(/<\/w:p>/).map((p) => {
    let line = '';
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g;
    let m;
    while ((m = re.exec(p))) line += m[1] !== undefined ? decode(m[1]) : (m[0] === '<w:tab/>' ? '\t' : ' ');
    return line;
  }).filter((l) => l.trim() !== '');
}

export function parseDocxXml(xml) {
  const lines = docxXmlToLines(xml);
  const parsed = parseTeamsLines(lines);
  return parsed.length ? parsed : plainParagraphs(lines.join('\n'));
}

/** Текст без таймкодів → абзаци (по порожніх рядках, довгі — по реченнях). */
export function plainParagraphs(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n|\n(?=\S)/).map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (const b of blocks) {
    if (b.length <= 900) { out.push(b); continue; }
    let cur = '';
    for (const s of b.split(/(?<=[.!?…])\s+/)) {
      if (cur && cur.length + s.length > 600) { out.push(cur); cur = ''; }
      cur += (cur ? ' ' : '') + s;
    }
    if (cur) out.push(cur);
  }
  return out.filter((t) => !SERVICE.test(t)).map((text, i) => ({ id: `p${i}`, t: null, speaker: '', text, tags: [] }));
}

/** Вставлений текст: пробуємо формати Teams/VTT, інакше — звичайні абзаци. */
export function parsePastedText(text) {
  if (/^\s*WEBVTT/.test(text)) return parseVtt(text);
  const teams = parseTeamsLines(text.replace(/\r/g, '').split('\n').filter((l) => l.trim()));
  return teams.length ? teams : plainParagraphs(text);
}

// Типові «галюцинації» Whisper на тиші й музиці
const HALLUCINATIONS = [
  /субтитр/i, /дякую за перегляд/i, /дякуємо за перегляд/i, /підписуйтесь на (наш )?канал/i,
  /ставте лайк/i, /продовження (в|у) наступній/i, /amara\.org/i, /редактор субтитрів/i,
];

/** Відкидає сміттєві сегменти й зациклені повтори. seg: {start, end, text, no_speech_prob?, avg_logprob?} */
export function cleanSegments(segments) {
  const out = [];
  let repeat = 0;
  for (const s of segments) {
    const text = (s.text || '').trim();
    if (!text) continue;
    if (s.no_speech_prob > 0.6 && s.avg_logprob < -1) continue;
    if (HALLUCINATIONS.some((re) => re.test(text)) && text.length < 90) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === text) { if (++repeat >= 2) continue; } else repeat = 0;
    out.push({ start: s.start, end: s.end, text });
  }
  return out;
}

/** Сегменти з абсолютними таймкодами → абзаци по паузах або кожні ~хвилину. */
export function segmentsToParagraphs(segments, { pause = 2, maxLen = 550, maxSpan = 75 } = {}) {
  const out = [];
  let cur = null;
  for (const s of segments) {
    const startNew = !cur
      || s.start - cur.end > pause
      || cur.text.length + s.text.length > maxLen
      || s.start - cur.t > maxSpan;
    if (startNew) {
      if (cur) out.push(cur);
      cur = { t: s.start, end: s.end, text: s.text };
    } else {
      cur.text += ` ${s.text}`;
      cur.end = s.end;
    }
  }
  if (cur) out.push(cur);
  return out.map((p, i) => ({ id: `p${i}`, t: p.t, speaker: '', text: p.text, tags: [] }));
}

/** Текст без сегментів (gpt-4o-transcribe) → псевдосегменти з приблизним часом за довжиною тексту. */
export function textToApproxSegments(text, start, duration) {
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
  let pos = 0;
  return sentences.map((s) => {
    const seg = { start: start + (pos / total) * duration, end: start + ((pos + s.length) / total) * duration, text: s };
    pos += s.length;
    return seg;
  });
}
