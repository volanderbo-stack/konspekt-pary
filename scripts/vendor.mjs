// Копіює бібліотеки з node_modules у vendor/, щоб PWA працювала без CDN і офлайн.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';

const copies = [
  ['node_modules/@ffmpeg/ffmpeg/dist/esm', 'vendor/ffmpeg', (f) => f.endsWith('.js')],
  ['node_modules/@ffmpeg/core/dist/esm', 'vendor/ffmpeg-core', () => true],
];
for (const [from, to, keep] of copies) {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from).filter(keep)) cpSync(`${from}/${f}`, `${to}/${f}`);
}
cpSync('node_modules/jszip/dist/jszip.min.js', 'vendor/jszip.min.js');
console.log('vendor/ готово');
