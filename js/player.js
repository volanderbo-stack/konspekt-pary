// Плеєр по шматках аудіо з IndexedDB: тап по таймкоду → відтворення з цього місця.
// Між шматками перемикається автоматично.

import { getChunk, getChunkMeta } from './db.js';
import { fmtTime, $ } from './util.js';

const audio = new Audio();
audio.preload = 'auto';
let lectureId = null;
let chunks = [];
let current = -1;
let url = null;
let onTime = null;

const bar = () => $('#player');

async function load(index, offset) {
  const c = await getChunk(lectureId, index);
  if (!c?.blob) return false;
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(c.blob);
  current = index;
  audio.src = url;
  await new Promise((r) => { audio.onloadedmetadata = r; audio.onerror = r; });
  audio.currentTime = Math.max(0, offset);
  return true;
}

function absTime() {
  const c = chunks[current];
  return c ? c.start + audio.currentTime : 0;
}

function render() {
  const el = bar();
  if (!el) return;
  el.hidden = !lectureId || current < 0;
  $('#player-time', el).textContent = fmtTime(absTime());
  $('#player-toggle', el).textContent = audio.paused ? '▶' : '❚❚';
  $('#player-toggle', el).setAttribute('aria-label', audio.paused ? 'Відтворити' : 'Пауза');
}

audio.addEventListener('timeupdate', () => { render(); onTime?.(absTime()); });
audio.addEventListener('play', render);
audio.addEventListener('pause', render);
audio.addEventListener('ended', async () => {
  if (current + 1 < chunks.length && (await load(current + 1, 0))) audio.play();
  else render();
});

export async function attach(id, timeCallback) {
  if (lectureId !== id) stop();
  lectureId = id;
  onTime = timeCallback;
  chunks = await getChunkMeta(id);
  return chunks.length > 0;
}

export async function playAt(t) {
  if (!chunks.length) chunks = await getChunkMeta(lectureId);
  if (!chunks.length) return false;
  let i = chunks.findIndex((c) => t >= c.start && t < c.start + c.duration);
  if (i < 0) i = t < chunks[0].start ? 0 : chunks.length - 1;
  const offset = Math.max(0, t - chunks[i].start - 1); // на секунду раніше, щоб почути початок фрази
  const ok = i === current ? ((audio.currentTime = offset), true) : await load(i, offset);
  if (ok) await audio.play().catch(() => {});
  render();
  return ok;
}

export function toggle() {
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

export function skip(sec) {
  playAt(Math.max(0, absTime() + sec));
}

export function stop() {
  audio.pause();
  if (url) URL.revokeObjectURL(url);
  url = null;
  audio.removeAttribute('src');
  current = -1;
  lectureId = null;
  chunks = [];
  onTime = null;
  render();
}
