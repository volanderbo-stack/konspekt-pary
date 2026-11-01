// Диктофон — ТІЛЬКИ для другого пристрою. Запис іде сегментами по 10 хв: кожен сегмент —
// окремий самодостатній файл, тож одразу стає шматком для розпізнавання (без ffmpeg).
// Усередині сегмента кожні 15 с дані пишуться в IndexedDB, щоб збій не забрав запис.

import { putPart, getParts, deletePartsByKey, putChunk, getChunks, updateLecture } from './db.js';
import { keepAwake } from './util.js';

const SEGMENT_SEC = 600;
const SLICE_MS = 15_000;

function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
  return opts.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

export class Dictaphone {
  constructor(lectureId, { onTick, onLevel, onError } = {}) {
    Object.assign(this, { lectureId, onTick, onLevel, onError });
    this.seg = 0;
    this.part = 0;
    this.segStartedAt = 0;
    this.segStartSec = 0;
    this.stopping = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.mime = pickMime();
    this.release = keepAwake();
    this.startedAt = performance.now();
    this.#meter();
    this.#startSegment();
    this.timer = setInterval(() => {
      const elapsed = (performance.now() - this.startedAt) / 1000;
      this.onTick?.(elapsed);
      if (performance.now() - this.segStartedAt >= SEGMENT_SEC * 1000) this.#rotate();
    }, 500);
  }

  #meter() {
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        if (!this.ctx) return;
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        this.onLevel?.(peak / 128);
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* без індикатора рівня запис усе одно працює */ }
  }

  #startSegment() {
    const rec = new MediaRecorder(this.stream, { ...(this.mime && { mimeType: this.mime }), audioBitsPerSecond: 32000 });
    const seg = this.seg;
    const t0 = performance.now();
    const segStartSec = (t0 - this.startedAt) / 1000;
    this.segStartSec = segStartSec;
    this.segStartedAt = t0;
    this.part = 0;
    const saving = [];
    rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      saving.push(putPart({ lectureId: this.lectureId, seg, part: this.part++, blob: e.data, mime: rec.mimeType, segStartSec }));
    };
    rec.onerror = (e) => this.onError?.(e.error || e);
    this.finishing = new Promise((resolve) => {
      rec.onstop = async () => {
        await Promise.all(saving);
        await finalizeSegment(this.lectureId, seg, (performance.now() - t0) / 1000);
        resolve();
      };
    });
    rec.start(SLICE_MS);
    this.rec = rec;
  }

  async #rotate() {
    if (this.rotating || this.stopping) return;
    this.rotating = true;
    const old = this.rec;
    const oldFinishing = this.finishing;
    this.seg++;
    old.stop();
    // Новий рекордер стартує одразу — пропуск між сегментами ~десятки мс
    this.#startSegment();
    await oldFinishing;
    this.rotating = false;
  }

  /** @returns {Promise<number>} тривалість запису в секундах */
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    const duration = (performance.now() - this.startedAt) / 1000;
    if (this.rec?.state !== 'inactive') this.rec.stop();
    await this.finishing;
    this.stream.getTracks().forEach((t) => t.stop());
    cancelAnimationFrame(this.raf);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.release?.();
    return duration;
  }
}

/** Склеює частини сегмента в один шматок (Blob) і видаляє частини. */
async function finalizeSegment(lectureId, seg, durationSec) {
  const parts = (await getParts(lectureId)).filter((p) => p.seg === seg);
  if (!parts.length) return;
  const mime = (parts[0].mime || 'audio/webm').split(';')[0];
  const blob = new Blob(parts.map((p) => p.blob), { type: mime });
  await putChunk({
    lectureId, index: seg, start: parts[0].segStartSec, duration: durationSec || parts.length * (SLICE_MS / 1000),
    blob, mime, done: false,
  });
  await updateLecture(lectureId, (l) => { l.hasAudio = true; l.chunkCount = Math.max(l.chunkCount || 0, seg + 1); });
  // Видаляємо лише частини цього сегмента — наступний сегмент тим часом уже пише свої
  await deletePartsByKey(parts.map((p) => p.key));
}

/** Після збою (закрили вкладку під час запису): збираємо частини, що встигли зберегтися. */
export async function recoverRecording(lectureId) {
  const parts = await getParts(lectureId);
  const segs = [...new Set(parts.map((p) => p.seg))];
  for (const s of segs) {
    const n = parts.filter((p) => p.seg === s).length;
    await finalizeSegment(lectureId, s, n * (SLICE_MS / 1000));
  }
  const chunks = await getChunks(lectureId);
  const last = chunks[chunks.length - 1];
  return updateLecture(lectureId, (l) => {
    l.chunkCount = chunks.length;
    l.duration = last ? last.start + last.duration : 0;
    l.status = chunks.length ? 'paused' : 'error';
    l.error = chunks.length ? '' : 'Запис перервано, збережених даних немає.';
  });
}
