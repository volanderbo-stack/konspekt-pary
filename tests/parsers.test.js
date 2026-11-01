import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseVtt, parseTeamsLines, docxXmlToLines, parseDocxXml, parsePastedText,
  cleanSegments, segmentsToParagraphs, textToApproxSegments,
} from '../js/parsers.js';
import { fmtTime, parseTime } from '../js/util.js';
import { renderMarkdown, summaryToMarkdown } from '../js/markdown.js';

const vtt = readFileSync(new URL('./fixtures/teams-sample.vtt', import.meta.url), 'utf8');

test('fmtTime / parseTime', () => {
  assert.equal(fmtTime(2472.9), '00:41:12');
  assert.equal(parseTime('1:02:03.450'), 3723.45);
  assert.equal(parseTime('02:03'), 123);
  assert.equal(parseTime('0:0:4.25'), 4.25);
  assert.equal(parseTime('привіт'), null);
});

test('VTT з Teams: мовці, таймкоди, склеювання, службові рядки', () => {
  const p = parseVtt(vtt);
  assert.equal(p[0].speaker, 'Олена Коваль');
  assert.equal(p[0].t, 0);
  assert.match(p[0].text, /Добрий день.*сьогодні говоримо/i);
  assert.ok(!p.some((x) => /транскрибування/i.test(x.text)), 'службовий рядок прибрано');
  const student = p.find((x) => x.speaker === 'Андрій Шевчук');
  assert.ok(student);
  assert.equal(Math.round(student.t), 65);
});

test('новий формат .docx Teams: «Ім\'я  0:03» + текст', () => {
  const lines = [
    'Транскрипція', '3 жовтня 2026 р., 10:00',
    'Олена Коваль   0:03', 'Добрий день, починаємо.',
    'Андрій Шевчук   1:05', 'Можна питання?',
    'Олена Коваль   1:10', 'Так. Зустрінемось о 10:30 біля аудиторії.',
  ];
  const p = parseTeamsLines(lines);
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((x) => x.speaker), ['Олена Коваль', 'Андрій Шевчук', 'Олена Коваль']);
  assert.equal(p[1].t, 65);
  assert.match(p[2].text, /10:30/);
});

test('старий формат .docx Teams: таймінг --> / ім\'я / текст', () => {
  const xml = [
    '<w:p><w:r><w:t>0:0:0.0 --&gt; 0:0:5.680</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Олена Коваль</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Тема лекції — інтеграли &amp; ряди.</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>0:0:6.0 --&gt; 0:0:9.0</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Олена Коваль</w:t></w:r></w:p>',
    '<w:p><w:r><w:t xml:space="preserve">Записуйте. </w:t></w:r></w:p>',
  ].join('');
  assert.equal(docxXmlToLines(xml).length, 6);
  const p = parseDocxXml(xml);
  assert.equal(p.length, 1, 'дві репліки одного мовця поруч склеєні');
  assert.match(p[0].text, /інтеграли & ряди\. Записуйте\./);
});

test('вставлений звичайний текст → абзаци без таймкодів', () => {
  const p = parsePastedText('Перший абзац.\n\nДругий абзац тексту.');
  assert.equal(p.length, 2);
  assert.equal(p[0].t, null);
});

test('Whisper: прибирання галюцинацій і повторів, абзаци по паузах', () => {
  const segs = cleanSegments([
    { start: 0, end: 4, text: ' Добрий день.' },
    { start: 4, end: 8, text: ' Сьогодні тема — похідні.' },
    { start: 20, end: 24, text: 'Друга частина.' },
    { start: 24, end: 26, text: 'Друга частина.' },
    { start: 26, end: 28, text: 'Друга частина.' },
    { start: 30, end: 32, text: 'Дякую за перегляд!' },
  ]);
  assert.equal(segs.length, 4);
  const p = segmentsToParagraphs(segs);
  assert.equal(p.length, 2);
  assert.equal(p[1].t, 20);
});

test('приблизні сегменти для моделей без таймкодів', () => {
  const s = textToApproxSegments('Раз два. Три чотири.', 600, 100);
  assert.equal(s.length, 2);
  assert.equal(s[0].start, 600);
  assert.ok(s[1].start > 600 && s[1].start < 700);
});

test('конспект → markdown → HTML з клікабельними таймкодами', () => {
  const md = summaryToMarkdown({
    summary: ['Похідна — швидкість зміни.'],
    terms: [{ term: 'Похідна', definition: 'границя відношення приростів' }],
    homework: [{ task: 'Задачі 1–5', deadline: 'до п\'ятниці', time: '01:40:00' }],
    questions: [{ question: 'Що таке границя?', time: '00:41:12', to_whom: 'Андрій' }],
    mentions: [],
  }, { subject: 'Матаналіз', title: 'Похідні', myName: '' });
  assert.match(md, /## Короткий зміст/);
  const html = renderMarkdown(md);
  assert.match(html, /data-t="2472"/);
  assert.match(html, /<strong>Похідна<\/strong>/);
  assert.ok(!html.includes('<script'), 'HTML екранований');
  assert.ok(!renderMarkdown('<img src=x onerror=alert(1)>').includes('<img'));
});

test('фікстура .docx (новий формат Teams) розбирається повністю', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(readFileSync(new URL('./fixtures/teams-sample.docx', import.meta.url)));
  const p = parseDocxXml(await zip.file('word/document.xml').async('string'));
  assert.equal(p.length, 3);
  assert.equal(p[1].speaker, 'Андрій Шевчук');
  assert.ok(!p.some((x) => /транскрибування/.test(x.text)));
});
