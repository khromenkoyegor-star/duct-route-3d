import { ICON_SHOW_ALL } from './icons';

/**
 * Кнопки видів X, Y, Z (зверху зліва): камера стає строго вздовж осі —
 * X — вид збоку, Y — згори (план), Z — спереду. Повторне натискання — вид з протилежного боку.
 * Кнопка активного виду підсвічена, поки камеру не повернули рукою; на 1,5 с з'являється
 * плашка «Вид згори», «Вид уздовж X · з боку +X» тощо.
 */
export type ViewAxis = 'X' | 'Y' | 'Z';

export type ViewProjection = 'perspective' | 'ortho';

export interface ViewBar {
  element: HTMLElement;
  /** Показати, який вид увімкнено (null — жодного: камеру повернули вручну). */
  setActive(axis: ViewAxis | null, side?: 1 | -1): void;
  /** Показати, яка проекція ввімкнена (кнопка «Орто» підсвічена), і на 1,5 с — плашку з назвою. */
  setProjection(projection: ViewProjection): void;
}

const LABELS: Record<ViewAxis, string> = {
  X: 'Вид уздовж осі X (збоку). Ще раз — з протилежного боку',
  Y: 'Вид уздовж осі Y (згори). Ще раз — знизу',
  Z: 'Вид уздовж осі Z (спереду). Ще раз — ззаду',
};

/** Текст плашки: який вид і з якого боку дивимось. */
export function viewCaption(axis: ViewAxis, side: 1 | -1): string {
  if (axis === 'Y') return side > 0 ? 'Вид згори (уздовж Y)' : 'Вид знизу (уздовж Y)';
  return `Вид уздовж ${axis} · з боку ${side > 0 ? '+' : '−'}${axis}`;
}

const TOAST_MS = 1500;

/**
 * onShowAll — кнопка «Показати все» в цьому ж блоці: видно лише на iPhone вертикально, поки
 * доводять точку (тоді нижня панель кнопок схована — там джойстик; див. style.css).
 * onProjection — кнопка «Орто»: ортогональна проекція (без перспективи, як на кресленні) ↔ перспектива.
 */
export function createViewBar(onView: (axis: ViewAxis) => void, onShowAll?: () => void, onProjection?: () => void): ViewBar {
  const element = document.createElement('div');
  element.className = 'view-area';

  const bar = document.createElement('nav');
  bar.className = 'view-bar';
  bar.setAttribute('aria-label', 'Види камери');
  const buttons = new Map<ViewAxis, HTMLButtonElement>();
  for (const axis of ['X', 'Y', 'Z'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `view-button view-button--${axis.toLowerCase()}`;
    button.dataset.testid = `view-${axis.toLowerCase()}`;
    button.textContent = axis;
    button.setAttribute('aria-label', LABELS[axis]);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => onView(axis));
    buttons.set(axis, button);
    bar.append(button);
  }

  let ortho: HTMLButtonElement | null = null;
  if (onProjection) {
    ortho = document.createElement('button');
    ortho.type = 'button';
    ortho.className = 'view-button view-button--ortho';
    ortho.dataset.testid = 'view-ortho';
    ortho.textContent = 'Орто';
    ortho.setAttribute('aria-label', 'Ортогональна проекція — без перспективи, як на кресленні. Ще раз — перспектива');
    ortho.setAttribute('aria-pressed', 'false');
    ortho.addEventListener('click', onProjection);
    bar.append(ortho);
  }

  if (onShowAll) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'view-button view-button--all';
    all.dataset.testid = 'view-all';
    all.innerHTML = ICON_SHOW_ALL;
    all.setAttribute('aria-label', 'Показати все');
    all.addEventListener('click', onShowAll);
    bar.append(all);
  }

  const toast = document.createElement('p');
  toast.className = 'view-toast';
  toast.dataset.testid = 'view-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.hidden = true;
  let toastTimer = 0;

  element.append(bar, toast);

  const showToast = (text: string | null) => {
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = 0;
    if (!text) {
      toast.hidden = true;
      return;
    }
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
      toastTimer = 0;
    }, TOAST_MS);
  };

  return {
    element,
    setActive(axis, side = 1) {
      for (const [name, button] of buttons) {
        const on = name === axis;
        button.classList.toggle('view-button--active', on);
        button.setAttribute('aria-pressed', String(on));
      }
      showToast(axis ? viewCaption(axis, side) : null);
    },
    setProjection(projection) {
      const on = projection === 'ortho';
      ortho?.classList.toggle('view-button--active', on);
      ortho?.setAttribute('aria-pressed', String(on));
      showToast(on ? 'Ортогональна проекція' : 'Перспектива');
    },
  };
}
