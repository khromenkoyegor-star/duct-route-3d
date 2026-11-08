import { formatBytes, formatCount, formatOffsetY, type ScanInfo } from '../core/scan-info';
import { formatMm } from '../core/units';
import { createVersionBadge } from './version-badge';

export interface TitlePanel {
  element: HTMLElement;
  /** Показати інформацію про відкритий скан (null — скану немає). */
  showScan(name: string | null, info: ScanInfo | null): void;
}

/** Назва додатка й інформація про скан — панель зверху зліва. */
export function createTitle(): TitlePanel {
  const panel = document.createElement('header');
  panel.className = 'panel title-panel';
  panel.dataset.testid = 'title';

  const name = document.createElement('h1');
  name.className = 'title';
  name.textContent = 'Траса 3D';

  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = 'Відкрийте скан з Polycam (ZIP з GLTF)';

  const scan = document.createElement('div');
  scan.className = 'scan-info';
  scan.dataset.testid = 'scan-info';
  scan.hidden = true;

  const scanName = document.createElement('p');
  scanName.className = 'scan-name';
  scanName.dataset.testid = 'scan-name';

  // На iPhone подробиці (трикутники, попередження, версія) згортаються — більше місця скану.
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'details-toggle';
  toggle.dataset.testid = 'scan-details-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Докладніше про скан');
  toggle.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  toggle.addEventListener('click', () => {
    const expanded = !panel.classList.contains('title-panel--expanded');
    panel.classList.toggle('title-panel--expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'Згорнути' : 'Докладніше про скан');
  });
  const warningSummary = document.createElement('p');
  warningSummary.className = 'scan-warning-summary';
  warningSummary.dataset.testid = 'scan-warning-summary';
  const scanSize = document.createElement('p');
  scanSize.className = 'scan-row';
  scanSize.dataset.testid = 'scan-size';
  const scanStats = document.createElement('p');
  scanStats.className = 'scan-row scan-row--secondary';
  scanStats.dataset.testid = 'scan-stats';
  const scanOffset = document.createElement('p');
  scanOffset.className = 'scan-row scan-row--secondary';
  scanOffset.dataset.testid = 'scan-offset';
  const warnings = document.createElement('ul');
  warnings.className = 'scan-warnings';
  warnings.dataset.testid = 'scan-warnings';
  scan.append(scanName, scanSize, scanOffset, scanStats, warningSummary, warnings);

  panel.append(toggle, name, subtitle, scan, createVersionBadge());

  return {
    element: panel,
    showScan(fileName, info) {
      const hasScan = !!fileName && !!info;
      scan.hidden = !hasScan;
      subtitle.hidden = hasScan;
      panel.classList.toggle('title-panel--scan', hasScan);
      if (!hasScan) return;
      scanName.textContent = fileName;
      // «Габарит: X 4 000 · Y 2 700 · Z 3 000 мм» — літери осей кольорові, Y — висота.
      const n = (mm: number) => formatMm(mm).replace(/\s*мм$/, '');
      const axis = (letter: string) => {
        const span = document.createElement('span');
        span.className = `axis-letter axis-letter--${letter.toLowerCase()}`;
        span.textContent = letter;
        return span;
      };
      scanSize.replaceChildren(
        'Габарит: ',
        axis('X'),
        ` ${n(info.sizeMm.x)} · `,
        axis('Y'),
        ` ${n(info.sizeMm.y)} · `,
        axis('Z'),
        ` ${n(info.sizeMm.z)} мм`,
      );
      scanOffset.textContent = formatOffsetY(info.offsetYMm);
      const count = info.warnings.length;
      warningSummary.textContent = `⚠︎ ${count} ${plural(count, 'попередження', 'попередження', 'попереджень')}`;
      warningSummary.hidden = count === 0;
      scanStats.textContent =
        `${formatCount(info.triangles)} ${plural(info.triangles, 'трикутник', 'трикутники', 'трикутників')}` +
        ` · ${formatBytes(info.fileBytes)}`;
      warnings.replaceChildren(
        ...info.warnings.map((text) => {
          const item = document.createElement('li');
          item.textContent = text;
          return item;
        }),
      );
      warnings.hidden = info.warnings.length === 0;
    },
  };
}

/** Українська множина: 1 трикутник, 2 трикутники, 5 трикутників. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Підказка про масштаб і осі — панель знизу зліва. */
export function createLegend(gridCellMm: number): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'panel legend-panel';
  panel.dataset.testid = 'legend';

  const scale = document.createElement('p');
  scale.className = 'legend-row';
  scale.textContent = `Клітинка сітки — ${formatMm(gridCellMm)}`;

  const axes = document.createElement('p');
  axes.className = 'legend-row legend-axes';
  for (const [letter, cls, hint] of [
    ['X', 'dot-x', ''],
    ['Y', 'dot-y', ' — вгору'],
    ['Z', 'dot-z', ''],
  ] as const) {
    const item = document.createElement('span');
    item.className = 'legend-axis';
    const dot = document.createElement('span');
    dot.className = `dot ${cls}`;
    dot.setAttribute('aria-hidden', 'true');
    item.append(dot, `${letter}${hint}`);
    axes.append(item);
  }

  panel.append(scale, axes);
  return panel;
}

/** Повідомлення на весь екран, якщо 3D не запустилось. */
export function createFatalMessage(text: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'fatal';
  box.setAttribute('role', 'alert');
  box.textContent = text;
  return box;
}
