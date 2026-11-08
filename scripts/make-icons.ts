/**
 * Генерує PNG-іконки PWA з public/icons/icon.svg.
 * Запуск (тільки розробнику, Єгору не потрібно): npm run make:icons
 * Готові PNG лежать у репозиторії, тож збірка цей скрипт не викликає.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const iconsDir = fileURLToPath(new URL('../public/icons/', import.meta.url));
const svg = await readFile(`${iconsDir}icon.svg`, 'utf8');

/** iOS бере apple-touch-icon 180×180; 192 і 512 — для manifest. */
const targets: Array<[file: string, size: number]> = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];

const browser = await chromium.launch();
try {
  for (const [file, size] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const sized = svg.replace('width="512" height="512"', `width="${size}" height="${size}"`);
    await page.setContent(`<html><body style="margin:0">${sized}</body></html>`);
    await page.screenshot({ path: `${iconsDir}${file}`, omitBackground: false });
    await page.close();
    console.log(`✓ ${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
