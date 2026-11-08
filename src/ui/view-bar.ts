/**
 * Кнопки видів X, Y, Z (зверху зліва): камера стає строго вздовж осі —
 * X — вид збоку, Y — згори (план), Z — спереду. Повторне натискання — вид з протилежного боку.
 */
export type ViewAxis = 'X' | 'Y' | 'Z';

export interface ViewBar {
  element: HTMLElement;
}

const TITLES: Record<ViewAxis, string> = {
  X: 'Вид уздовж осі X (збоку). Ще раз — з протилежного боку',
  Y: 'Вид уздовж осі Y (згори). Ще раз — знизу',
  Z: 'Вид уздовж осі Z (спереду). Ще раз — ззаду',
};

export function createViewBar(onView: (axis: ViewAxis) => void): ViewBar {
  const element = document.createElement('nav');
  element.className = 'view-bar';
  element.setAttribute('aria-label', 'Види камери');
  for (const axis of ['X', 'Y', 'Z'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `view-button view-button--${axis.toLowerCase()}`;
    button.dataset.testid = `view-${axis.toLowerCase()}`;
    button.textContent = axis;
    button.setAttribute('aria-label', TITLES[axis]);
    button.addEventListener('click', () => onView(axis));
    element.append(button);
  }
  return { element };
}
