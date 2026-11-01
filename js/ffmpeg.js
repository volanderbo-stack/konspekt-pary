// ffmpeg.wasm у Web Worker. Файл монтується через WORKERFS — читається шматками з диска,
// а не копіюється в пам'ять цілком (важливо для 2-годинного відео на телефоні).

import { ApiError } from './transcribe.js';
import { parseTime } from './util.js';

let instance;
let loading;
let logListener = null;

export async function getFFmpeg() {
  if (instance) return instance;
  loading ??= (async () => {
    const { FFmpeg } = await import('../vendor/ffmpeg/index.js');
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => logListener?.(message));
    const base = new URL('../vendor/ffmpeg-core/', import.meta.url).href;
    await ff.load({ coreURL: `${base}ffmpeg-core.js`, wasmURL: `${base}ffmpeg-core.wasm` });
    instance = ff;
    return ff;
  })().catch((e) => {
    loading = null;
    console.error(e);
    throw new ApiError('Не вдалося запустити обробку відео на цьому пристрої (ймовірно, замало пам\'яті). Обробіть цей файл на ноутбуці.');
  });
  return loading;
}

/** Після збою (наприклад, нестача пам'яті) worker треба перезапустити. */
export function resetFFmpeg() {
  try { instance?.terminate(); } catch { /* вже зупинено */ }
  instance = null;
  loading = null;
}

export async function mountFile(ff, file) {
  try { await ff.createDir('/in'); } catch { /* вже існує */ }
  try { await ff.unmount('/in'); } catch { /* не змонтовано */ }
  await ff.mount('WORKERFS', { files: [file] }, '/in');
  return `/in/${file.name}`;
}

export async function unmountFile(ff) {
  try { await ff.unmount('/in'); } catch { /* не змонтовано */ }
}

/** Тривалість через ffmpeg, якщо браузер не зміг прочитати метадані. */
export async function probeWithFFmpeg(file) {
  const ff = await getFFmpeg();
  const path = await mountFile(ff, file);
  let duration = null;
  logListener = (msg) => {
    const m = msg.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
    if (m) duration = parseTime(m[1]);
  };
  try { await ff.exec(['-hide_banner', '-i', path]); } catch { /* exec без виходу завжди «падає» */ }
  logListener = null;
  await unmountFile(ff);
  return duration;
}

/**
 * Вирізає [start, start+dur) і стискає в mono 16 kHz MP3 32 kbps (~2,4 МБ на 10 хв — під ліміт 25 МБ).
 * onProgress(0..1) — за логом ffmpeg.
 */
export async function extractChunk(ff, path, start, dur, onProgress) {
  const out = `/chunk_${Date.now()}.mp3`;
  logListener = (msg) => {
    const m = msg.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/);
    if (m) onProgress?.(Math.min(1, parseTime(m[1]) / dur));
  };
  try {
    const code = await ff.exec([
      '-hide_banner', '-nostdin',
      '-ss', String(start), '-t', String(dur), '-i', path,
      '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '32k', out,
    ]);
    let data;
    try { data = await ff.readFile(out); } catch { data = null; }
    if (code !== 0 && !data?.length) throw new ApiError('ffmpeg не зміг прочитати цей файл. Можливо, у ньому немає звуку або формат не підтримується.');
    try { await ff.deleteFile(out); } catch { /* вже видалено */ }
    return new Blob([data], { type: 'audio/mpeg' });
  } finally {
    logListener = null;
  }
}
