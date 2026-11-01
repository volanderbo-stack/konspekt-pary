// Створює tests/fixtures/teams-sample.docx у новому форматі Teams («Ім'я  0:03» + текст).
import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';

const lines = [
  'Транскрипція', '3 жовтня 2026 р., 10:00', 'Олена Коваль почала транскрибування',
  'Олена Коваль   0:03', 'Добрий день, колеги. Сьогодні говоримо про похідні та їх застосування.',
  'Олена Коваль   0:12', 'Похідна показує швидкість зміни функції. Запишіть означення.',
  'Олена Коваль   0:58', 'Андрію, скажіть, будь ласка, що таке границя функції?',
  'Андрій Шевчук   1:05', 'Це значення, до якого наближається функція, коли аргумент прямує до точки.',
  'Олена Коваль   1:13', 'Правильно. Домашнє завдання: задачі з першої по пʼяту, здати до пʼятниці.',
];
const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const body = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${x(l)}</w:t></w:r></w:p>`).join('');
const zip = new JSZip();
zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
writeFileSync('tests/fixtures/teams-sample.docx', await zip.generateAsync({ type: 'nodebuffer' }));
console.log('tests/fixtures/teams-sample.docx');
