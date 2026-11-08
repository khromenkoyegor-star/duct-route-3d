import { formatMm } from '../core/units';
import { createVersionBadge } from './version-badge';

/** Назва додатка — панель зверху зліва. */
export function createTitle(): HTMLElement {
  const panel = document.createElement('header');
  panel.className = 'panel title-panel';
  panel.dataset.testid = 'title';

  const name = document.createElement('h1');
  name.className = 'title';
  name.textContent = 'Траса 3D';

  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = 'Порожня сцена · скан відкриватиметься на етапі 1';

  panel.append(name, subtitle, createVersionBadge());
  return panel;
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
