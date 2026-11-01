// «Конспект пари» — маршрутизація й екрани.

import * as db from './db.js';
import * as jobs from './jobs.js';
import * as player from './player.js';
import { Dictaphone, recoverRecording } from './recorder.js';
import { parseVtt, parseDocxXml, parsePastedText, lastTime } from './parsers.js';
import { renderMarkdown } from './markdown.js';
import { buildExport, shareOrDownload } from './export.js';
import { estimateCost } from './transcribe.js';
import { probeWithFFmpeg } from './ffmpeg.js';
import {
  $, $$, esc, uid, fmtTime, fmtDate, fmtDuration, fmtBytes, todayISO, toast, download, probeDuration,
} from './util.js';

const main = $('#main');
const CHUNK_SEC = 600;
const SOURCE_LABEL = { teams: 'Транскрипція Teams', audio: 'Аудіо/відео', text: 'Текст', recording: 'Диктофон' };
const TAGS = [
  { id: 'important', icon: '★', label: 'Важливо' },
  { id: 'question', icon: '?', label: 'Питання до мене' },
  { id: 'homework', icon: '✎', label: 'Домашнє' },
];

let cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);
let activeRec = null; // { dict, lectureId } — диктофон живе поза екранами

const go = (path) => { location.hash = `#${path}`; };

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  onCleanup(() => target.removeEventListener(type, fn));
}

function setHeader({ title = 'Конспект пари', back = null, actions = '' }) {
  $('#hdr-title').textContent = title;
  const b = $('#hdr-back');
  b.hidden = !back;
  b.onclick = () => go(back);
  $('#hdr-actions').innerHTML = actions;
  document.title = title === 'Конспект пари' ? title : `${title} · Конспект пари`;
}

function displayStatus(l) {
  const running = jobs.isRunning(l.id);
  const pct = l.progress?.total ? Math.round((l.progress.done / l.progress.total) * 100) : 0;
  if (l.status === 'recording') return activeRec?.lectureId === l.id ? ['rec', 'Йде запис'] : ['warn', 'Запис перервано'];
  if (l.status === 'processing') return running ? ['busy', `Обробка ${pct}%`] : ['warn', 'Перервано'];
  if (l.status === 'paused') return ['warn', `Пауза · ${pct}%`];
  if (l.status === 'needs-file') return ['warn', 'Потрібен файл'];
  if (l.status === 'error') return ['err', 'Помилка'];
  return ['ok', 'Готово'];
}

function openSheet(html) {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = `<form method="dialog" class="sheet-inner">${html}</form>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.showModal();
  return d;
}

// ───────────────────────── Список пар ─────────────────────────
async function listView() {
  setHeader({
    actions: `<button class="icon-btn" id="to-settings" aria-label="Налаштування" title="Налаштування">⚙</button>`,
  });
  $('#to-settings').onclick = () => go('/settings');
  let lectures = await db.listLectures();
  const subjects = [...new Set(lectures.map((l) => l.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  let filter = sessionStorage.getItem('subjectFilter') || '';
  if (filter && !subjects.includes(filter)) filter = '';

  main.innerHTML = `
    ${activeRec ? `<a class="banner rec" href="#/rec/${activeRec.lectureId}">● Йде запис диктофона — відкрити</a>` : ''}
    ${lectures.length ? `
      <div class="searchbar"><input type="search" id="gq" placeholder="Пошук по всіх парах" aria-label="Пошук по всіх парах"></div>
      ${subjects.length > 1 ? `<div class="chips" id="subj">
        <button class="chip" data-s="" aria-pressed="${!filter}">Усі</button>
        ${subjects.map((s) => `<button class="chip" data-s="${esc(s)}" aria-pressed="${filter === s}">${esc(s)}</button>`).join('')}
      </div>` : ''}
      <div id="cards" class="cards"></div>` : `
      <div class="empty">
        <div class="empty-art" aria-hidden="true">🎓</div>
        <h2>Ще немає жодної пари</h2>
        <p>Teams записує й транскрибує пару сам, тож ваш мікрофон у дзвінку працює як завжди. Після пари завантажте сюди файл: тут буде текст із таймкодами, пошук і конспект.</p>
        <a class="btn" href="#/welcome">Як записати пару в Teams</a>
      </div>`}
    <a class="fab" href="#/new">＋ Додати пару</a>`;

  const cards = $('#cards');
  if (!cards) return;

  const card = (l, snippets = '') => {
    const [cls, label] = displayStatus(l);
    const pct = l.progress?.total ? (l.progress.done / l.progress.total) * 100 : 0;
    return `<a class="card" href="#/l/${l.id}${snippets ? `?q=${encodeURIComponent($('#gq').value.trim())}` : ''}">
      <div class="card-top"><span class="subject">${esc(l.subject || 'Без предмета')}</span><span class="status s-${cls}">${label}</span></div>
      <h3>${esc(l.title || fmtDate(l.date) || 'Пара')}</h3>
      <div class="meta">${[l.title ? fmtDate(l.date) : '', l.duration ? fmtDuration(l.duration) : '', SOURCE_LABEL[l.source]].filter(Boolean).map(esc).join(' · ')}</div>
      ${cls === 'busy' || cls === 'warn' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      ${snippets}
    </a>`;
  };

  const render = () => {
    const q = $('#gq').value.trim().toLowerCase();
    let items = lectures.filter((l) => !filter || l.subject === filter);
    if (q) {
      const html = items.map((l) => {
        const hits = (l.paragraphs || []).filter((p) => p.text.toLowerCase().includes(q)).slice(0, 3);
        const inMeta = `${l.subject} ${l.title}`.toLowerCase().includes(q);
        if (!hits.length && !inMeta) return '';
        const sn = hits.map((p) => `<p class="snippet">${p.t != null ? `<b>${fmtTime(p.t)}</b> ` : ''}${highlight(cut(p.text, q), q)}</p>`).join('');
        return card(l, sn || ' ');
      }).join('');
      cards.innerHTML = html || '<p class="muted center">Нічого не знайдено.</p>';
      return;
    }
    cards.innerHTML = items.map((l) => card(l)).join('');
  };
  $('#gq').addEventListener('input', debounce(render, 200));
  $('#subj')?.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    filter = b.dataset.s;
    sessionStorage.setItem('subjectFilter', filter);
    $$('#subj .chip').forEach((c) => c.setAttribute('aria-pressed', c === b));
    render();
  });
  render();
  listen(jobs.bus, 'changed', async () => { lectures = await db.listLectures(); render(); });
}

function cut(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0 || text.length < 180) return text;
  const s = Math.max(0, i - 70);
  return `${s ? '…' : ''}${text.slice(s, s + 180)}…`;
}

function highlight(text, q) {
  if (!q) return esc(text);
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ───────────────────────── Нова пара ─────────────────────────
async function newView(params) {
  setHeader({ title: 'Нова пара', back: '/' });
  const [lectures, settings] = await Promise.all([db.listLectures(), db.getSettings()]);
  const subjects = [...new Set(lectures.map((l) => l.subject).filter(Boolean))];
  let src = params.get('src') || 'teams';

  main.innerHTML = `
  <form id="nf" class="form" novalidate>
    <label>Предмет<input name="subject" list="subjects" required placeholder="Наприклад, Вища математика" value="${esc(sessionStorage.getItem('subjectFilter') || '')}"></label>
    <datalist id="subjects">${subjects.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
    <label><span>Тема <span class="muted">(необовʼязково)</span></span><input name="title" placeholder="Наприклад, Похідні"></label>
    <label>Дата<input name="date" type="date" value="${todayISO()}"></label>

    <fieldset class="sources">
      <legend>Звідки текст</legend>
      ${[
    ['teams', '📄', 'Файл транскрипції з Teams', '.vtt або .docx — найкращий варіант'],
    ['audio', '🎧', 'Аудіо або відео запис', 'mp4, m4a, mp3, webm — розпізнаю через OpenAI'],
    ['text', '📋', 'Вставити текст', 'скопійований текст транскрипції'],
    ['record', '🎙', 'Диктофон', 'тільки на ДРУГОМУ пристрої'],
  ].map(([v, icon, t, d]) => `
        <label class="src"><input type="radio" name="src" value="${v}" ${v === src ? 'checked' : ''}>
          <span class="src-icon" aria-hidden="true">${icon}</span><span><b>${t}</b><small>${d}</small></span></label>`).join('')}
    </fieldset>

    <div class="panel" data-for="teams">
      <label class="file">Файл транскрипції<input type="file" name="tfile" accept=".vtt,.docx,.txt,text/vtt"></label>
      <p class="hint">Teams: чат наради → «Підсумок» → «Транскрипція» → «Завантажити».</p>
      <details><summary>Додати аудіо для прослуховування (необовʼязково)</summary>
        <label class="file">Запис пари (mp4, m4a, mp3)<input type="file" name="tmedia" accept="audio/*,video/*,.mp4,.m4a,.mp3,.webm,.wav,.ogg"></label>
        <p class="hint">Тоді тап по таймкоду відкриє звук із цього місця. Розпізнавати повторно не потрібно.</p>
      </details>
    </div>
    <div class="panel" data-for="audio">
      <label class="file">Аудіо або відео (до ~2,5 год)<input type="file" name="afile" accept="audio/*,video/*,.mp4,.m4a,.mp3,.webm,.wav,.ogg"></label>
      <div id="ainfo" class="info" hidden></div>
      <label class="check"><input type="checkbox" name="transcribe" checked> Розпізнати текст (OpenAI, українська)</label>
      ${settings.openaiKey ? '' : '<p class="warn-box">Для розпізнавання потрібен API-ключ OpenAI — додайте його в <a href="#/settings">Налаштуваннях</a>. Без ключа звук лише збережеться для прослуховування.</p>'}
    </div>
    <div class="panel" data-for="text">
      <label>Текст<textarea name="text" rows="10" placeholder="Вставте сюди текст транскрипції"></textarea></label>
    </div>
    <div class="panel" data-for="record">
      <p class="danger-box"><b>Не вмикайте диктофон на тому ж телефоні, де йде дзвінок Teams</b> — інакше зламається мікрофон у дзвінку і вас не почують. Відкрийте застосунок на ноутбуці або другому телефоні й покладіть його поруч із динаміком.</p>
    </div>
    <button class="btn primary wide" id="nf-submit">Створити</button>
  </form>`;

  const form = $('#nf');
  const showPanel = () => {
    src = form.src.value;
    $$('.panel', form).forEach((p) => { p.hidden = p.dataset.for !== src; });
    $('#nf-submit').textContent = src === 'record' ? 'Перейти до диктофона' : src === 'audio' ? 'Створити й обробити' : 'Створити';
  };
  form.addEventListener('change', (e) => { if (e.target.name === 'src') showPanel(); });
  showPanel();

  let audioInfo = null;
  form.afile.addEventListener('change', async () => {
    const f = form.afile.files[0];
    const box = $('#ainfo');
    audioInfo = null;
    if (!f) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = 'Визначаю тривалість…';
    let duration = await probeDuration(f);
    if (!duration) {
      box.textContent = 'Визначаю тривалість через ffmpeg…';
      try { duration = await probeWithFFmpeg(f); } catch (e) { box.textContent = e.message; return; }
    }
    if (!duration) { box.textContent = 'Не вдалося прочитати файл. Перевірте, що це аудіо або відео.'; return; }
    const n = Math.ceil(duration / CHUNK_SEC);
    audioInfo = { duration, n };
    box.innerHTML = `<b>${esc(f.name)}</b><br>${fmtBytes(f.size)} · ${fmtDuration(duration)} · ${n} шматк${n === 1 ? 'а' : 'ів'} по 10 хв<br>
      Розпізнавання коштуватиме орієнтовно <b>$${estimateCost(duration).toFixed(2)}</b> (тариф OpenAI ~$0.006/хв).
      ${duration > 9000 ? '<br><span class="warn">Файл довший за 2,5 год — обробка буде довгою.</span>' : ''}`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#nf-submit');
    const subject = form.subject.value.trim();
    if (!subject) { form.subject.focus(); toast('Вкажіть предмет'); return; }
    const base = {
      id: uid(), subject, title: form.title.value.trim(), date: form.date.value || todayISO(),
      createdAt: Date.now(), source: src, status: 'ready', paragraphs: [], summary: '',
      duration: 0, chunkCount: 0, chunkSec: CHUNK_SEC, transcribe: false, hasAudio: false, progress: null, error: '',
    };
    btn.disabled = true;
    try {
      if (src === 'teams') {
        const f = form.tfile.files[0];
        if (!f) throw new Error('Виберіть файл транскрипції.');
        base.paragraphs = await parseTranscriptFile(f);
        base.duration = lastTime(base.paragraphs);
        const media = form.tmedia.files[0];
        if (media) await attachMedia(base, media);
        else await db.putLecture(base);
        if (media) jobs.startAudioJob(base.id, media);
      } else if (src === 'text') {
        const text = form.text.value.trim();
        if (!text) throw new Error('Вставте текст.');
        base.paragraphs = parsePastedText(text);
        base.duration = lastTime(base.paragraphs);
        await db.putLecture(base);
      } else if (src === 'audio') {
        const f = form.afile.files[0];
        if (!f) throw new Error('Виберіть аудіо або відео.');
        if (!audioInfo) throw new Error('Зачекайте, поки визначиться тривалість файлу.');
        base.transcribe = form.transcribe.checked && !!settings.openaiKey;
        base.duration = audioInfo.duration;
        base.chunkCount = audioInfo.n;
        base.status = 'processing';
        base.progress = { done: 0, total: audioInfo.n };
        base.sourceFile = { name: f.name, size: f.size };
        await db.putLecture(base);
        jobs.startAudioJob(base.id, f);
      } else {
        base.status = 'recording';
        base.transcribe = true;
        await db.putLecture(base);
        go(`/rec/${base.id}`);
        return;
      }
      go(`/l/${base.id}`);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

async function parseTranscriptFile(f) {
  const name = f.name.toLowerCase();
  let paragraphs;
  if (name.endsWith('.docx')) {
    const zip = await window.JSZip.loadAsync(f);
    const xml = await zip.file('word/document.xml')?.async('string');
    if (!xml) throw new Error('Це не схоже на файл Word (.docx).');
    paragraphs = parseDocxXml(xml);
  } else {
    const text = await f.text();
    paragraphs = name.endsWith('.vtt') || /^\s*WEBVTT/.test(text) ? parseVtt(text) : parsePastedText(text);
  }
  if (!paragraphs.length) throw new Error('У файлі не знайдено тексту транскрипції.');
  return paragraphs;
}

/** Аудіо до готової транскрипції: лише витягуємо звук для плеєра, без розпізнавання. */
async function attachMedia(lec, media) {
  let duration = await probeDuration(media);
  if (!duration) duration = await probeWithFFmpeg(media);
  if (!duration) throw new Error('Не вдалося прочитати аудіо/відео.');
  lec.chunkCount = Math.ceil(duration / CHUNK_SEC);
  lec.transcribe = false;
  lec.status = 'processing';
  lec.progress = { done: 0, total: lec.chunkCount };
  lec.sourceFile = { name: media.name, size: media.size };
  lec.duration = duration; // для витягу звуку потрібна тривалість саме аудіо
  await db.putLecture(lec);
}

// ───────────────────────── Пара ─────────────────────────
async function lectureView(id, params) {
  let lec = await db.getLecture(id);
  if (!lec) { toast('Пару не знайдено'); go('/'); return; }
  let tab = params.get('tab') === 'sum' ? 'sum' : 'text';
  let query = params.get('q') || '';
  let tagFilter = '';
  let editing = false;

  setHeader({
    title: lec.subject || 'Пара',
    back: '/',
    actions: `<button class="icon-btn" id="exp" aria-label="Експорт і поділитися" title="Експорт">⇪</button>
              <button class="icon-btn" id="more" aria-label="Ще дії" title="Ще">⋯</button>`,
  });

  main.innerHTML = `
    <section class="lec-head">
      <h1 id="lec-title"></h1>
      <div class="meta" id="lec-meta"></div>
    </section>
    <div id="status-box"></div>
    <nav class="tabs" role="tablist">
      <button role="tab" data-tab="text">Транскрипція</button>
      <button role="tab" data-tab="sum">Конспект</button>
    </nav>
    <div id="tab-body"></div>`;

  const hasAudio = await player.attach(id, (t) => markNow(t));

  const renderHead = () => {
    $('#lec-title').textContent = lec.title || fmtDate(lec.date) || 'Пара';
    $('#lec-meta').textContent = [lec.title ? fmtDate(lec.date) : '', lec.duration ? fmtDuration(lec.duration) : '', SOURCE_LABEL[lec.source]]
      .filter(Boolean).join(' · ');
  };

  const renderStatus = () => {
    const box = $('#status-box');
    const running = jobs.isRunning(id);
    const pr = jobs.progressOf(id);
    const done = lec.progress?.done || 0;
    const total = lec.progress?.total || lec.chunkCount || 0;
    if (running && pr?.kind !== 'summary') {
      const pct = pr?.total ? (pr.done / pr.total) * 100 : 0;
      box.innerHTML = `<div class="status-card">
        <div class="row"><b>Обробка</b><button class="btn small" id="pause">Пауза</button></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <p class="muted">${esc(pr?.text || 'Готую…')}</p>
        <p class="hint">Не закривайте вкладку й не блокуйте екран. Якщо обробку перервати — вона продовжиться з того ж шматка.</p>
      </div>`;
      $('#pause').onclick = () => jobs.pauseJob(id);
    } else if (lec.status === 'recording') {
      box.innerHTML = activeRec?.lectureId === id
        ? `<div class="status-card"><b>Йде запис диктофона.</b> <a href="#/rec/${id}">Відкрити диктофон</a></div>`
        : `<div class="status-card warn"><b>Запис було перервано.</b><p>Зберегти те, що встигло записатися, і розпізнати?</p><button class="btn primary" id="recover">Відновити запис</button></div>`;
      $('#recover')?.addEventListener('click', async () => { lec = await recoverRecording(id); renderAll(); });
    } else if (['processing', 'paused', 'error'].includes(lec.status)) {
      const err = lec.status === 'error';
      box.innerHTML = `<div class="status-card ${err ? 'err' : 'warn'}">
        <b>${err ? 'Обробку зупинено через помилку' : 'Обробку призупинено'}</b>
        ${total ? `<div class="bar"><i style="width:${(done / total) * 100}%"></i></div><p class="muted">Готово шматків: ${done} з ${total}</p>` : ''}
        ${err ? `<p>${esc(lec.error)}</p>` : ''}
        <button class="btn primary" id="resume">Продовжити</button>
      </div>`;
      $('#resume').onclick = () => jobs.startAudioJob(id);
    } else if (lec.status === 'needs-file') {
      box.innerHTML = `<div class="status-card warn">
        <b>Щоб продовжити, виберіть той самий файл</b>
        <p class="muted">${esc(lec.sourceFile?.name || '')} · ${fmtBytes(lec.sourceFile?.size)}. Готові шматки повторно не оброблятимуться.</p>
        <label class="file">Вибрати файл<input type="file" id="refile" accept="audio/*,video/*,.mp4,.m4a,.mp3,.webm,.wav,.ogg"></label>
      </div>`;
      $('#refile').onchange = (e) => { const f = e.target.files[0]; if (f) jobs.startAudioJob(id, f); };
    } else box.innerHTML = '';
  };

  // ── Транскрипція ──
  const renderText = () => {
    const counts = Object.fromEntries(TAGS.map((t) => [t.id, lec.paragraphs.filter((p) => p.tags?.includes(t.id)).length]));
    if (!lec.paragraphs.length) {
      $('#tab-body').innerHTML = `<p class="muted center pad">${jobs.isRunning(id) ? 'Текст зʼявлятиметься тут у міру розпізнавання шматків.' : 'Тексту поки немає.'}</p>`;
      return;
    }
    $('#tab-body').innerHTML = `
      <div class="toolbar">
        <div class="search">
          <input type="search" id="q" placeholder="Пошук у тексті" value="${esc(query)}" aria-label="Пошук у тексті">
          <span class="count" id="qcount"></span>
          <button class="icon-btn" id="qprev" aria-label="Попередній збіг">↑</button>
          <button class="icon-btn" id="qnext" aria-label="Наступний збіг">↓</button>
        </div>
        <div class="chips" id="tagf">
          <button class="chip" data-f="" aria-pressed="${!tagFilter}">Усе</button>
          ${TAGS.map((t) => `<button class="chip tag-${t.id}" data-f="${t.id}" aria-pressed="${tagFilter === t.id}">${t.icon} ${t.label}${counts[t.id] ? ` · ${counts[t.id]}` : ''}</button>`).join('')}
        </div>
      </div>
      <div id="paras" class="paras"></div>`;
    renderParas();
    const q = $('#q');
    q.addEventListener('input', debounce(() => { query = q.value.trim(); renderParas(); jump(0); }, 200));
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(1); } });
    $('#qnext').onclick = () => jump(1);
    $('#qprev').onclick = () => jump(-1);
    $('#tagf').onclick = (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      tagFilter = b.dataset.f;
      $$('#tagf .chip').forEach((c) => c.setAttribute('aria-pressed', c === b));
      renderParas();
    };
    if (query) jump(0);
  };

  let hit = -1;
  const renderParas = () => {
    const list = lec.paragraphs.filter((p) => !tagFilter || p.tags?.includes(tagFilter));
    $('#paras').innerHTML = list.length ? list.map((p) => `
      <article class="para" id="p-${p.id}" data-id="${p.id}" data-t="${p.t ?? ''}">
        <div class="para-head">
          ${p.t != null ? `<button class="tc" data-t="${Math.floor(p.t)}" aria-label="Слухати з ${fmtTime(p.t)}">${fmtTime(p.t)}</button>` : ''}
          ${p.speaker ? `<span class="speaker">${esc(p.speaker)}</span>` : ''}
          <span class="para-tags">${TAGS.map((t) => `<button class="tag tag-${t.id}" data-tag="${t.id}" aria-pressed="${!!p.tags?.includes(t.id)}" aria-label="${t.label}" title="${t.label}">${t.icon}</button>`).join('')}</span>
        </div>
        <p>${highlight(p.text, query)}</p>
      </article>`).join('') : '<p class="muted center pad">Немає абзаців із такою позначкою.</p>';
    hit = -1;
    const n = $$('#paras mark').length;
    $('#qcount').textContent = query ? `0/${n}` : '';
  };

  const jump = (dir) => {
    const marks = $$('#paras mark');
    if (!marks.length) { if (query) $('#qcount').textContent = '0/0'; return; }
    marks[hit]?.classList.remove('cur');
    hit = dir === 0 ? 0 : (hit + dir + marks.length) % marks.length;
    marks[hit].classList.add('cur');
    marks[hit].scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('#qcount').textContent = `${hit + 1}/${marks.length}`;
  };

  let nowId = null;
  const markNow = (t) => {
    const p = [...lec.paragraphs].reverse().find((x) => x.t != null && x.t <= t + 0.5);
    if (!p || p.id === nowId) return;
    $(`#p-${nowId}`)?.classList.remove('now');
    nowId = p.id;
    $(`#p-${nowId}`)?.classList.add('now');
  };

  // ── Конспект ──
  const renderSummary = async () => {
    const s = await db.getSettings();
    const pr = jobs.progressOf(id);
    const body = $('#tab-body');
    const provider = s.summaryProvider === 'openai' ? `OpenAI (${s.openaiModel})` : `Claude (${s.anthropicModel})`;
    const key = s.summaryProvider === 'openai' ? s.openaiKey : s.anthropicKey;
    if (pr?.kind === 'summary') {
      body.innerHTML = `<div class="status-card"><div class="spinner" aria-hidden="true"></div><p>${esc(pr.text)}</p></div>`;
      return;
    }
    const busyAudio = jobs.isRunning(id) || ['processing', 'paused', 'needs-file', 'recording'].includes(lec.status);
    const err = lec.summaryError ? `<p class="danger-box">${esc(lec.summaryError)}</p>` : '';
    if (editing) {
      body.innerHTML = `<textarea id="md-edit" class="md-edit" rows="24">${esc(lec.summary)}</textarea>
        <div class="row gap"><button class="btn primary" id="md-save">Зберегти</button><button class="btn" id="md-cancel">Скасувати</button></div>`;
      $('#md-save').onclick = async () => {
        lec = await db.updateLecture(id, (l) => { l.summary = $('#md-edit').value; });
        editing = false;
        renderSummary();
      };
      $('#md-cancel').onclick = () => { editing = false; renderSummary(); };
      return;
    }
    if (!lec.summary) {
      body.innerHTML = `${err}<div class="empty small">
        <h2>Конспект ще не створено</h2>
        <p>Короткий зміст (10–15 пунктів), ключові терміни, що задали й дедлайни, питання до студентів з таймкодами${s.myName ? ` і де згадували «${esc(s.myName)}»` : ''}.</p>
        ${!lec.paragraphs.length ? '<p class="muted">Спершу потрібен текст транскрипції.</p>'
    : busyAudio ? '<p class="muted">Дочекайтесь завершення розпізнавання, щоб конспект охопив усю пару.</p>' : ''}
        ${key ? '' : `<p class="warn-box">Потрібен API-ключ ${s.summaryProvider === 'openai' ? 'OpenAI' : 'Anthropic'} — додайте його в <a href="#/settings">Налаштуваннях</a>.</p>`}
        <button class="btn primary" id="gen" ${!lec.paragraphs.length || !key ? 'disabled' : ''}>Створити конспект</button>
        <p class="hint">Через ${esc(provider)}</p>
      </div>`;
      $('#gen').onclick = () => { if (!busyAudio || confirm('Розпізнавання ще не завершено. Створити конспект із наявного тексту?')) jobs.startSummaryJob(id); };
      return;
    }
    body.innerHTML = `${err}
      <div class="row gap wrap sum-tools">
        <button class="btn small" id="md-ed">Редагувати</button>
        <button class="btn small" id="md-re" ${key ? '' : 'disabled'}>Перегенерувати</button>
        <button class="btn small" id="md-copy">Копіювати</button>
      </div>
      <article class="md-body">${renderMarkdown(lec.summary)}</article>
      <p class="hint">Тап по таймкоду — ${hasAudio ? 'слухати з цього місця' : 'перейти до місця в транскрипції'}.</p>`;
    $('#md-ed').onclick = () => { editing = true; renderSummary(); };
    $('#md-re').onclick = () => { if (confirm('Створити конспект заново? Ручні правки буде втрачено.')) jobs.startSummaryJob(id); };
    $('#md-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(lec.summary); toast('Скопійовано'); } catch { toast('Не вдалося скопіювати', 'error'); }
    };
  };

  const renderTab = () => {
    $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
    if (tab === 'sum') renderSummary(); else renderText();
  };
  const renderAll = () => { renderHead(); renderStatus(); renderTab(); };

  $('.tabs').onclick = (e) => {
    const b = e.target.closest('[role=tab]');
    if (!b || b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    history.replaceState(null, '', `#/l/${id}${tab === 'sum' ? '?tab=sum' : ''}`);
    renderTab();
  };

  // Делегування: таймкоди, позначки
  main.onclick = async (e) => {
    const tc = e.target.closest('.tc');
    if (tc) {
      const t = Number(tc.dataset.t);
      const playing = (await db.getLecture(id)).hasAudio && await player.playAt(t);
      if (!playing) {
        if (tab !== 'text') { tab = 'text'; renderTab(); }
        const p = [...lec.paragraphs].reverse().find((x) => x.t != null && x.t <= t + 1) || lec.paragraphs[0];
        const el = $(`#p-${p?.id}`);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el?.classList.add('flash');
        setTimeout(() => el?.classList.remove('flash'), 1600);
        if (!lec.hasAudio && tc.closest('.para')) toast('Аудіо не додано. Додайте запис через меню ⋯');
      }
      return;
    }
    const tagBtn = e.target.closest('.tag');
    if (tagBtn) {
      const pid = tagBtn.closest('.para').dataset.id;
      const tag = tagBtn.dataset.tag;
      lec = await db.updateLecture(id, (l) => {
        const p = l.paragraphs.find((x) => x.id === pid);
        if (!p) return;
        p.tags = p.tags?.includes(tag) ? p.tags.filter((x) => x !== tag) : [...(p.tags || []), tag];
      });
      const p = lec.paragraphs.find((x) => x.id === pid);
      tagBtn.setAttribute('aria-pressed', !!p?.tags?.includes(tag));
      const chip = $(`#tagf .chip[data-f="${tag}"]`);
      const t = TAGS.find((x) => x.id === tag);
      const n = lec.paragraphs.filter((x) => x.tags?.includes(tag)).length;
      if (chip) chip.textContent = `${t.icon} ${t.label}${n ? ` · ${n}` : ''}`;
    }
  };
  onCleanup(() => { main.onclick = null; });

  $('#exp').onclick = () => exportSheet(lec);
  $('#more').onclick = () => moreSheet(lec, async () => { lec = await db.getLecture(id); renderAll(); });

  listen(jobs.bus, 'progress', (e) => { if (e.detail.id === id) { renderStatus(); if (e.detail.kind === 'summary' && tab === 'sum') renderSummary(); } });
  listen(jobs.bus, 'changed', async (e) => {
    if (e.detail.id !== id) return;
    const before = lec.paragraphs.length;
    lec = await db.getLecture(id);
    renderHead();
    renderStatus();
    if (tab === 'sum') renderSummary();
    else if (lec.paragraphs.length !== before && !query) renderText();
    if (lec.hasAudio) player.attach(id, (t) => markNow(t));
  });

  renderAll();
}

function exportSheet(lec) {
  const d = openSheet(`
    <h2>Експорт</h2>
    <fieldset class="seg"><legend>Що</legend>
      <label><input type="radio" name="what" value="all" checked> Усе</label>
      <label><input type="radio" name="what" value="summary" ${lec.summary ? '' : 'disabled'}> Конспект</label>
      <label><input type="radio" name="what" value="transcript"> Транскрипція</label>
    </fieldset>
    <fieldset class="seg"><legend>Формат</legend>
      <label><input type="radio" name="fmt" value="docx" checked> Word .docx</label>
      <label><input type="radio" name="fmt" value="md"> .md</label>
      <label><input type="radio" name="fmt" value="txt"> .txt</label>
    </fieldset>
    <div class="row gap">
      <button class="btn primary" value="share" id="do-share">Поділитися</button>
      <button class="btn" value="dl" id="do-dl">Завантажити</button>
    </div>
    <button class="btn ghost wide" value="cancel">Закрити</button>`);
  const f = $('form', d);
  const run = async (mode) => {
    const fresh = await db.getLecture(lec.id);
    const file = await buildExport(fresh, f.fmt.value, f.what.value);
    if (mode === 'share') {
      const r = await shareOrDownload(file, fresh.subject);
      if (r === 'downloaded') toast(`Збережено: ${file.name}`);
    } else {
      download(file.blob, file.name);
      toast(`Збережено: ${file.name}`);
    }
    d.close();
  };
  $('#do-share', d).onclick = (e) => { e.preventDefault(); run('share').catch((err) => toast(err.message, 'error')); };
  $('#do-dl', d).onclick = (e) => { e.preventDefault(); run('dl').catch((err) => toast(err.message, 'error')); };
}

function moreSheet(lec, refresh) {
  const canAddAudio = !lec.hasAudio && !jobs.isRunning(lec.id) && ['teams', 'text'].includes(lec.source);
  const d = openSheet(`
    <h2>Пара</h2>
    <label>Предмет<input name="subject" value="${esc(lec.subject)}"></label>
    <label>Тема<input name="title" value="${esc(lec.title)}"></label>
    <label>Дата<input name="date" type="date" value="${esc(lec.date)}"></label>
    <button class="btn primary wide" id="save-meta">Зберегти</button>
    ${canAddAudio ? `<label class="file">Додати аудіо для прослуховування<input type="file" id="add-media" accept="audio/*,video/*,.mp4,.m4a,.mp3,.webm,.wav,.ogg"></label>` : ''}
    <button class="btn danger wide" id="del">Видалити пару</button>
    <button class="btn ghost wide" value="cancel">Закрити</button>`);
  const f = $('form', d);
  $('#save-meta', d).onclick = async (e) => {
    e.preventDefault();
    await db.updateLecture(lec.id, (l) => {
      l.subject = f.subject.value.trim() || l.subject;
      l.title = f.title.value.trim();
      l.date = f.date.value || l.date;
    });
    d.close();
    toast('Збережено');
    refresh();
  };
  $('#add-media', d)?.addEventListener('change', async (e) => {
    const media = e.target.files[0];
    if (!media) return;
    try {
      const l = await db.getLecture(lec.id);
      await attachMedia(l, media);
      d.close();
      jobs.startAudioJob(lec.id, media);
      refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#del', d).onclick = async (e) => {
    e.preventDefault();
    if (!confirm('Видалити цю пару разом із текстом, конспектом і аудіо?')) return;
    jobs.pauseJob(lec.id);
    player.stop();
    await db.deleteLecture(lec.id);
    d.close();
    toast('Пару видалено');
    go('/');
  };
}

// ───────────────────────── Диктофон ─────────────────────────
async function recordView(id) {
  const lec = await db.getLecture(id);
  if (!lec) { go('/'); return; }
  setHeader({ title: 'Диктофон', back: `/l/${id}` });
  const isActive = activeRec?.lectureId === id;
  if (!isActive && lec.status !== 'recording') { go(`/l/${id}`); return; }
  // Перерваний запис (є збережені дані) відновлюється на екрані пари, а не перезаписується
  if (!isActive && ((await db.getChunks(id)).length || (await db.getParts(id)).length)) { go(`/l/${id}`); return; }

  main.innerHTML = `
    <div class="rec-wrap">
      <p class="danger-box" id="rec-warn"><b>Тільки на другому пристрої!</b> Не вмикайте диктофон на телефоні, де зараз дзвінок Teams: мікрофон у дзвінку перестане працювати.</p>
      <div class="rec-time" id="rec-time">00:00:00</div>
      <div class="meter" aria-hidden="true"><i id="rec-level"></i></div>
      <p class="muted center" id="rec-note">Покладіть пристрій поруч із динаміком. Не блокуйте екран і не закривайте вкладку.</p>
      <button class="btn rec-btn" id="rec-start">● Почати запис</button>
      <button class="btn primary wide" id="rec-stop" hidden>■ Зупинити й обробити</button>
      <p class="hint center">Кожні 15 секунд запис зберігається на пристрої, тому при збої втратиться щонайбільше кілька секунд.${/iPhone|iPad/.test(navigator.userAgent) ? ' На iPhone запис зупиняється, коли блокується екран.' : ''}</p>
    </div>`;

  const ui = {
    time: $('#rec-time'), level: $('#rec-level'), start: $('#rec-start'), stop: $('#rec-stop'), note: $('#rec-note'),
  };
  const bind = (dict) => {
    dict.onTick = (s) => { ui.time.textContent = fmtTime(s); };
    dict.onLevel = (v) => { ui.level.style.width = `${Math.min(100, v * 140)}%`; };
    dict.onError = (e) => toast(`Помилка запису: ${e.message || e}`, 'error');
    ui.start.hidden = true;
    ui.stop.hidden = false;
    ui.note.textContent = 'Йде запис… Можна перейти на інші екрани — запис триватиме.';
  };
  if (isActive) bind(activeRec.dict);
  onCleanup(() => { if (activeRec) { activeRec.dict.onTick = null; activeRec.dict.onLevel = null; } });

  ui.start.onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast('Цей браузер не підтримує запис. Відкрийте застосунок через https у Chrome або Safari.', 'error');
      return;
    }
    if (!confirm('Цей пристрій НЕ використовується для дзвінка Teams?')) return;
    const dict = new Dictaphone(id);
    try {
      await dict.start();
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Немає дозволу на мікрофон.' : `Не вдалося почати запис: ${e.message}`, 'error');
      return;
    }
    activeRec = { dict, lectureId: id };
    bind(dict);
  };

  ui.stop.onclick = async () => {
    ui.stop.disabled = true;
    ui.note.textContent = 'Зберігаю запис…';
    const dur = await activeRec.dict.stop();
    activeRec = null;
    const chunks = await db.getChunks(id);
    await db.updateLecture(id, (l) => {
      l.duration = dur;
      l.chunkCount = chunks.length;
      l.status = 'paused';
      l.progress = { done: 0, total: chunks.length };
    });
    jobs.startAudioJob(id);
    go(`/l/${id}`);
  };
}

// ───────────────────────── Налаштування ─────────────────────────
async function settingsView() {
  setHeader({ title: 'Налаштування', back: '/' });
  const s = await db.getSettings();
  let usage = '';
  try {
    const est = await navigator.storage?.estimate();
    const persisted = await navigator.storage?.persisted?.();
    if (est) usage = `Зайнято ${fmtBytes(est.usage)} з ${fmtBytes(est.quota)}. ${persisted ? 'Дані захищені від автоочищення.' : 'Браузер може очистити дані при нестачі місця.'}`;
  } catch { /* немає Storage API */ }

  const keyField = (name, label, hint) => `
    <label>${label}
      <span class="key-row"><input name="${name}" type="password" autocomplete="off" spellcheck="false" value="${esc(s[name])}" placeholder="не задано">
      <button type="button" class="icon-btn" data-show="${name}" aria-label="Показати ключ">👁</button>
      <button type="button" class="icon-btn" data-clear="${name}" aria-label="Видалити ключ">✕</button></span>
      <small class="muted">${hint}</small>
    </label>`;

  main.innerHTML = `
  <form id="sf" class="form">
    <h2>Ключі API</h2>
    <p class="hint">Ключі зберігаються тільки на цьому пристрої й відправляються лише напряму в OpenAI / Anthropic.</p>
    ${keyField('openaiKey', 'OpenAI', 'Для розпізнавання аудіо (і конспекту, якщо оберете OpenAI). platform.openai.com → API keys')}
    ${keyField('anthropicKey', 'Anthropic (Claude)', 'Для конспекту. console.anthropic.com → API keys')}

    <h2>Про мене</h2>
    <label><span>Моє імʼя <span class="muted">(щоб знаходити, коли зверталися до мене)</span></span><input name="myName" value="${esc(s.myName)}" placeholder="Наприклад, Андрій"></label>

    <h2>Розпізнавання</h2>
    <label>Модель
      <select name="sttModel">
        <option value="whisper-1" ${s.sttModel === 'whisper-1' ? 'selected' : ''}>whisper-1 — точні таймкоди (рекомендовано)</option>
        <option value="gpt-4o-transcribe" ${s.sttModel === 'gpt-4o-transcribe' ? 'selected' : ''}>gpt-4o-transcribe — точніший текст, таймкоди приблизні</option>
      </select></label>

    <h2>Конспект</h2>
    <label>Через
      <select name="summaryProvider">
        <option value="anthropic" ${s.summaryProvider !== 'openai' ? 'selected' : ''}>Claude (Anthropic)</option>
        <option value="openai" ${s.summaryProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
      </select></label>
    <label>Модель Claude
      <select name="anthropicModel">
        ${[['claude-opus-5-5', 'Claude Opus 5.5 — найкраща якість'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — дешевше'], ['claude-haiku-5-5', 'Claude Haiku 5.5 — найдешевше']]
    .map(([v, t]) => `<option value="${v}" ${s.anthropicModel === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
    <label>Модель OpenAI<input name="openaiModel" value="${esc(s.openaiModel)}"></label>

    <h2>Вигляд</h2>
    <label>Тема
      <select name="theme">
        <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>Як у системі</option>
        <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Світла</option>
        <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Темна</option>
      </select></label>

    <h2>Дані</h2>
    <p class="hint">${esc(usage)}</p>
    <div class="row gap wrap">
      <button type="button" class="btn" id="backup">Резервна копія (JSON)</button>
      <label class="btn file-btn">Відновити з копії<input type="file" id="restore" accept=".json,application/json" hidden></label>
      <button type="button" class="btn" id="howto">Підказки про Teams</button>
    </div>
    <button type="button" class="btn danger wide" id="wipe">Видалити всі пари</button>
    <p class="hint center">Конспект пари · працює офлайн, дані — лише на пристрої</p>
  </form>`;

  const f = $('#sf');
  f.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el.name) return;
    await db.setSetting(el.name, el.value.trim());
    if (el.name === 'theme') applyTheme(el.value);
    toast('Збережено');
  });
  f.addEventListener('click', async (e) => {
    const show = e.target.closest('[data-show]');
    if (show) { const i = f[show.dataset.show]; i.type = i.type === 'password' ? 'text' : 'password'; }
    const clr = e.target.closest('[data-clear]');
    if (clr && f[clr.dataset.clear].value && confirm('Видалити цей ключ з пристрою?')) {
      f[clr.dataset.clear].value = '';
      await db.setSetting(clr.dataset.clear, '');
      toast('Ключ видалено');
    }
  });
  $('#backup').onclick = async () => {
    const data = await db.exportBackup();
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `konspekt-backup-${todayISO()}.json`);
  };
  $('#restore').onchange = async (e) => {
    try {
      const n = await db.importBackup(JSON.parse(await e.target.files[0].text()));
      toast(`Відновлено пар: ${n}`);
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#howto').onclick = () => go('/welcome');
  $('#wipe').onclick = async () => {
    if (!confirm('Видалити ВСІ пари, тексти, конспекти й аудіо з цього пристрою? Це не можна скасувати.')) return;
    player.stop();
    await db.clearAll();
    toast('Усі пари видалено');
    go('/');
  };
}

// ───────────────────────── Перший запуск ─────────────────────────
const STEPS = [
  {
    icon: '🎧',
    title: 'Мікрофон у Teams працює як завжди',
    html: `<p>Цей застосунок <b>нічого не записує під час дзвінка</b> на тому ж телефоні. Телефон не дає двом програмам ділити мікрофон, тому запис робить сам Teams, а ви спокійно відповідаєте на питання.</p>
           <p>Після пари завантажте сюди файл: буде текст із таймкодами, пошук, позначки й конспект.</p>`,
  },
  {
    icon: '⏺',
    title: 'Увімкніть запис і транскрипцію в Teams',
    html: `<p>Попросіть викладача (організатора наради) на початку пари:</p>
           <ol><li>У нараді: <b>••• Більше</b> → <b>Запис і транскрипція</b>.</li>
           <li><b>Почати транскрипцію</b> (і за бажанням <b>Почати запис</b>).</li>
           <li>Мова мовлення: <b>Українська</b>.</li></ol>
           <p class="hint">Студент зазвичай не має прав вмикати це сам — це налаштування організатора або адміністратора навчального закладу.</p>`,
  },
  {
    icon: '⬇',
    title: 'Де скачати файл після пари',
    html: `<ol><li>У Teams на компʼютері або на <b>teams.microsoft.com</b> відкрийте <b>чат наради</b>.</li>
           <li>Вкладка <b>«Підсумок»</b> (Recap) → <b>«Транскрипція»</b> → <b>«Завантажити»</b> (.docx або .vtt).</li>
           <li>Запис відео — там само або в OneDrive/SharePoint організатора.</li></ol>
           <p>Потім тут: <b>＋ Додати пару</b> → «Файл транскрипції з Teams».</p>
           <p class="hint">На телефоні завантаження транскрипції в застосунку Teams може бути недоступне — тоді відкрийте teams.microsoft.com у браузері.</p>`,
  },
  {
    icon: '🎙',
    title: 'Якщо запис у Teams заборонено',
    html: `<p>Скористайтесь <b>Диктофоном</b> цього застосунку на <b>другому пристрої</b> (ноутбук, старий телефон), поклавши його поруч із динаміком.</p>
           <p class="danger-box"><b>Не вмикайте диктофон на тому ж телефоні, де йде дзвінок Teams</b> — мікрофон у дзвінку перестане працювати.</p>
           <p>Для розпізнавання аудіо й конспекту потрібні ключі API (OpenAI / Anthropic) — їх можна додати в Налаштуваннях будь-коли.</p>`,
  },
];

function welcomeView() {
  setHeader({ title: 'Як це працює' });
  let i = 0;
  const render = () => {
    const s = STEPS[i];
    main.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon" aria-hidden="true">${s.icon}</div>
        <h1>${s.title}</h1>
        <div class="welcome-body">${s.html}</div>
        <div class="dots" aria-label="Крок ${i + 1} з ${STEPS.length}">${STEPS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
        <div class="row gap">
          ${i ? '<button class="btn" id="w-prev">Назад</button>' : '<button class="btn ghost" id="w-skip">Пропустити</button>'}
          <button class="btn primary" id="w-next">${i === STEPS.length - 1 ? 'Почати' : 'Далі'}</button>
        </div>
      </div>`;
    $('#w-prev')?.addEventListener('click', () => { i--; render(); });
    $('#w-skip')?.addEventListener('click', finish);
    $('#w-next').onclick = () => { if (i === STEPS.length - 1) finish(); else { i++; render(); } };
  };
  const finish = async () => { await db.setSetting('onboarded', true); go('/'); };
  render();
}

// ───────────────────────── Запуск ─────────────────────────
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
}

async function route() {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  window.scrollTo(0, 0);
  const [path, qs = ''] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(qs);
  const s = await db.getSettings();
  if (!s.onboarded && path !== '/welcome') { go('/welcome'); return; }
  try {
    if (path === '/') await listView();
    else if (path === '/new') await newView(params);
    else if (path === '/settings') await settingsView();
    else if (path === '/welcome') welcomeView();
    else if (path.startsWith('/l/')) await lectureView(path.slice(3), params);
    else if (path.startsWith('/rec/')) await recordView(path.slice(5));
    else go('/');
  } catch (e) {
    console.error(e);
    main.innerHTML = `<p class="danger-box">Щось пішло не так: ${esc(e.message)}</p>`;
  }
}

async function boot() {
  const s = await db.getSettings();
  applyTheme(s.theme);
  $('#player-toggle').onclick = player.toggle;
  $('#player-back').onclick = () => player.skip(-15);
  $('#player-fwd').onclick = () => player.skip(15);
  $('#player-close').onclick = player.stop;
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => {
    if (activeRec || jobs.anyRunning()) e.preventDefault();
  });
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e));
  }
  route();
}

boot();
