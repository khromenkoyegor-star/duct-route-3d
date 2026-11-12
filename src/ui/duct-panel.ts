/**
 * Панель «Повітропровід» (рішення Єгора, етап 4):
 * - вибір траси; тип «Круглі» / «Прямокутні»; розмір — уся траса одного розміру;
 * - переходи: вибираєш відрізок (у списку або дотиком по трубі на сцені) → «Перехід тут» → новий розмір;
 *   перехід стоїть на початку відрізка, далі — новий розмір; кожен перехід можна прибрати;
 * - закороткі відрізки (деталі не вміщаються) — червоним з поясненням;
 * - показ «Траса / Повітропровід / Обидва» і прозорість скану.
 * Дані — лише через обробники (траси змінює route-tool), панель їх тільки показує.
 */
import {
  DUCT_DIAMETERS_MM,
  type DuctSection,
  type DuctSpec,
  ductLayout,
  formatSection,
  isValidSection,
  RECT_SIDE_MAX_MM,
  RECT_SIDE_MIN_MM,
  sectionsBySegment,
  withSection,
  withoutTransition,
  withTransition,
} from '../core/duct';
import { distance, type Route, segmentDirection } from '../core/route';
import { formatMm } from '../core/units';

export type ViewMode = 'route' | 'duct' | 'both';

export interface DuctSelection {
  routeId: number;
  segment: number | null;
}

export interface DuctPanelHandlers {
  onDuct(routeId: number, duct: DuctSpec | null): void;
  /** Підтвердження системним віконцем (наприклад, «переходи буде прибрано»); onOk — якщо погодились. */
  confirm(title: string, text: string, okLabel: string, onOk: () => void): void;
  onSelect(selection: DuctSelection | null): void;
  onMode(mode: ViewMode): void;
  onTransparency(transparency: number): void;
  onClose(): void;
}

export interface DuctPanel {
  element: HTMLElement;
  readonly open: boolean;
  readonly selection: DuctSelection | null;
  /** Відкрити (або оновити) з поточними трасами, режимом показу й прозорістю. */
  show(routes: readonly Route[], mode: ViewMode, transparency: number): void;
  hide(): void;
  /** Вибрати трасу й відрізок (наприклад, дотиком по трубі на сцені). */
  select(selection: DuctSelection | null): void;
}

const MODES: Array<[ViewMode, string]> = [
  ['route', 'Траса'],
  ['duct', 'Повітропровід'],
  ['both', 'Обидва'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, testid: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.dataset.testid = testid;
  b.addEventListener('click', onClick);
  return b;
}

/** Сегментований перемикач у стилі iOS. */
function segmented(options: Array<[string, string, string]>, value: string, onPick: (v: string) => void): HTMLElement {
  const box = el('div', 'segmented');
  box.setAttribute('role', 'group');
  for (const [v, label, testid] of options) {
    const b = button('segmented-option', label, testid, () => onPick(v));
    b.setAttribute('aria-pressed', String(v === value));
    b.classList.toggle('segmented-option--on', v === value);
    box.append(b);
  }
  return box;
}

/** Числове поле в мм (на iPhone — цифрова клавіатура; «Готово» на клавіатурі — застосувати). */
function mmInput(testid: string, label: string, value: string, invalid: boolean, onInput: (v: string) => void): HTMLElement {
  const wrap = el('label', 'mm-field');
  wrap.append(el('span', 'mm-field-label', `${label}, мм`));
  const input = el('input', 'mm-input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.pattern = '[0-9]*';
  input.autocomplete = 'off';
  input.enterKeyHint = 'done';
  input.value = value;
  input.dataset.testid = testid;
  input.classList.toggle('mm-input--invalid', invalid);
  input.setAttribute('aria-invalid', String(invalid));
  input.setAttribute('aria-label', `${label}, мм`);
  input.addEventListener('input', () => onInput(input.value));
  wrap.append(input);
  return wrap;
}

/** Ш × В у формі: Enter (клавіатура iPad) чи «Готово» (iPhone) натискає кнопку. */
function sizeForm(className: string, onSubmit: () => void, ...children: HTMLElement[]): HTMLFormElement {
  const form = el('form', className);
  form.noValidate = true;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit();
  });
  form.append(...children);
  return form;
}

/** «400 мм» з нерозривним пробілом — число й «мм» не розриваються переносом. */
const mm = (value: number) => formatMm(value).replace(' мм', '\u00a0мм');

/** Вибір діаметра зі списку Єгора (системний список iOS). */
function diameterSelect(testid: string, current: number | null, exclude: number | null, onPick: (d: number) => void): HTMLSelectElement {
  const select = el('select', 'duct-select');
  select.dataset.testid = testid;
  select.setAttribute('aria-label', 'Діаметр');
  if (current === null) {
    const placeholder = el('option', '', 'Виберіть діаметр');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.append(placeholder);
  }
  for (const d of DUCT_DIAMETERS_MM) {
    if (d === exclude) continue;
    const option = el('option', '', `Ø${d} мм`);
    option.value = String(d);
    option.selected = d === current;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const d = Number(select.value);
    if (Number.isFinite(d) && d > 0) onPick(d);
  });
  return select;
}

const parseSide = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN);
const sideOk = (v: number) => Number.isFinite(v) && v >= RECT_SIDE_MIN_MM && v <= RECT_SIDE_MAX_MM;
const SIDE_HINT = `Сторона — ціле число від ${RECT_SIDE_MIN_MM} до ${RECT_SIDE_MAX_MM} мм`;

export function createDuctPanel(handlers: DuctPanelHandlers): DuctPanel {
  const element = el('div', 'panel duct-panel');
  element.dataset.testid = 'duct-panel';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-labelledby', 'duct-panel-title');
  element.hidden = true;

  let routes: readonly Route[] = [];
  let mode: ViewMode = 'both';
  let transparency = 0;
  let selection: DuctSelection | null = null;
  /** Форма, яку вибрали кнопкою (поки розмір не задано чи ще не змінено) — для вибраної траси. */
  let shapeChoice: 'round' | 'rect' | null = null;
  /** Чернетки полів (щоб перемальовування не стирало введене). */
  let rectDraft = { w: '', h: '' };
  let transitionDraft = { w: '', h: '' };
  /** Діаметр після переходу, вибраний у списку (до «Перехід тут»). */
  let transitionDiameter: number | null = null;
  /** Пояснення біля того місця, де помилка: розмір траси чи перехід. */
  let message: { scope: 'size' | 'transition'; text: string; fields?: Array<'w' | 'h'> } | null = null;
  /** Після перемальовування прокрутити до редактора переходу (на iPhone він нижче видимої частини). */
  let scrollToEditor = false;

  const route = () => (selection ? routes.find((r) => r.id === selection!.routeId) ?? null : null);

  const choose = (next: DuctSelection | null, notify = true) => {
    const changedRoute = next?.routeId !== selection?.routeId;
    const changedSegment = changedRoute || next?.segment !== selection?.segment;
    selection = next;
    if (changedRoute) {
      shapeChoice = null;
      rectDraft = { w: '', h: '' };
    }
    if (changedSegment) {
      transitionDraft = { w: '', h: '' };
      transitionDiameter = null;
      scrollToEditor = next?.segment !== null && next?.segment !== undefined;
    }
    message = null;
    // Спершу панель з новим вмістом (її розмір потрібен, щоб показати трасу у вільній частині екрана).
    render();
    if (notify) handlers.onSelect(selection);
  };

  /** Застосувати зміну; `next` рахується всередині — помилка правил (RangeError) стає поясненням у панелі. */
  const apply = (r: Route, next: () => DuctSpec | null, scope: 'size' | 'transition') => {
    // Повідомлення прибираємо до зміни: зміна одразу перемальовує панель.
    message = null;
    try {
      handlers.onDuct(r.id, next());
    } catch (error) {
      message = { scope, text: error instanceof RangeError ? error.message : 'Не вдалося змінити повітропровід' };
      render();
    }
  };

  /** Змінити розмір траси; якщо при цьому зникнуть переходи — спершу спитати. */
  const applySection = (r: Route, section: DuctSection) => {
    let next: DuctSpec;
    try {
      next = withSection(r.duct ?? null, section);
    } catch (error) {
      message = { scope: 'size', text: error instanceof RangeError ? error.message : 'Не вдалося змінити розмір' };
      render();
      return;
    }
    const lost = (r.duct?.transitions.length ?? 0) - next.transitions.length;
    if (lost <= 0) {
      shapeChoice = null;
      apply(r, () => next, 'size');
      return;
    }
    const why = r.duct?.section.shape !== section.shape ? 'Перехід між круглим і прямокутним поки не робимо.' : 'Вони стали б переходами на той самий розмір.';
    handlers.confirm(
      lost === 1 ? 'Перехід буде прибрано' : `Переходи (${lost}) буде прибрано`,
      `${why} Змінити розмір траси?`,
      'Змінити',
      () => {
        shapeChoice = null;
        apply(r, () => next, 'size');
      },
    );
    render();
  };

  const messageEl = (scope: 'size' | 'transition') => {
    if (message?.scope !== scope) return null;
    const warn = el('p', 'ruler-sub ruler-sub--warning duct-message', message.text);
    warn.dataset.testid = 'duct-message';
    warn.setAttribute('role', 'alert');
    return warn;
  };
  const invalid = (scope: 'size' | 'transition', field: 'w' | 'h') => message?.scope === scope && !!message.fields?.includes(field);

  function sizeControls(r: Route): HTMLElement {
    const box = el('div', 'duct-size');
    const current = r.duct?.section ?? null;
    const shape = shapeChoice ?? current?.shape ?? 'round';
    const hasTransitions = (r.duct?.transitions.length ?? 0) > 0;
    box.append(
      segmented(
        [
          ['round', 'Круглі', 'duct-shape-round'],
          ['rect', 'Прямокутні', 'duct-shape-rect'],
        ],
        shape,
        (v) => {
          shapeChoice = v as 'round' | 'rect';
          message = null;
          render();
        },
      ),
    );
    // Вибрали іншу форму, ніж зараз у траси, — підказати, що зміниться лише після вибору розміру.
    if (current && shape !== current.shape) {
      box.append(el('p', 'ruler-sub duct-hint', `Зараз ${formatSection(current)} — задайте розмір, щоб змінити`));
    }
    if (shape === 'round') {
      const d = current?.shape === 'round' ? current.diameterMm : null;
      const row = el('div', 'duct-row');
      row.append(
        el('span', 'duct-row-label', hasTransitions ? 'Діаметр на початку' : 'Діаметр'),
        diameterSelect('duct-diameter', d, null, (value) => applySection(r, { shape: 'round', diameterMm: value })),
      );
      box.append(row);
    } else {
      if (current?.shape === 'rect' && rectDraft.w === '' && rectDraft.h === '') {
        rectDraft = { w: String(current.widthMm), h: String(current.heightMm) };
      }
      const submit = () => {
        const w = parseSide(rectDraft.w);
        const h = parseSide(rectDraft.h);
        const fields = [...(sideOk(w) ? [] : (['w'] as const)), ...(sideOk(h) ? [] : (['h'] as const))];
        if (fields.length > 0) {
          message = { scope: 'size', text: SIDE_HINT, fields };
          render();
          return;
        }
        applySection(r, { shape: 'rect', widthMm: w, heightMm: h });
      };
      if (hasTransitions) box.append(el('p', 'duct-section-title', 'Розмір на початку'));
      box.append(
        sizeForm(
          'duct-row duct-row--rect',
          submit,
          mmInput('duct-width', 'Ширина', rectDraft.w, invalid('size', 'w'), (v) => (rectDraft.w = v)),
          el('span', 'duct-times', '×'),
          mmInput('duct-height', 'Висота', rectDraft.h, invalid('size', 'h'), (v) => (rectDraft.h = v)),
          submitButton('Задати', 'duct-apply-rect'),
        ),
      );
    }
    const warn = messageEl('size');
    if (warn) box.append(warn);
    return box;
  }

  function submitButton(text: string, testid: string): HTMLButtonElement {
    const b = el('button', 'panel-button panel-button--primary duct-apply', text);
    b.type = 'submit';
    b.dataset.testid = testid;
    return b;
  }

  function segmentList(r: Route, spec: DuctSpec): HTMLElement {
    const count = r.nodes.length - 1;
    const sections = sectionsBySegment(spec, count);
    const layout = ductLayout(r.nodes, spec);
    const problemOf = new Map(layout.problems.map((p) => [p.segment, p]));
    const transitionOn = new Map(spec.transitions.map((t) => [t.segment, t]));
    const box = el('div', 'duct-segments');
    box.append(el('p', 'duct-section-title', 'Відрізки — торкніться, щоб поставити перехід'));
    const list = el('ul', 'route-list duct-segment-list');
    for (let i = 0; i < count; i++) {
      const a = r.nodes[i]!;
      const b = r.nodes[i + 1]!;
      const dir = segmentDirection(a, b);
      const len = distance(a, b);
      const item = el('li', '');
      const row = button('route-row duct-segment', '', `duct-segment-${i}`, () =>
        choose({ routeId: r.id, segment: selection?.segment === i ? null : i }),
      );
      const on = selection?.segment === i;
      row.setAttribute('aria-pressed', String(on));
      row.classList.toggle('duct-segment--selected', on);
      const problem = problemOf.get(i);
      row.classList.toggle('duct-segment--problem', !!problem);
      const dirText = dir ? `${dir.axis} ${dir.sign > 0 ? '+' : '−'}${mm(len)}` : mm(len);
      row.append(el('span', 'route-row-name', `${i + 1} · ${dirText}`));
      const t = transitionOn.get(i);
      let meta = t ? `перехід ${formatSection(i === 0 ? spec.section : sections[i - 1]!)} → ${formatSection(t.to)}` : formatSection(sections[i]!);
      if (problem) meta = `замало: треба ${mm(problem.needMm)}, є ${mm(problem.haveMm)}`;
      row.append(el('span', 'route-row-meta', meta));
      item.append(row);
      // Редактор переходу — одразу під вибраним рядком.
      if (on) item.append(transitionEditor(r, spec, i));
      list.append(item);
    }
    box.append(list);
    return box;
  }

  function transitionEditor(r: Route, spec: DuctSpec, segment: number): HTMLElement {
    const count = r.nodes.length - 1;
    const sections = sectionsBySegment(spec, count);
    const before = segment === 0 ? spec.section : sections[segment - 1]!;
    const existing = spec.transitions.find((t) => t.segment === segment);
    const box = el('div', 'duct-transition');
    box.dataset.testid = 'duct-transition-editor';
    box.append(el('p', 'duct-section-title', `Перехід на початку відрізка ${segment + 1}`));
    if (existing) {
      const row = el('div', 'duct-row');
      row.append(
        el('span', 'duct-row-label', `${formatSection(before)} → ${formatSection(existing.to)}`),
        button('panel-button panel-button--danger-text', 'Прибрати перехід', 'duct-transition-remove', () =>
          apply(r, () => withoutTransition(spec, segment), 'transition'),
        ),
      );
      box.append(row);
      return box;
    }
    // Перехід «на той самий розмір» тощо — пояснення біля полів (RangeError з правил моделі).
    const place = (to: DuctSection) => apply(r, () => withTransition(spec, segment, to, count), 'transition');
    if (before.shape === 'round') {
      const row = sizeForm('duct-row', () => {
        if (transitionDiameter === null) {
          message = { scope: 'transition', text: 'Виберіть діаметр після переходу' };
          render();
          return;
        }
        place({ shape: 'round', diameterMm: transitionDiameter });
      });
      row.append(
        el('span', 'duct-row-label', `${formatSection(before)} →`),
        diameterSelect('duct-transition-diameter', transitionDiameter, before.diameterMm, (d) => (transitionDiameter = d)),
        submitButton('Перехід тут', 'duct-transition-here'),
      );
      box.append(row);
    } else {
      // Поточний розмір у полях — щоб змінити лише одне число.
      if (transitionDraft.w === '' && transitionDraft.h === '') {
        transitionDraft = { w: String(before.widthMm), h: String(before.heightMm) };
      }
      const submit = () => {
        const w = parseSide(transitionDraft.w);
        const h = parseSide(transitionDraft.h);
        const fields = [...(sideOk(w) ? [] : (['w'] as const)), ...(sideOk(h) ? [] : (['h'] as const))];
        const to: DuctSection = { shape: 'rect', widthMm: w, heightMm: h };
        if (fields.length > 0 || !isValidSection(to)) {
          message = { scope: 'transition', text: SIDE_HINT, fields };
          render();
          return;
        }
        place(to);
      };
      box.append(
        sizeForm(
          'duct-row duct-row--rect',
          submit,
          mmInput('duct-transition-width', 'Ширина', transitionDraft.w, invalid('transition', 'w'), (v) => (transitionDraft.w = v)),
          el('span', 'duct-times', '×'),
          mmInput('duct-transition-height', 'Висота', transitionDraft.h, invalid('transition', 'h'), (v) => (transitionDraft.h = v)),
          submitButton('Перехід тут', 'duct-transition-here'),
        ),
      );
    }
    const warn = messageEl('transition');
    if (warn) box.append(warn);
    return box;
  }

  function transitionsAndProblems(r: Route, spec: DuctSpec): HTMLElement[] {
    const out: HTMLElement[] = [];
    const count = r.nodes.length - 1;
    const sections = sectionsBySegment(spec, count);
    if (spec.transitions.length > 0) {
      out.push(el('p', 'duct-section-title', 'Переходи'));
      const list = el('ul', 'duct-transitions');
      list.dataset.testid = 'duct-transitions';
      for (const t of spec.transitions) {
        const from = t.segment === 0 ? spec.section : sections[t.segment - 1]!;
        const item = el('li', 'duct-transition-item');
        item.append(
          el('span', '', `Перехід на відрізку ${t.segment + 1}: ${formatSection(from)} → ${formatSection(t.to)}`),
          button('icon-button', '✕', `duct-transition-${t.segment}-remove`, () =>
            apply(r, () => withoutTransition(spec, t.segment), 'transition'),
          ),
        );
        item.lastElementChild!.setAttribute('aria-label', `Прибрати перехід на відрізку ${t.segment + 1}`);
        list.append(item);
      }
      out.push(list);
    }
    const problems = ductLayout(r.nodes, spec).problems;
    if (problems.length > 0) {
      const box = el('div', 'duct-problems');
      box.dataset.testid = 'duct-problems';
      box.setAttribute('role', 'status');
      for (const p of problems) {
        box.append(
          el(
            'p',
            '',
            `Відрізок ${p.segment + 1} закороткий для колін і переходу: потрібно щонайменше ${mm(p.needMm)}, є ${mm(p.haveMm)}`,
          ),
        );
      }
      out.push(box);
    }
    return out;
  }

  function render(): void {
    if (element.hidden) return;
    const scrollTop = element.scrollTop;
    const children: HTMLElement[] = [];
    const head = el('div', 'ruler-head');
    const title = el('p', 'ruler-title', 'Повітропровід');
    title.id = 'duct-panel-title';
    head.append(title, button('ruler-done', 'Закрити', 'duct-close', () => handlers.onClose()));
    children.push(head);

    // Траси: розмір або «без труби»; «!» — є закороткі відрізки.
    const chips = el('div', 'duct-routes');
    for (const r of routes) {
      const chip = button('duct-chip', `Траса ${r.id}`, `duct-route-${r.id}`, () => choose({ routeId: r.id, segment: null }));
      const on = selection?.routeId === r.id;
      chip.setAttribute('aria-pressed', String(on));
      chip.classList.toggle('duct-chip--on', on);
      const problems = r.duct ? ductLayout(r.nodes, r.duct).problems.length : 0;
      chip.append(el('span', 'duct-chip-size', r.duct ? formatSection(r.duct.section) : 'без труби'));
      if (problems > 0) {
        const badge = el('span', 'duct-chip-badge', '!');
        badge.setAttribute('aria-label', 'є закороткі відрізки');
        chip.append(badge);
      }
      chips.append(chip);
    }
    children.push(chips);

    const r = route();
    if (!r) {
      children.push(el('p', 'ruler-sub', 'Виберіть трасу, щоб задати їй повітропровід'));
    } else {
      children.push(sizeControls(r));
      if (r.duct) {
        children.push(segmentList(r, r.duct));
        children.push(...transitionsAndProblems(r, r.duct));
      } else {
        children.push(el('p', 'ruler-sub', 'Задайте розмір — уся траса стане цього розміру'));
      }
    }

    // Показ і прозорість.
    const view = el('div', 'duct-view');
    view.append(
      el('p', 'duct-section-title', 'Показати'),
      segmented(
        MODES.map(([v, label]) => [v, label, `view-mode-${v}`]),
        mode,
        (v) => {
          mode = v as ViewMode;
          handlers.onMode(mode);
          render();
        },
      ),
    );
    const opacity = el('label', 'duct-opacity');
    const percent = Math.round(transparency * 100);
    const value = el('span', 'duct-opacity-value', `${percent} %`);
    const caption = el('span', 'duct-opacity-caption', 'Прозорість скану ');
    caption.append(value);
    opacity.append(caption);
    const range = el('input', 'duct-range');
    range.type = 'range';
    range.min = '0';
    range.max = '90';
    range.step = '5';
    range.value = String(percent);
    range.dataset.testid = 'scan-opacity';
    range.addEventListener('input', () => {
      transparency = Number(range.value) / 100;
      value.textContent = `${range.value} %`;
      handlers.onTransparency(transparency);
    });
    opacity.append(range);
    view.append(opacity);
    children.push(view);

    element.replaceChildren(...children);
    element.scrollTop = scrollTop;
    if (scrollToEditor) {
      scrollToEditor = false;
      element.querySelector('[data-testid="duct-transition-editor"]')?.scrollIntoView({ block: 'nearest' });
    }
  }

  return {
    element,
    get open() {
      return !element.hidden;
    },
    get selection() {
      return selection;
    },
    show(next, nextMode, nextTransparency) {
      routes = next;
      mode = nextMode;
      transparency = nextTransparency;
      const wasHidden = element.hidden;
      element.hidden = false;
      // Траса зникла — вибір знімається; якщо траса одна — вибрана одразу.
      if (selection && !routes.some((r) => r.id === selection!.routeId)) choose(null);
      else if (wasHidden && !selection && routes.length > 0) choose({ routeId: routes[0]!.id, segment: null });
      else {
        const r = route();
        if (r && selection?.segment !== null && selection?.segment !== undefined && selection.segment >= r.nodes.length - 1) {
          choose({ routeId: r.id, segment: null });
        } else render();
      }
    },
    hide() {
      element.hidden = true;
      selection = null;
      shapeChoice = null;
      message = null;
    },
    select(next) {
      choose(next);
    },
  };
}
