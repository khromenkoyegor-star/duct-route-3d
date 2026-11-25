/**
 * Редактор точки: точне доведення поставленої точки перед підтвердженням.
 * Використовується в «Рулетці», а далі — для точок траси (етапи 2–3).
 *
 * - Джойстик рухає точку по X або Z (вісь — за напрямком стрілок біля точки на екрані,
 *   фіксується до відпускання; по діагоналі точка не їде ніколи).
 * - Повзунок рухає точку тільки по Y.
 * - Біля точки — стрілки осей X (червона), Y (зелена), Z (синя); активна підсвічується.
 * - Координати точки й зсув від місця, де її поставили, — у мм.
 * - «Підтвердити точку» завершує редагування.
 * Камеру можна вільно крутити: точка від цього не зсувається.
 *
 * Режим «відрізок від точки» (наступна точка траси): точка стартує в попередньому вузлі (`anchor`)
 * і тягнеться лише по одній осі (core/route.ts → stepAlongSegment). Вісь вибирає перший рух;
 * повернувши точку на початок, вісь можна змінити. Назад по попередньому відрізку — не можна.
 * Замість «Зсув» — довжина відрізка; відрізок нульової довжини не підтверджується.
 *
 * Поворот 45° (етап 4.1): точку тягнуть по основній осі, потім кнопкою «45°» вибирають другу вісь
 * і бік зміщення — відрізок стає діагональним (зміщення по обох осях однакові), і той самий джойстик
 * чи повзунок тягне точку вздовж діагоналі. Ще раз «45°» — знову прямо. Між сусідніми відрізками —
 * лише 45° або 90°: у заборонений бік точка не рухається.
 */
import {
  createStickController,
  diagonalScreenDirection,
  diagonalStep,
  joystickLayout,
  movePoint,
  type HorizontalAxis,
  type NudgeAxis,
  type PointM,
  sliderStep,
  type Vec2,
} from '../core/nudge';
import {
  canAppendNode,
  type DiagonalChoice,
  diagonalOptions,
  distance,
  headingUnit,
  lockedAxis,
  type P3,
  stepAlongSegment,
  turnAllowed,
} from '../core/route';
import { formatMm, mmToM, mToMm } from '../core/units';
import type { Viewer } from '../scene/viewer';
import { createStick } from './joystick';
import { followArea, type ScreenRect } from './visibility';

export interface PointEditorState {
  active: boolean;
  /** Підпис точки («А», «Б», «1»…). */
  label: string | null;
  point: PointM | null;
  /** Де точку поставили (до доведення). */
  origin: PointM | null;
  /** Вісь, по якій точка рухається просто зараз. */
  axis: NudgeAxis | null;
  /** Чи точку вже підсували після постановки. */
  moved: boolean;
  /**
   * Режим «відрізок від точки»: початок, основна вісь відрізка (null — точка ще на початку),
   * довжина в мм і друга вісь у режимі 45° (null — відрізок прямий).
   */
  segment: { anchor: PointM; axis: NudgeAxis | null; lengthMm: number; diagonal: DiagonalChoice | null } | null;
  /** Чи можна зараз підтвердити точку (відрізок нульової довжини — не можна). */
  canConfirm: boolean;
}

/** Стан закритого редактора. */
export function closedEditorState(): PointEditorState {
  return { active: false, label: null, point: null, origin: null, axis: null, moved: false, segment: null, canConfirm: false };
}

/** Наступна точка траси: тягнеться від попереднього вузла по осі або під 45°. */
export interface SegmentOptions {
  /** Попередній вузол (м сцени). */
  anchor: PointM;
  /**
   * Напрямок попереднього відрізка (одиничний вектор; null — це перший відрізок):
   * новий відрізок може йти лише прямо, під 45° або 90° до нього.
   */
  previous: P3 | null;
}

export interface EditOptions {
  /** Заголовок над координатами (інакше «Точка {label}»). */
  title?: string;
  segment?: SegmentOptions;
}

export interface PointEditor {
  /** Кнопки: джойстик, повзунок Y, «Підтвердити точку», координати. */
  element: HTMLElement;
  /** Стрілки осей біля точки. */
  overlay: HTMLElement;
  readonly state: PointEditorState;
  /**
   * Почати доведення точки (або замінити точку, якщо редагування вже йде).
   * Редактор один на всі інструменти: `handlers` — того інструмента, що зараз доводить точку.
   * Якщо в цю мить ще тримають джойстик чи повзунок, нова точка від цього утримання не поїде.
   */
  edit(point: PointM, label: string, handlers: PointEditorHandlers, options?: EditOptions): void;
  /** Чи редактор зараз доводить точку саме для цього інструмента. */
  ownedBy(handlers: PointEditorHandlers): boolean;
  /**
   * Коротке пояснення біля джойстика (замість рядка «Відрізок / Зсув») — на кілька секунд
   * або доки точку не зрушать. wiggle — «посмикати» кульки джойстика й повзунка: тягнути — ними.
   */
  notice(text: string, options?: { wiggle?: boolean }): void;
  close(): void;
  dispose(): void;
}

export interface PointEditorHandlers {
  onChange(point: PointM): void;
  onConfirm(point: PointM): void;
  /** Джойстик/повзунок відпустили (можна перевірити, чи точку видно). */
  onSettle?(point: PointM): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Стрілка «вправо» на варіанті вибору 45° (повертається так, як діагональ піде на екрані). */
const DIAG_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 8h10M8.5 4l4 4-4 4" fill="none" ' +
  'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW_PX = 64;
const ARROW_GAP_PX = 16;
/** Мілісекунди в секунді (час кадрів) — не плутати з мм ↔ м, ті лише в units.ts. */
const MS_PER_SECOND = 1_000;
const AXES: NudgeAxis[] = ['X', 'Y', 'Z'];
/**
 * Точка повернулась на початок відрізка — коротка зупинка («клацання»): можна відпустити
 * й вибрати іншу вісь. Тримаєш далі — точка йде на інший бік по тій самій осі.
 */
const ANCHOR_DETENT_MS = 400;

const samePoint = (a: PointM, b: PointM) => a.x === b.x && a.y === b.y && a.z === b.z;
/** Скільки триває пояснення біля джойстика (notice), мс. */
const NOTICE_MS = 4000;
const AXIS_KEY: Record<NudgeAxis, 'x' | 'y' | 'z'> = { X: 'x', Y: 'y', Z: 'z' };

/** «X 1 234,5 · Y 1 200 · Z −300 мм» з кольоровими літерами. */
function coordinates(point: PointM): Array<string | HTMLElement> {
  const parts: Array<string | HTMLElement> = [];
  const values: Record<NudgeAxis, number> = { X: point.x, Y: point.y, Z: point.z };
  AXES.forEach((axis, i) => {
    const letter = document.createElement('span');
    letter.className = `axis-letter axis-letter--${axis.toLowerCase()}`;
    letter.textContent = axis;
    const text = formatMm(mToMm(values[axis])).replace(/\s*мм$/, '');
    parts.push(letter, ` ${text}${i < 2 ? ' · ' : ' мм'}`);
  });
  return parts;
}

export function createPointEditor(viewer: Viewer): PointEditor {
  const element = document.createElement('div');
  element.className = 'point-editor';
  element.dataset.testid = 'point-editor';
  element.hidden = true;

  const readout = document.createElement('div');
  readout.className = 'point-readout';
  const title = document.createElement('p');
  title.className = 'point-title';
  title.dataset.testid = 'point-title';
  const coords = document.createElement('p');
  coords.className = 'point-coords';
  coords.dataset.testid = 'point-coords';
  const shift = document.createElement('p');
  shift.className = 'point-shift';
  shift.dataset.testid = 'point-shift';
  readout.append(title, coords, shift);

  const controls = document.createElement('div');
  controls.className = 'point-controls';

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'confirm-button';
  confirm.dataset.testid = 'confirm-point';
  confirm.textContent = 'Підтвердити точку';

  /** Інструмент, для якого зараз доводять точку (null — редактор закрито). */
  let handlers: PointEditorHandlers | null = null;
  let point: PointM | null = null;
  let origin: PointM | null = null;
  let label: string | null = null;
  let customTitle: string | null = null;
  let axis: NudgeAxis | null = null;
  let segment: SegmentOptions | null = null;
  /** Тягнуть у заборонений бік (назад чи під гострим кутом) — точка стоїть, підказуємо чому. */
  let blockedBack: 'back' | 'turn' | false = false;
  /** Режим 45°: основна вісь і вибрана друга вісь з боком (null — відрізок прямий). */
  let diagonal: { main: NudgeAxis; choice: DiagonalChoice } | null = null;
  /** Чи відкрито вибір другої осі для 45°. */
  let pickerOpen = false;
  /** Стрілки на варіантах вибору 45° (повертаються разом з камерою). */
  let pickerIcons: Array<{ icon: HTMLElement; choice: DiagonalChoice }> = [];
  /** До цього часу точка «стоїть» на початку відрізка (див. ANCHOR_DETENT_MS). */
  let detentUntil = 0;
  /** Пояснення біля джойстика (notice) і таймер, що його прибирає. */
  let noticeText: string | null = null;
  let noticeTimer = 0;
  const clearNotice = () => {
    noticeText = null;
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = 0;
  };
  const controller = createStickController();

  /** Основна вісь, по якій уже йде відрізок (null — не режим відрізка або точка на початку). */
  const segmentAxis = (): NudgeAxis | null => {
    if (!segment || !point) return null;
    return diagonal ? diagonal.main : lockedAxis(segment.anchor, point);
  };
  const segmentLengthMm = () => (segment && point ? mToMm(distance(segment.anchor, point)) : 0);
  const canConfirm = () =>
    !!point && (!segment || (segmentAxis() !== null && canAppendNode(segment.anchor, point, segment.previous)));
  /** Точка повернулась на початок відрізка — режим 45° і вибір другої осі скидаються. */
  const resetDiagonal = () => {
    diagonal = null;
    pickerOpen = false;
  };

  /**
   * Режим 45°: куди на екрані рухається точка, коли основна координата зростає (сума стрілок двох осей).
   * null — не режим 45°.
   */
  const diagonalOnScreen = (screen: Record<NudgeAxis, Vec2>): Vec2 | null => {
    if (!diagonal || !segment || !point) return null;
    return diagonalScreenDirection(screen[diagonal.main], screen[diagonal.choice.axis], diagonalSide(), diagonal.choice.sign);
  };

  /**
   * Чи діють зараз джойстик (X, Z) і повзунок (Y). Прямий відрізок: по Y — лише повзунок, по X чи Z —
   * лише джойстик. Діагональ 45°: джойстик веде вздовж неї завжди (у ній завжди є X чи Z), повзунок —
   * якщо в ній є Y (підйом чи опуск); тоді однаково, з якої осі почали.
   */
  const controlsUsable = (): { stick: boolean; slider: boolean } => {
    if (diagonal) return { stick: true, slider: diagonal.main === 'Y' || diagonal.choice.axis === 'Y' };
    const locked = segmentAxis();
    return { stick: locked !== 'Y', slider: locked === null || locked === 'Y' };
  };

  /** Режим 45°: з якого боку від початку відрізка точка по основній осі (1 чи −1). */
  const diagonalSide = (): 1 | -1 => {
    if (!diagonal || !segment || !point) return 1;
    const key = AXIS_KEY[diagonal.main];
    return point[key] >= segment.anchor[key] ? 1 : -1;
  };

  /** Зсунути точку на крок; true — точка змінилась. */
  const apply = (stepAxis: NudgeAxis, deltaMm: number, now: number): boolean => {
    if (!point) return false;
    if (!segment) {
      point = movePoint(point, stepAxis, deltaMm);
      return true;
    }
    if (now < detentUntil) return false;
    const choice = diagonal?.choice ?? null;
    const next = stepAlongSegment(segment.anchor, point, stepAxis, mmToM(deltaMm), segment.previous, choice);
    const atAnchor = samePoint(next, segment.anchor);
    // Точка стоїть на початку, бо в цей бік поворот заборонений (назад, 135°, 60°…)?
    blockedBack = false;
    if (atAnchor && segment.previous && deltaMm !== 0) {
      const wanted = headingUnit([{ axis: stepAxis, sign: deltaMm > 0 ? 1 : -1 }, ...(choice ? [choice] : [])]);
      if (!turnAllowed(segment.previous, wanted)) {
        const dot = segment.previous.x * wanted.x + segment.previous.y * wanted.y + segment.previous.z * wanted.z;
        blockedBack = dot < -0.99 ? 'back' : 'turn';
      }
    }
    if (samePoint(next, point)) return false;
    if (atAnchor) {
      detentUntil = now + ANCHOR_DETENT_MS;
      resetDiagonal();
    }
    point = next;
    return true;
  };

  // Цикл анімації працює лише поки джойстик чи повзунок утримують.
  // Рух рахується за реальним часом (performance.now), а не за кількістю кадрів:
  // якщо браузер малює рідко, точка все одно проходить стільки, скільки тримали.
  let frame = 0;
  let lastTime = 0;
  let followRect: ScreenRect | null = null;
  const integrate = (now: number) => {
    const dt = lastTime ? (now - lastTime) / MS_PER_SECOND : 0;
    lastTime = now;
    if (!point) return;
    let changed = false;
    // Де точка на екрані до цього кроку: далі від видимої частини екрана, ніж зараз, вона не піде.
    const screenBefore = followRect ? viewer.projectPoint(point) : null;
    const locked = segmentAxis();
    const usable = controlsUsable();
    if (stick.active && usable.stick) {
      const screen = viewer.screenAxes(point);
      const along = diagonalOnScreen(screen);
      if (along && diagonal) {
        // Режим 45°: джойстик веде точку вздовж діагоналі так, як вона йде на екрані.
        axis = diagonal.main;
        stick.setKnobAxis('45°');
        const deltaMm = diagonalStep(stick.value, along, dt);
        if (deltaMm !== 0) changed = apply(diagonal.main, deltaMm, now);
      } else {
        const only = locked === 'X' || locked === 'Z' ? locked : null;
        const step = controller.update(stick.value, { X: screen.X, Z: screen.Z }, dt, only);
        axis = controller.axis;
        stick.setKnobAxis(axis);
        if (step) changed = apply(step.axis, step.deltaMm, now);
      }
    } else if (slider.active && usable.slider) {
      // Одночасно — лише одна вісь: джойстик має перевагу, повзунок — коли джойстик вільний.
      const step = sliderStep(-slider.value.y, dt);
      if (step) {
        slider.setKnobAxis(diagonal ? '45°' : 'Y');
        if (diagonal && diagonal.main !== 'Y') {
          // Діагональ з Y як другою віссю: повзунок угору — точка вгору вздовж діагоналі
          // (висота змінюється рівно на стільки ж, на скільки хід по основній осі).
          axis = diagonal.main;
          changed = apply(diagonal.main, step.deltaMm * diagonal.choice.sign * diagonalSide(), now);
        } else {
          axis = 'Y';
          changed = apply(step.axis, step.deltaMm, now);
        }
      }
    }
    if (changed) {
      clearNotice();
      // Камера їде за точкою: до середини екрана точка рухається вільно, від нього — камера зсувається.
      if (followRect && screenBefore?.visible) {
        viewer.followPoint(point, {
          left: Math.min(followRect.left, screenBefore.x),
          right: Math.max(followRect.right, screenBefore.x),
          top: Math.min(followRect.top, screenBefore.y),
          bottom: Math.max(followRect.bottom, screenBefore.y),
        });
      }
      handlers?.onChange(point);
      viewer.requestRender();
    }
    render();
  };
  const loop = () => {
    integrate(performance.now());
    if (stick.active || slider.active) frame = requestAnimationFrame(loop);
    else stopLoop();
  };
  const startLoop = () => {
    if (frame) return;
    // Де тримати точку на екрані, поки її тягнуть (панелі під час утримання не рухаються).
    followRect = followArea();
    lastTime = performance.now();
    frame = requestAnimationFrame(loop);
  };
  const stopLoop = (settle = true) => {
    const wasRunning = frame !== 0 && settle;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    controller.release();
    axis = null;
    blockedBack = false;
    detentUntil = 0;
    stick.setKnobAxis(null);
    slider.setKnobAxis(null);
    render();
    if (wasRunning && point) handlers?.onSettle?.(point);
  };

  const stick = createStick({
    mode: '2d',
    label: 'Джойстик: зсув точки по X або Z',
    testid: 'stick-xz',
    onActiveChange(isActive) {
      if (isActive) {
        if (!controlsUsable().stick) {
          showNotice('Джойстик зараз не діє: відрізок іде по Y. Щоб змінити вісь, поверніть точку на початок');
        }
        startLoop();
        return;
      }
      // Відпустили джойстик: дорахувати рух до цієї миті й зняти фіксацію осі —
      // навіть якщо повзунок ще тримають.
      integrate(performance.now());
      controller.release();
      axis = null;
      blockedBack = false;
      detentUntil = 0;
      stick.setKnobAxis(null);
      if (!slider.active) stopLoop();
      else render();
    },
  });
  const slider = createStick({
    mode: 'vertical',
    label: 'Повзунок: зсув точки по висоті Y',
    testid: 'stick-y',
    onActiveChange(isActive) {
      if (isActive) {
        const locked = segmentAxis();
        if (!controlsUsable().slider) {
          showNotice(
            diagonal
              ? 'Повзунок зараз не діє: відрізок 45° у горизонталі — тягніть джойстиком уздовж помаранчевої стрілки'
              : `Повзунок зараз не діє: відрізок іде по ${locked}. Щоб змінити вісь, поверніть точку на початок`,
          );
        }
        startLoop();
        return;
      }
      integrate(performance.now());
      // Відпустили повзунок: його рух закінчився (у режимі 45° вісь — основна, а не Y).
      if (axis === 'Y' || (diagonal && !stick.active)) axis = null;
      blockedBack = false;
      detentUntil = 0;
      slider.setKnobAxis(null);
      if (!stick.active) stopLoop();
      else render();
    },
  });
  // Кнопка «45°» над «Підтвердити точку» (лише для відрізків траси) і вибір другої осі під координатами.
  const diagButton = document.createElement('button');
  diagButton.type = 'button';
  diagButton.className = 'diag-button';
  diagButton.dataset.testid = 'segment-45';
  diagButton.textContent = '45°';
  diagButton.setAttribute('aria-pressed', 'false');
  diagButton.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'point-actions';
  actions.append(diagButton, confirm);
  const picker = document.createElement('div');
  picker.className = 'diag-picker';
  picker.dataset.testid = 'segment-45-picker';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Куди зміщення під 45°');
  picker.hidden = true;
  controls.append(stick.element, slider.element, actions);
  element.append(readout, picker, controls);

  /** Точку пересунуто кнопкою (не джойстиком): повідомити інструмент і перевірити, чи її видно. */
  const moved = () => {
    if (!point) return;
    clearNotice();
    handlers?.onChange(point);
    viewer.requestRender();
    render();
    handlers?.onSettle?.(point);
  };

  diagButton.addEventListener('click', () => {
    if (!segment || !point) return;
    const main = segmentAxis();
    if (diagonal) {
      // Ще раз «45°» — відрізок знову прямий: лишається хід по основній осі.
      const key = AXIS_KEY[diagonal.main];
      point = { ...segment.anchor, [key]: point[key] };
      resetDiagonal();
      moved();
      return;
    }
    if (!main) {
      pickerOpen = false;
      showNotice('Спершу потягніть точку по основній осі, потім натисніть «45°»', true);
      return;
    }
    pickerOpen = !pickerOpen;
    clearNotice();
    render();
    // Панель стала вищою (рядок вибору) — точка не має опинитись під нею: зсуваємо камеру, без повороту.
    const area = pickerOpen ? followArea() : null;
    // Камера зсунулась — стрілки на варіантах одразу під новий вигляд (а не з наступним кадром).
    if (area && viewer.followPoint(point, area)) render();
  });

  /** Вибрали другу вісь: відрізок стає діагональним — зміщення по ній дорівнює ходу по основній. */
  const chooseDiagonal = (main: NudgeAxis, choice: DiagonalChoice) => {
    if (!segment || !point) return;
    const next = stepAlongSegment(segment.anchor, point, main, 0, segment.previous, choice);
    if (samePoint(next, segment.anchor)) return;
    diagonal = { main, choice };
    pickerOpen = false;
    point = next;
    moved();
  };

  const optionLabel = (choice: DiagonalChoice) =>
    choice.axis === 'Y' ? (choice.sign > 0 ? 'Y вгору' : 'Y вниз') : `${choice.axis}${choice.sign > 0 ? '+' : '−'}`;

  /** Перемалювати вибір другої осі (чотири варіанти: дві інші осі × два боки). */
  const renderPicker = (main: NudgeAxis | null) => {
    const open = pickerOpen && !!segment && !!point && !!main && !diagonal;
    picker.hidden = !open;
    if (!open || !segment || !point || !main) {
      picker.replaceChildren();
      return;
    }
    const sign = point[AXIS_KEY[main]] >= segment.anchor[AXIS_KEY[main]] ? 1 : -1;
    const caption = document.createElement('span');
    caption.className = 'diag-picker-caption';
    caption.textContent = '45° у бік:';
    // Порядок сталий: спершу горизонтальні варіанти, «Y вгору» і «Y вниз» — завжди в кінці.
    const options = diagonalOptions(main, sign, segment.previous).sort(
      (a, b) => Number(a.axis === 'Y') - Number(b.axis === 'Y'),
    );
    pickerIcons = [];
    const buttons = options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `diag-option diag-option--${option.axis.toLowerCase()}`;
      button.dataset.testid = `segment-45-${option.axis.toLowerCase()}-${option.sign > 0 ? 'plus' : 'minus'}`;
      // Маленька стрілка — куди піде діагональ на екрані з цим варіантом (повертається з камерою).
      const icon = document.createElement('span');
      icon.className = 'diag-option-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = DIAG_ICON;
      const text = document.createElement('span');
      text.textContent = optionLabel(option);
      button.append(icon, text);
      button.setAttribute('aria-label', `45° у бік ${optionLabel(option)}`);
      // Недоступний варіант — сірий, але натискається: пояснює, чому не можна (наведення курсору на iPad
      // з пальцем немає, тож пояснення лише в підказці-«title» не видно).
      if (!option.allowed) button.setAttribute('aria-disabled', 'true');
      button.addEventListener('click', () => {
        if (!option.allowed) {
          showNotice('Такий поворот не можна: лише 45° або 90° до попереднього відрізка', true);
          return;
        }
        chooseDiagonal(main, { axis: option.axis, sign: option.sign });
      });
      pickerIcons.push({ icon, choice: { axis: option.axis, sign: option.sign } });
      return button;
    });
    picker.replaceChildren(caption, ...buttons);
    rotatePickerIcons(viewer.screenAxes(point), main, sign);
  };

  /** Повернути стрілки на варіантах вибору 45° так, як діагональ піде на екрані. */
  const rotatePickerIcons = (screen: Record<NudgeAxis, Vec2>, main: NudgeAxis, side: 1 | -1) => {
    for (const { icon, choice } of pickerIcons) {
      const m = screen[main];
      const o = screen[choice.axis];
      const dir = { x: side * m.x + choice.sign * o.x, y: side * m.y + choice.sign * o.y };
      const longest = Math.max(Math.hypot(m.x, m.y), Math.hypot(o.x, o.y));
      // Діагональ «у камеру» (на екрані майже точка) — без стрілки.
      const visible = longest > 0 && Math.hypot(dir.x, dir.y) >= longest * 0.15;
      icon.style.visibility = visible ? '' : 'hidden';
      if (visible) icon.style.transform = `rotate(${Math.atan2(dir.y, dir.x)}rad)`;
    }
  };

  // Стрілки осей біля точки.
  const overlay = document.createElement('div');
  overlay.className = 'axis-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'axis-svg');
  overlay.append(svg);
  const arrows = AXES.map((name) => {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', `axis-arrow axis-arrow--${name.toLowerCase()}`);
    const line = document.createElementNS(SVG_NS, 'line');
    const head = document.createElementNS(SVG_NS, 'polygon');
    const text = document.createElementNS(SVG_NS, 'text');
    text.textContent = name;
    group.append(line, head, text);
    svg.append(group);
    return { name, group, line, head, text };
  });
  // Режим 45°: одна виразна стрілка «45°» уздовж діагоналі — туди, куди точка йде на екрані
  // (і куди веде джойстик); стрілки двох осей тоді бліді.
  const diagArrow = (() => {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'axis-arrow axis-arrow--diag axis-arrow--active');
    group.setAttribute('data-testid', 'axis-arrow-45');
    const line = document.createElementNS(SVG_NS, 'line');
    const head = document.createElementNS(SVG_NS, 'polygon');
    const text = document.createElementNS(SVG_NS, 'text');
    text.textContent = '45°';
    group.append(line, head, text);
    group.style.display = 'none';
    svg.append(group);
    return { group, line, head, text };
  })();

  /** Намалювати стрілку від точки `base` (px екрана) в напрямку (ux, uy) — одиничному. */
  const placeArrow = (
    parts: { line: SVGLineElement; head: SVGPolygonElement; text: SVGTextElement },
    base: Vec2,
    ux: number,
    uy: number,
    labelGap = 16,
  ) => {
    const tipX = base.x + ux * ARROW_PX;
    const tipY = base.y + uy * ARROW_PX;
    // Без «хвоста» за точкою й з відступом від неї — місце виміру не закрите.
    parts.line.setAttribute('x1', String(base.x + ux * ARROW_GAP_PX));
    parts.line.setAttribute('y1', String(base.y + uy * ARROW_GAP_PX));
    parts.line.setAttribute('x2', String(tipX));
    parts.line.setAttribute('y2', String(tipY));
    const side = 6;
    const back = 12;
    parts.head.setAttribute(
      'points',
      `${tipX + ux * 4},${tipY + uy * 4} ${tipX - ux * back - uy * side},${tipY - uy * back + ux * side} ` +
        `${tipX - ux * back + uy * side},${tipY - uy * back - ux * side}`,
    );
    parts.text.setAttribute('x', String(tipX + ux * labelGap));
    parts.text.setAttribute('y', String(tipY + uy * labelGap + 5));
  };

  /** Режим 45° (будь-яка основна вісь): напрямок діагоналі на екрані геть від початку відрізка. */
  const diagonalForward = (screen: Record<NudgeAxis, Vec2>): Vec2 | null => {
    if (!diagonal || !segment || !point) return null;
    const key = AXIS_KEY[diagonal.main];
    const side = point[key] >= segment.anchor[key] ? 1 : -1;
    const main = screen[diagonal.main];
    const other = screen[diagonal.choice.axis];
    const k = diagonal.choice.sign;
    return { x: side * main.x + k * other.x, y: side * main.y + k * other.y };
  };

  const drawArrows = () => {
    if (!point || element.hidden) {
      overlay.hidden = true;
      return;
    }
    const screen = viewer.screenAxes(point);
    // Підсвічуємо вісь, по якій точка рухається зараз або по якій уже йде відрізок.
    const shown = axis ?? segmentAxis();
    // Стрілки на самому джойстику — куди він рухає X і Z (з урахуванням «розведення» осей).
    const layout = joystickLayout({ X: screen.X, Z: screen.Z });
    const along = diagonalOnScreen(screen);
    if (along && diagonal) {
      // Режим 45°: на джойстику одна лінія «45°» — уздовж діагоналі, підпис з того боку, куди точка
      // йде геть від початку відрізка (як помаранчева стрілка біля точки).
      const side = diagonalSide();
      const l = Math.hypot(along.x, along.y);
      const key: HorizontalAxis = diagonal.main === 'Y' ? (diagonal.choice.axis as HorizontalAxis) : diagonal.main;
      stick.setAxes({ ...layout.dirs, [key]: { x: (side * along.x) / l, y: (side * along.y) / l } }, key, null, true);
    } else {
      stick.setAxes(controller.dirs ?? layout.dirs, shown === 'X' || shown === 'Z' ? shown : null, layout.layout.depth ?? null);
    }
    const base = viewer.projectPoint(point);
    overlay.hidden = !base.visible;
    if (!base.visible) return;
    const longest = Math.max(...AXES.map((a) => Math.hypot(screen[a].x, screen[a].y)));
    const locked = segmentAxis();
    const second = diagonal?.choice ?? null;
    if (!picker.hidden && segment && pickerIcons.length > 0) {
      const main = segmentAxis();
      if (main) rotatePickerIcons(screen, main, point[AXIS_KEY[main]] >= segment.anchor[AXIS_KEY[main]] ? 1 : -1);
    }
    const forward = diagonalForward(screen);
    const forwardLen = forward ? Math.hypot(forward.x, forward.y) : 0;
    const diagVisible = !!forward && forwardLen > 0 && forwardLen >= longest * 0.15;
    diagArrow.group.style.display = diagVisible ? '' : 'none';
    if (forward && diagVisible) placeArrow(diagArrow, base, forward.x / forwardLen, forward.y / forwardLen, 22);
    for (const arrow of arrows) {
      let dir: Vec2 = screen[arrow.name];
      // Відрізок уже йде по цій осі: стрілка — в бік руху, геть від початку відрізка
      // (інакше вона лягає на сам відрізок і закриває його й підпис довжини).
      if (segment && locked === arrow.name && point[AXIS_KEY[locked]] < segment.anchor[AXIS_KEY[locked]]) {
        dir = { x: -dir.x, y: -dir.y };
      }
      // Режим 45°: стрілка другої осі — у вибраний бік.
      if (second && second.axis === arrow.name && second.sign < 0) dir = { x: -dir.x, y: -dir.y };
      const len = Math.hypot(dir.x, dir.y);
      // Вісь, що «дивиться в камеру», не малюємо — по ній джойстик і не рухає.
      const visible = len > 0 && len >= longest * 0.15;
      arrow.group.style.display = visible ? '' : 'none';
      if (!visible) continue;
      placeArrow(arrow, base, dir.x / len, dir.y / len);
      // Режим 45° зі стрілкою діагоналі: стрілки осей лише підказують, з чого вона складається, — бліді.
      const active = !diagVisible && (shown === arrow.name || second?.axis === arrow.name);
      arrow.group.classList.toggle('axis-arrow--active', active);
      arrow.group.classList.toggle('axis-arrow--dim', (shown !== null || diagVisible) && !active);
    }
  };
  const stopFrames = viewer.onFrame(drawArrows);

  function render(): void {
    if (!point || !origin) return;
    title.textContent = customTitle ?? `Точка ${label ?? ''}`.trim();
    confirm.textContent = `Підтвердити точку ${label ?? ''}`.trim();
    confirm.disabled = !canConfirm();
    coords.replaceChildren(...coordinates(point));
    const locked = segmentAxis();
    const usable = controlsUsable();
    for (const [control, off] of [
      [stick.element, !usable.stick],
      [slider.element, !usable.slider],
    ] as const) {
      control.classList.toggle('stick--off', off);
      control.setAttribute('aria-disabled', String(off));
    }
    shift.classList.toggle('point-shift--warning', noticeText !== null || (segment !== null && blockedBack !== false));
    // «45°» — лише для відрізків траси; підсвічена, коли відрізок діагональний.
    diagButton.hidden = !segment;
    diagButton.setAttribute('aria-pressed', String(!!diagonal));
    diagButton.classList.toggle('diag-button--on', !!diagonal);
    // Точка ще на початку відрізка — «45°» бліда (натискання лише підкаже, що спершу потягти по осі).
    diagButton.classList.toggle('diag-button--idle', !!segment && !diagonal && !locked);
    // Увімкнено: видно й вибраний бік — «45° · Z+».
    diagButton.textContent = diagonal ? `45° · ${optionLabel(diagonal.choice)}` : '45°';
    diagButton.setAttribute(
      'aria-label',
      diagonal ? `Поворот 45° у бік ${optionLabel(diagonal.choice)} увімкнено. Натисніть, щоб відрізок став прямим` : 'Поворот під 45°',
    );
    renderPicker(locked);
    if (noticeText) {
      shift.textContent = noticeText;
      drawArrows();
      return;
    }
    if (segment) {
      shift.textContent = segmentText(locked);
      drawArrows();
      return;
    }
    const moved: string[] = [];
    const deltas: Record<NudgeAxis, number> = {
      X: mToMm(point.x - origin.x),
      Y: mToMm(point.y - origin.y),
      Z: mToMm(point.z - origin.z),
    };
    for (const a of AXES) {
      if (Math.abs(deltas[a]) >= 0.05) moved.push(`${a} ${deltas[a] > 0 ? '+' : ''}${formatMm(deltas[a])}`);
    }
    shift.textContent = moved.length ? `Зсув: ${moved.join(' · ')}` : 'Зсув: немає';
    drawArrows();
  }

  /** «Відрізок: X +1 250 мм», «Відрізок 45°: X +1 000 · Z +1 000 = 1 414,2 мм» або підказка на початку. */
  function segmentText(locked: NudgeAxis | null): string {
    if (blockedBack === 'back') return 'Назад по попередньому відрізку не можна';
    if (blockedBack === 'turn') return 'Такий поворот не можна: лише 45° або 90°';
    if (!segment || !point || !locked) return 'Тягніть джойстиком (X, Z) чи повзунком (Y)';
    const part = (a: NudgeAxis) => {
      const offset = mToMm(point![AXIS_KEY[a]] - segment!.anchor[AXIS_KEY[a]]);
      return `${a} ${offset > 0 ? '+' : '−'}${formatMm(Math.abs(offset)).replace(/\s*мм$/, '')}`;
    };
    const text = diagonal
      ? `Відрізок 45°: ${part(locked)} · ${part(diagonal.choice.axis)} = ${formatMm(segmentLengthMm())}`
      : `Відрізок: ${part(locked)} мм`;
    // Підпис округлено до 0,1 мм — пояснюємо, чому «Підтвердити» ще неактивна.
    return canConfirm() ? text : `${text} — закороткий`;
  }

  function showNotice(text: string, wiggle = false): void {
    clearNotice();
    noticeText = text;
    noticeTimer = window.setTimeout(() => {
      noticeText = null;
      noticeTimer = 0;
      render();
    }, NOTICE_MS);
    if (wiggle) {
      for (const control of [stick.element, slider.element]) {
        if (control.classList.contains('stick--off')) continue;
        control.classList.remove('stick--wiggle');
        // Перезапуск анімації: прочитати розмір між зняттям і додаванням класу.
        void control.offsetWidth;
        control.classList.add('stick--wiggle');
        control.addEventListener('animationend', () => control.classList.remove('stick--wiggle'), { once: true });
      }
    }
    render();
  }

  confirm.addEventListener('click', () => {
    if (!point || !canConfirm()) return;
    const confirmed = point;
    handlers?.onConfirm(confirmed);
  });

  return {
    element,
    overlay,
    get state() {
      return {
        active: !element.hidden,
        label,
        point: point ? { ...point } : null,
        origin: origin ? { ...origin } : null,
        axis,
        moved: !!point && !!origin && (point.x !== origin.x || point.y !== origin.y || point.z !== origin.z),
        segment:
          segment && point
            ? {
                anchor: { ...segment.anchor },
                axis: segmentAxis(),
                lengthMm: segmentLengthMm(),
                diagonal: diagonal ? { ...diagonal.choice } : null,
              }
            : null,
        canConfirm: canConfirm(),
      };
    },
    ownedBy(owner) {
      return handlers === owner && !element.hidden;
    },
    edit(next, nextLabel, owner, options = {}) {
      // Утримання, що триває (наприклад, «Підтвердити» натиснули другим пальцем), нову точку
      // не рухає: цикл зупинено, вісь знято, час руху скинуто. Рух — з наступного натискання.
      stopLoop(false);
      lastTime = 0;
      handlers = owner;
      segment = options.segment ? { anchor: { ...options.segment.anchor }, previous: options.segment.previous } : null;
      resetDiagonal();
      // У режимі відрізка точка завжди стартує в попередньому вузлі.
      point = segment ? { ...segment.anchor } : { ...next };
      origin = { ...point };
      label = nextLabel;
      customTitle = options.title ?? null;
      blockedBack = false;
      detentUntil = 0;
      clearNotice();
      element.hidden = false;
      render();
      viewer.requestRender();
    },
    close() {
      // Якщо джойстик ще тримають (підтвердили другим пальцем), наступна точка від цього
      // утримання не поїде: цикл зупинено, а час руху скинуто.
      stopLoop(false);
      lastTime = 0;
      point = null;
      origin = null;
      label = null;
      customTitle = null;
      segment = null;
      resetDiagonal();
      handlers = null;
      clearNotice();
      element.hidden = true;
      overlay.hidden = true;
      viewer.requestRender();
    },
    notice(text, options = {}) {
      if (element.hidden) return;
      showNotice(text, options.wiggle ?? false);
    },
    dispose() {
      clearNotice();
      stopLoop();
      stopFrames();
      stick.dispose();
      slider.dispose();
      element.remove();
      overlay.remove();
    },
  };
}
