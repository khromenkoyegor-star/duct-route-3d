import { formatBytes, formatCount, formatSizeMm, type ScanInfo } from '../core/scan-info';
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
  const scanSize = document.createElement('p');
  scanSize.className = 'scan-row';
  scanSize.dataset.testid = 'scan-size';
  const scanStats = document.createElement('p');
  scanStats.className = 'scan-row scan-row--secondary';
  scanStats.dataset.testid = 'scan-stats';
  const warnings = document.createElement('ul');
  warnings.className = 'scan-warnings';
  warnings.dataset.testid = 'scan-warnings';
  scan.append(scanName, scanSize, scanStats, warnings);

  panel.append(name, subtitle, scan, createVersionBadge());

  return {
    element: panel,
    showScan(fileName, info) {
      const hasScan = !!fileName && !!info;
      scan.hidden = !hasScan;
      subtitle.hidden = hasScan;
      panel.classList.toggle('title-panel--scan', hasScan);
      if (!hasScan) return;
      scanName.textContent = fileName;
      scanSize.textContent = `Габарит: ${formatSizeMm(info.sizeMm)}`;
      scanStats.textContent = `${formatCount(info.triangles)} трикутників · ${formatBytes(info.fileBytes)}`;
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
