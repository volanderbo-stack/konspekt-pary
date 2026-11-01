// Експорт у .txt / .md / .docx і кнопка «Поділитися».

import { fmtTime, fmtDate, fmtDuration, slug, download } from './util.js';
import { markdownToText } from './markdown.js';

const TAG_LABEL = { important: 'важливо', question: 'питання до мене', homework: 'домашнє' };

function headerLines(l) {
  return [
    [l.subject, l.title].filter(Boolean).join(' — ') || 'Пара',
    [fmtDate(l.date), l.duration ? fmtDuration(l.duration) : ''].filter(Boolean).join(' · '),
  ];
}

function paraLine(p) {
  const t = p.t != null ? `[${fmtTime(p.t)}] ` : '';
  const who = p.speaker ? `${p.speaker}: ` : '';
  const tags = p.tags?.length ? `  (${p.tags.map((x) => TAG_LABEL[x]).join(', ')})` : '';
  return `${t}${who}${p.text}${tags}`;
}

export function toMarkdown(l, what) {
  const [title, meta] = headerLines(l);
  const out = [];
  if (what !== 'summary' || !l.summary) out.push(`# ${title}`, '', `_${meta}_`, '');
  if (what !== 'transcript' && l.summary) out.push(l.summary, '');
  if (what !== 'summary') {
    out.push('## Транскрипція', '');
    l.paragraphs.forEach((p) => out.push(paraLine(p).replace(/^(\[\d+:\d+:\d+\])/, '**$1**'), ''));
  }
  return out.join('\n');
}

export function toText(l, what) {
  const [title, meta] = headerLines(l);
  const out = [title, meta, ''];
  if (what !== 'transcript' && l.summary) out.push(markdownToText(l.summary), '');
  if (what !== 'summary') {
    out.push('ТРАНСКРИПЦІЯ', '');
    l.paragraphs.forEach((p) => out.push(paraLine(p), ''));
  }
  return out.join('\n');
}

// ── Мінімальний .docx (WordprocessingML) через JSZip ──
const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function runs(text) {
  // **жирний** → окремі w:r з <w:b/>
  return text.split(/(\*\*.+?\*\*)/).filter(Boolean).map((part) => {
    const bold = /^\*\*.+\*\*$/.test(part);
    const t = bold ? part.slice(2, -2) : part.replace(/(^|\s)_(.+?)_/g, '$1$2');
    return `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
  }).join('');
}
const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs(text)}</w:p>`;

function mdToDocxBody(md) {
  return md.split('\n').map((line) => {
    let m;
    if (!line.trim()) return '';
    if ((m = line.match(/^#\s+(.*)/))) return para(m[1], 'Heading1');
    if ((m = line.match(/^#{2,3}\s+(.*)/))) return para(m[1], 'Heading2');
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) return para(`•  ${m[1]}`, 'ListPara');
    if ((m = line.match(/^\s*(\d+[.)])\s+(.*)/))) return para(`${m[1]}  ${m[2]}`, 'ListPara');
    return para(line);
  }).join('');
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="24"/><w:lang w:val="uk-UA"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListPara"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:spacing w:after="60"/></w:pPr></w:style>
</w:styles>`;

export async function toDocx(l, what) {
  const body = mdToDocxBody(toMarkdown(l, what));
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('word/document.xml', doc);
  zip.file('word/styles.xml', STYLES);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

export async function buildExport(l, format, what) {
  const base = slug([l.subject, l.title || l.date].filter(Boolean).join(' '));
  if (format === 'docx') return { blob: await toDocx(l, what), name: `${base}.docx` };
  if (format === 'md') return { blob: new Blob([toMarkdown(l, what)], { type: 'text/markdown;charset=utf-8' }), name: `${base}.md` };
  return { blob: new Blob([toText(l, what)], { type: 'text/plain;charset=utf-8' }), name: `${base}.txt` };
}

/** Web Share API з файлом; якщо не підтримується — просто завантаження. */
export async function shareOrDownload({ blob, name }, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  download(blob, name);
  return 'downloaded';
}
