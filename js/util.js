// Дрібні помічники: час, екранування, тости, завантаження файлів, Wake Lock.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 2472.4 → "00:41:12" */
export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [h, m, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

/** "1:02:03.450" | "02:03" | "0:0:4.25" | "00:00:01,200" → секунди; null, якщо не час */
export function parseTime(str) {
  const m = String(str).trim().match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d+))?$/);
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  if (m[3] !== undefined) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  return Number(m[1]) * 60 + Number(m[2]) + frac;
}

/** 6720 → "1 год 52 хв" */
export function fmtDuration(sec) {
  if (!sec) return '—';
  const total = Math.round(sec / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${Math.max(1, m)} хв`;
  return m ? `${h} год ${m} хв` : `${h} год`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

export function fmtBytes(n) {
  if (!n) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function slug(s) {
  return String(s || 'konspekt').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'konspekt';
}

let toastTimer;
export function toast(msg, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 3000);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Тримає екран увімкненим, поки йде обробка/запис. Повертає функцію release(). */
export function keepAwake() {
  let lock = null;
  let released = false;
  const acquire = async () => {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !released) {
        lock = await navigator.wakeLock.request('screen');
      }
    } catch { /* немає підтримки або відмовлено — не критично */ }
  };
  const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
  document.addEventListener('visibilitychange', onVis);
  acquire();
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVis);
    lock?.release().catch(() => {});
  };
}

/** Тривалість медіафайлу через <audio>/<video> без читання файлу в пам'ять. */
export function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith('video') ? 'video' : 'audio');
    el.preload = 'metadata';
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 15_000);
    el.src = url;
  });
}
