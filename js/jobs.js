// Фонові задачі: обробка аудіо (витяг звуку → розпізнавання) і створення конспекту.
// Кожен готовий шматок одразу пишеться в IndexedDB, тому після закриття вкладки
// обробка продовжується з першого незробленого шматка.

import {
  getLecture, updateLecture, getChunk, putChunk, getChunks, getSettings,
} from './db.js';
import { transcribeChunk, ApiError } from './transcribe.js';
import { getFFmpeg, resetFFmpeg, mountFile, unmountFile, extractChunk } from './ffmpeg.js';
import { cleanSegments, segmentsToParagraphs, textToApproxSegments } from './parsers.js';
import { generateSummary } from './summary.js';
import { keepAwake } from './util.js';

export const bus = new EventTarget();
const running = new Map(); // id → AbortController
const progress = new Map(); // id → останній стан для інтерфейсу

export const isRunning = (id) => running.has(id);
export const progressOf = (id) => progress.get(id);
export const anyRunning = () => running.size > 0;

function emit(id, data) {
  if (data) progress.set(id, data); else progress.delete(id);
  bus.dispatchEvent(new CustomEvent('progress', { detail: { id, ...(data || {}) } }));
}
const changed = (id) => bus.dispatchEvent(new CustomEvent('changed', { detail: { id } }));

export function pauseJob(id) {
  running.get(id)?.abort();
}

/** Переносить позначки зі старих абзаців у нові за таймкодом (коли абзаци перебудовуються). */
function keepTags(oldP = [], newP) {
  const byT = new Map(oldP.filter((p) => p.tags?.length).map((p) => [p.t, p.tags]));
  return newP.map((p) => ({ ...p, tags: byT.get(p.t) || [] }));
}

async function rebuildParagraphs(id) {
  const chunks = await getChunks(id);
  const segs = [];
  for (const c of chunks) { if (!c.done) break; segs.push(...(c.segments || [])); }
  const paragraphs = segmentsToParagraphs(cleanSegments(segs));
  await updateLecture(id, (l) => { l.paragraphs = keepTags(l.paragraphs, paragraphs); });
}

/** Обробка аудіо/відео або диктофонного запису. file потрібен, лише якщо ще є невитягнуті шматки. */
export async function startAudioJob(id, file = null) {
  if (running.has(id)) return;
  const ctrl = new AbortController();
  running.set(id, ctrl);
  const { signal } = ctrl;
  const release = keepAwake();
  let ff = null;
  try {
    const settings = await getSettings();
    const lec = await getLecture(id);
    const total = lec.chunkCount;
    const chunkSec = lec.chunkSec || 600;
    await updateLecture(id, (l) => { l.status = 'processing'; l.error = ''; });
    changed(id);

    const missing = [];
    for (let i = 0; i < total; i++) if (!(await getChunk(id, i))) missing.push(i);
    let path = null;
    if (missing.length) {
      if (!file) {
        await updateLecture(id, (l) => { l.status = 'needs-file'; });
        return;
      }
      if (lec.sourceFile && file.size !== lec.sourceFile.size) {
        throw new ApiError(`Це інший файл. Потрібен «${lec.sourceFile.name}».`);
      }
      emit(id, { done: total - missing.length, total, text: 'Запускаю обробку відео (≈30 МБ, лише перший раз)…' });
      ff = await getFFmpeg();
      path = await mountFile(ff, file);
    }
    if (lec.transcribe && !settings.openaiKey) {
      throw new ApiError('Додайте API-ключ OpenAI в Налаштуваннях, щоб розпізнати аудіо.');
    }

    let doneCount = (await getChunks(id)).filter((c) => (lec.transcribe ? c.done : true)).length;
    const started = performance.now();
    let processedNow = 0;
    const eta = () => {
      if (!processedNow) return '';
      const per = (performance.now() - started) / processedNow;
      const min = Math.ceil((per * (total - doneCount)) / 60000);
      return min > 0 ? ` · ~${min} хв залишилось` : '';
    };
    const report = (i, stage, pct) => {
      const p = pct != null ? ` ${Math.round(pct * 100)}%` : '';
      emit(id, { done: doneCount, total, text: `Шматок ${i + 1} з ${total} · ${stage}${p}${eta()}` });
    };
    const finishChunk = async () => {
      doneCount++;
      processedNow++;
      await updateLecture(id, (l) => { l.progress = { done: doneCount, total }; });
    };

    const transcribeAndSave = async (chunk) => {
      report(chunk.index, 'розпізнаю текст');
      const prev = chunk.index > 0 ? await getChunk(id, chunk.index - 1) : null;
      const prompt = prev?.segments?.map((s) => s.text).join(' ').slice(-300)
        || [lec.subject, lec.title].filter(Boolean).join('. ');
      const res = await transcribeChunk(chunk.blob, {
        key: settings.openaiKey,
        model: settings.sttModel,
        prompt,
        signal,
        onRetry: (e, n) => emit(id, { done: doneCount, total, text: `${e.message} Повтор ${n} з 3…` }),
      });
      chunk.segments = Array.isArray(res)
        ? res.map((s) => ({
          start: s.start + chunk.start, end: s.end + chunk.start, text: s.text,
          no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob,
        }))
        : textToApproxSegments(res.text, chunk.start, chunk.duration);
      chunk.done = true;
      await putChunk(chunk);
      await finishChunk();
      await rebuildParagraphs(id);
      changed(id);
    };

    // Конвеєр: поки розпізнається шматок i-1 (мережа), витягуємо звук шматка i (процесор).
    let pending = null;
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('Пауза', 'AbortError');
      let chunk = await getChunk(id, i);
      if (!chunk) {
        const start = i * chunkSec;
        const dur = Math.min(chunkSec, lec.duration - start);
        report(i, 'витягую звук', 0);
        const blob = await extractChunk(ff, path, start, dur, (pct) => report(i, 'витягую звук', pct));
        if (blob.size < 2000 && i === 0) throw new ApiError('У файлі не знайдено звукової доріжки.');
        chunk = { lectureId: id, index: i, start, duration: dur, blob, mime: 'audio/mpeg', done: false };
        await putChunk(chunk);
        await updateLecture(id, (l) => { l.hasAudio = true; });
        if (!lec.transcribe) await finishChunk();
      }
      if (pending) await pending;
      pending = lec.transcribe && !chunk.done ? transcribeAndSave(chunk) : null;
      pending?.catch(() => {}); // помилку обробимо на наступному await, без «Uncaught in promise»
    }
    if (pending) await pending;
    if (lec.transcribe) await rebuildParagraphs(id);
    await updateLecture(id, (l) => { l.status = 'ready'; l.progress = null; l.error = ''; });
  } catch (e) {
    const aborted = e.name === 'AbortError' || signal.aborted;
    if (!aborted) console.error(e);
    if (!aborted && !(e instanceof ApiError)) resetFFmpeg();
    await updateLecture(id, (l) => {
      l.status = aborted ? 'paused' : 'error';
      l.error = aborted ? '' : (e.message || String(e));
    });
  } finally {
    if (ff) await unmountFile(ff);
    release();
    running.delete(id);
    emit(id, null);
    changed(id);
  }
}

export async function startSummaryJob(id) {
  if (running.has(id)) return;
  const ctrl = new AbortController();
  running.set(id, ctrl);
  try {
    const [lec, settings] = await Promise.all([getLecture(id), getSettings()]);
    emit(id, { kind: 'summary', text: 'Готую конспект…' });
    const md = await generateSummary(lec, settings, {
      signal: ctrl.signal,
      onProgress: (text) => emit(id, { kind: 'summary', text }),
    });
    await updateLecture(id, (l) => { l.summary = md; l.summaryAt = Date.now(); l.summaryError = ''; });
  } catch (e) {
    console.error(e);
    if (e.name !== 'AbortError') await updateLecture(id, (l) => { l.summaryError = e.message || String(e); });
  } finally {
    running.delete(id);
    emit(id, null);
    changed(id);
  }
}
