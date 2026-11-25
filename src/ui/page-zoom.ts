/**
 * Захист від збільшення сторінки в Safari на iPhone / iPad.
 *
 * Safari ігнорує `user-scalable=no` і дозволяє збільшити сторінку «щипком» або подвійним дотиком.
 * Тоді росте все — джойстик, панелі, кнопки — і програма не вміщається в екран (помилка, яку знайшов
 * Єгор: один палець на джойстику, другий торкнувся панелі). Сцена має власний зум камери, тож
 * масштаб сторінки завжди має бути 1.
 *
 * Захист у кілька шарів:
 * 1. CSS: `touch-action: none` на всіх елементах програми (style.css) — жести не дістаються Safari.
 * 2. Тут: рух кількома пальцями й жести Safari (gesture*) відхиляються; дотик другим пальцем і подвійний
 *    дотик по неінтерактивному місцю (тло панелі, текст) — теж. Кнопки натискаються й другим пальцем.
 * 3. Якщо сторінка все ж збільшилась: пробуємо повернути масштаб самі, а на екрані з'являється
 *    плашка з поясненням; на цей час жести дозволені — сторінку можна зменшити двома пальцями.
 */

/** Сторінка вважається збільшеною, якщо масштаб більший за це. */
const ZOOMED_SCALE = 1.02;
/** Другий дотик не пізніше й не далі за це від першого — подвійний дотик. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 40;

/** Відступ плашки «сторінку збільшено» від країв видимої частини, px екрана. */
const BANNER_MARGIN_PX = 8;

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"]';

export interface PageZoomGuard {
  /** Поточний масштаб сторінки (1 — звичайний). */
  readonly scale: number;
  readonly zoomed: boolean;
  /** Спробувати повернути масштаб 1. */
  reset(): void;
  dispose(): void;
}

interface TouchLike {
  touches?: { length: number };
  changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
}

export function installPageZoomGuard(root: HTMLElement): PageZoomGuard {
  const viewport = window.visualViewport ?? null;
  const html = document.documentElement;
  const scale = () => viewport?.scale ?? 1;
  const zoomed = () => scale() > ZOOMED_SCALE;

  // Плашка «сторінку збільшено» — у видимій частині екрана, звичайного розміру.
  const banner = document.createElement('div');
  banner.className = 'zoom-banner';
  banner.dataset.testid = 'zoom-banner';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  const text = document.createElement('p');
  text.textContent = 'Сторінку збільшено. Зведіть два пальці на екрані або натисніть «Повернути».';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Повернути';
  button.dataset.testid = 'zoom-reset';
  banner.append(text, button);
  root.append(banner);

  // Вирізи екрана (safe areas) — щоб заокруглений кут чи «острівець» iPhone не зрізав плашку.
  // Значення env() у CSS px за масштабу 1, тобто в пікселях екрана — читаємо з невидимого «зонда».
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  root.append(probe);
  const safeArea = () => {
    const style = getComputedStyle(probe);
    const px = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
    return { top: px(style.paddingTop), right: px(style.paddingRight), left: px(style.paddingLeft) };
  };

  let fingers = 0;
  let variant = false;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const original = meta?.content ?? '';

  /**
   * Повернути масштаб 1: Safari перераховує масштаб, коли змінюється meta viewport.
   * Чергуємо два рівнозначні записи (з мінімальним масштабом 1 і без нього) — щоб зміна була справжня.
   */
  const reset = () => {
    if (!meta) return;
    variant = !variant;
    meta.content = variant ? `${original}, minimum-scale=1` : original;
    window.scrollTo(0, 0);
  };

  const sync = () => {
    const isZoomed = zoomed();
    html.classList.toggle('page-zoomed', isZoomed);
    banner.hidden = !isZoomed;
    if (!isZoomed || !viewport) return;
    // Плашка — у лівому верхньому куті видимої частини, не збільшена разом зі сторінкою:
    // відступ 8 px і ширина «екран − 16 px» — у пікселях екрана за будь-якого масштабу.
    const k = 1 / viewport.scale;
    const safe = safeArea();
    const left = BANNER_MARGIN_PX + safe.left;
    const top = BANNER_MARGIN_PX + safe.top;
    const right = BANNER_MARGIN_PX + safe.right;
    banner.style.transform = `translate(${viewport.offsetLeft + left * k}px, ${viewport.offsetTop + top * k}px) scale(${k})`;
    banner.style.width = `${Math.max(0, viewport.width * viewport.scale - left - right)}px`;
  };

  let resetTimer = 0;
  const onViewport = () => {
    sync();
    // Пальці відпущено, а сторінка збільшена — пробуємо повернути самі (раз за зміну).
    if (zoomed() && fingers === 0 && !resetTimer) {
      resetTimer = window.setTimeout(() => {
        resetTimer = 0;
        if (zoomed() && fingers === 0) reset();
      }, 150);
    }
  };

  const onGesture = (event: Event) => {
    // Збільшену сторінку можна зменшити жестом; звичайну — збільшити не можна.
    if (!zoomed()) event.preventDefault();
  };

  const count = (event: Event) => (event as unknown as TouchLike).touches?.length ?? 0;

  const onTouchStart = (event: Event) => {
    fingers = count(event);
    if (fingers < 2 || zoomed() || !event.cancelable) return;
    // Другим пальцем можна натиснути кнопку, поки перший тримає джойстик чи сцену: таке натискання
    // не відхиляємо (інакше кнопка «не спрацює»). Від «щипка» кнопку захищають touch-action
    // і обробник руху нижче.
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE)) return;
    event.preventDefault();
  };
  const onTouchMove = (event: Event) => {
    if (count(event) > 1 && !zoomed() && event.cancelable) event.preventDefault();
  };

  let lastTap: { x: number; y: number; time: number } | null = null;
  const onTouchEnd = (event: Event) => {
    fingers = count(event);
    const touch = (event as unknown as TouchLike).changedTouches?.[0];
    if (!touch || fingers > 0) return;
    const now = performance.now();
    const double =
      !!lastTap && now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < DOUBLE_TAP_PX;
    lastTap = { x: touch.clientX, y: touch.clientY, time: now };
    if (!double || zoomed() || !event.cancelable) return;
    // На кнопках і полях подвійне натискання — це два натискання (їх захищає touch-action).
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE)) return;
    event.preventDefault();
    lastTap = null;
    onViewport();
  };
  const onTouchCancel = (event: Event) => {
    fingers = count(event);
  };

  const gestures = ['gesturestart', 'gesturechange', 'gestureend'] as const;
  for (const type of gestures) document.addEventListener(type, onGesture, { passive: false });
  document.addEventListener('touchstart', onTouchStart, { passive: false });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd, { passive: false });
  document.addEventListener('touchcancel', onTouchCancel, { passive: true });
  viewport?.addEventListener('resize', onViewport);
  viewport?.addEventListener('scroll', onViewport);
  button.addEventListener('click', reset);
  sync();

  return {
    get scale() {
      return scale();
    },
    get zoomed() {
      return zoomed();
    },
    reset,
    dispose() {
      for (const type of gestures) document.removeEventListener(type, onGesture);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
      viewport?.removeEventListener('resize', onViewport);
      viewport?.removeEventListener('scroll', onViewport);
      if (resetTimer) window.clearTimeout(resetTimer);
      html.classList.remove('page-zoomed');
      banner.remove();
      probe.remove();
    },
  };
}
