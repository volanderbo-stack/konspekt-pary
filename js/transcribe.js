// Розпізнавання шматка аудіо через OpenAI Audio API (мова — українська).

import { sleep } from './util.js';

export class ApiError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

/** HTTP-відповідь OpenAI → зрозуміла українська помилка */
export async function openaiError(res) {
  let detail = '';
  let code = '';
  try {
    const j = await res.json();
    detail = j.error?.message || '';
    code = j.error?.code || j.error?.type || '';
  } catch { /* тіло не JSON */ }
  if (res.status === 401) return new ApiError('Невірний API-ключ OpenAI. Перевірте його в Налаштуваннях.', { status: 401 });
  if (res.status === 429 && /quota|billing/i.test(code + detail)) {
    return new ApiError('На рахунку OpenAI закінчились кошти або не налаштована оплата.', { status: 429 });
  }
  if (res.status === 429) return new ApiError('Забагато запитів до OpenAI — повторюю трохи пізніше.', { retryable: true, status: 429 });
  if (res.status === 413) return new ApiError('Шматок аудіо завеликий для OpenAI (понад 25 МБ).', { status: 413 });
  if (res.status >= 500) return new ApiError(`Сервер OpenAI тимчасово недоступний (${res.status}).`, { retryable: true, status: res.status });
  return new ApiError(`Помилка OpenAI ${res.status}: ${detail || 'невідома'}`, { status: res.status });
}

/** Повторює запит при збої мережі / 429 / 5xx: 3 спроби з паузою. */
export async function withRetry(fn, { tries = 3, signal, onRetry } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') throw e;
      const network = e instanceof TypeError; // fetch кидає TypeError, коли немає мережі
      if (network) last = new ApiError('Немає зʼєднання з інтернетом.', { retryable: true });
      else last = e;
      if (!last.retryable || i === tries - 1) throw last;
      onRetry?.(last, i + 1);
      await sleep(3000 * (i + 1) ** 2);
    }
  }
  throw last;
}

const EXT = { 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };

/**
 * @returns {Promise<Array<{start:number,end:number,text:string,no_speech_prob?:number,avg_logprob?:number}>|{text:string}>}
 * whisper-1 повертає сегменти з таймкодами; gpt-4o-transcribe — лише текст.
 */
export async function transcribeChunk(blob, { key, model = 'whisper-1', prompt = '', signal, onRetry }) {
  if (!key) throw new ApiError('Додайте API-ключ OpenAI в Налаштуваннях, щоб розпізнавати аудіо.');
  const mime = (blob.type || 'audio/mpeg').split(';')[0];
  const segmentsMode = model === 'whisper-1';

  return withRetry(async () => {
    const fd = new FormData();
    fd.append('file', blob, `chunk.${EXT[mime] || 'mp3'}`);
    fd.append('model', model);
    fd.append('language', 'uk');
    if (prompt) fd.append('prompt', prompt.slice(-600));
    if (segmentsMode) {
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'segment');
    } else {
      fd.append('response_format', 'json');
    }
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal,
    });
    if (!res.ok) throw await openaiError(res);
    const j = await res.json();
    return segmentsMode ? (j.segments || []) : { text: j.text || '' };
  }, { signal, onRetry });
}

/** Орієнтовна вартість: whisper-1 і gpt-4o-transcribe ≈ $0.006/хв (перевіряйте актуальні тарифи). */
export function estimateCost(seconds) {
  return (seconds / 60) * 0.006;
}
