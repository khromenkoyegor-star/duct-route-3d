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

/** Числове поле в мм (на iPhone — цифрова клавіатура). */
function mmInput(testid: string, label: string, value: string, onInput: (v: string) => void): HTMLElement {
  const wrap = el('label', 'mm-field');
  wrap.append(el('span', 'mm-field-label', label));
  const input = el('input', 'mm-input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.pattern = '[0-9]*';
  input.autocomplete = 'off';
  input.value = value;
  input.dataset.testid = testid;
  input.setAttribute('aria-label', `${label}, мм`);
  input.addEventListener('input', () => onInput(input.value));
  wrap.append(input, el('span', 'mm-field-unit', 'мм'));
  return wrap;
}

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
  /** Форма, яку вибрали кнопкою (поки розмір не задано) — для вибраної траси. */
  let shapeChoice: 'round' | 'rect' | null = null;
  /** Чернетки полів (щоб перемальовування не стирало введене). */
  let rectDraft = { w: '', h: '' };
  let transitionDraft = { w: '', h: '' };
  let message = '';

  const route = () => (selection ? routes.find((r) => r.id === selection!.routeId) ?? null : null);

  const choose = (next: DuctSelection | null, notify = true) => {
    const changedRoute = next?.routeId !== selection?.routeId;
    selection = next;
    if (changedRoute) {
      shapeChoice = null;
      rectDraft = { w: '', h: '' };
    }
    if (changedRoute || next?.segment !== null) transitionDraft = { w: '', h: '' };
    message = '';
    // Спершу панель з новим вмістом (її розмір потрібен, щоб показати трасу у вільній частині екрана).
    render();
    if (notify) handlers.onSelect(selection);
  };

  const apply = (r: Route, duct: DuctSpec | null) => {
    try {
      handlers.onDuct(r.id, duct);
      message = '';
    } catch (error) {
      message = error instanceof RangeError ? error.message : 'Не вдалося змінити повітропровід';
      render();
    }
  };

  function sizeControls(r: Route): HTMLElement {
    const box = el('div', 'duct-size');
    const current = r.duct?.section ?? null;
    const shape = shapeChoice ?? current?.shape ?? 'round';
    box.append(
      segmented(
        [
          ['round', 'Круглі', 'duct-shape-round'],
          ['rect', 'Прямокутні', 'duct-shape-rect'],
        ],
        shape,
        (v) => {
          shapeChoice = v as 'round' | 'rect';
          message = '';
          render();
        },
      ),
    );
    if (shape === 'round') {
      const d = current?.shape === 'round' ? current.diameterMm : null;
      const row = el('div', 'duct-row');
      row.append(
        el('span', 'duct-row-label', 'Діаметр'),
        diameterSelect('duct-diameter', d, null, (value) => {
          shapeChoice = null;
          apply(r, withSection(r.duct ?? null, { shape: 'round', diameterMm: value }));
        }),
      );
      box.append(row);
    } else {
      if (current?.shape === 'rect' && rectDraft.w === '' && rectDraft.h === '') {
        rectDraft = { w: String(current.widthMm), h: String(current.heightMm) };
      }
      const row = el('div', 'duct-row duct-row--rect');
      row.append(
        mmInput('duct-width', 'Ширина', rectDraft.w, (v) => (rectDraft.w = v)),
        el('span', 'duct-times', '×'),
        mmInput('duct-height', 'Висота', rectDraft.h, (v) => (rectDraft.h = v)),
        button('panel-button panel-button--primary duct-apply', 'Задати', 'duct-apply-rect', () => {
          const w = parseSide(rectDraft.w);
          const h = parseSide(rectDraft.h);
          if (!sideOk(w) || !sideOk(h)) {
            message = SIDE_HINT;
            render();
            return;
          }
          shapeChoice = null;
          apply(r, withSection(r.duct ?? null, { shape: 'rect', widthMm: w, heightMm: h }));
        }),
      );
      box.append(row);
    }
    return box;
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
      row.classList.toggle('route-row--selected', on);
      row.classList.toggle('duct-segment--problem', problemOf.has(i));
      const dirText = dir ? `${dir.axis} ${dir.sign > 0 ? '+' : '−'}${formatMm(len)}` : formatMm(len);
      row.append(el('span', 'route-row-name', `${i + 1} · ${dirText}`));
      const t = transitionOn.get(i);
      const meta = t ? `перехід ${formatSection(i === 0 ? spec.section : sections[i - 1]!)} → ${formatSection(t.to)}` : formatSection(sections[i]!);
      row.append(el('span', 'route-row-meta', meta));
      item.append(row);
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
    box.append(el('p', 'duct-section-title', `Відрізок ${segment + 1}: перехід на його початку`));
    if (existing) {
      const row = el('div', 'duct-row');
      row.append(
        el('span', 'duct-row-label', `${formatSection(before)} → ${formatSection(existing.to)}`),
        button('panel-button panel-button--danger-text', 'Прибрати перехід', 'duct-transition-remove', () =>
          apply(r, withoutTransition(spec, segment)),
        ),
      );
      box.append(row);
      return box;
    }
    const place = (to: DuctSection) => apply(r, withTransition(spec, segment, to, count));
    const row = el('div', 'duct-row');
    if (before.shape === 'round') {
      let picked: number | null = null;
      row.append(
        el('span', 'duct-row-label', `${formatSection(before)} →`),
        diameterSelect('duct-transition-diameter', null, before.diameterMm, (d) => (picked = d)),
        button('panel-button panel-button--primary duct-apply', 'Перехід тут', 'duct-transition-here', () => {
          if (picked === null) {
            message = 'Виберіть діаметр після переходу';
            render();
            return;
          }
          place({ shape: 'round', diameterMm: picked });
        }),
      );
    } else {
      row.classList.add('duct-row--rect');
      row.append(
        mmInput('duct-transition-width', 'Ширина', transitionDraft.w, (v) => (transitionDraft.w = v)),
        el('span', 'duct-times', '×'),
        mmInput('duct-transition-height', 'Висота', transitionDraft.h, (v) => (transitionDraft.h = v)),
        button('panel-button panel-button--primary duct-apply', 'Перехід тут', 'duct-transition-here', () => {
          const w = parseSide(transitionDraft.w);
          const h = parseSide(transitionDraft.h);
          const to: DuctSection = { shape: 'rect', widthMm: w, heightMm: h };
          if (!sideOk(w) || !sideOk(h) || !isValidSection(to)) {
            message = SIDE_HINT;
            render();
            return;
          }
          place(to);
        }),
      );
    }
    box.append(row);
    return box;
  }

  function transitionsAndProblems(r: Route, spec: DuctSpec): HTMLElement[] {
    const out: HTMLElement[] = [];
    const count = r.nodes.length - 1;
    const sections = sectionsBySegment(spec, count);
    if (spec.transitions.length > 0) {
      const list = el('ul', 'duct-transitions');
      list.dataset.testid = 'duct-transitions';
      for (const t of spec.transitions) {
        const from = t.segment === 0 ? spec.section : sections[t.segment - 1]!;
        const item = el('li', 'duct-transition-item');
        item.append(
          el('span', '', `Перехід на відрізку ${t.segment + 1}: ${formatSection(from)} → ${formatSection(t.to)}`),
          button('icon-button', '✕', `duct-transition-${t.segment}-remove`, () => apply(r, withoutTransition(spec, t.segment))),
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
            `Відрізок ${p.segment + 1} закороткий для колін і переходу: потрібно щонайменше ${formatMm(p.needMm)}, є ${formatMm(p.haveMm)}`,
          ),
        );
      }
      out.push(box);
    }
    return out;
  }

  function render(): void {
    if (element.hidden) return;
    const children: HTMLElement[] = [];
    const head = el('div', 'ruler-head');
    const title = el('p', 'ruler-title', 'Повітропровід');
    title.id = 'duct-panel-title';
    head.append(title, button('ruler-done', 'Закрити', 'duct-close', () => handlers.onClose()));
    children.push(head);

    // Траси.
    const chips = el('div', 'duct-routes');
    for (const r of routes) {
      const chip = button('duct-chip', `Траса ${r.id}`, `duct-route-${r.id}`, () => choose({ routeId: r.id, segment: null }));
      const on = selection?.routeId === r.id;
      chip.setAttribute('aria-pressed', String(on));
      chip.classList.toggle('duct-chip--on', on);
      chip.append(el('span', 'duct-chip-size', r.duct ? formatSection(r.duct.section) : '—'));
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
        if (selection?.segment !== null && selection?.segment !== undefined) children.push(transitionEditor(r, r.duct, selection.segment));
        children.push(...transitionsAndProblems(r, r.duct));
      } else {
        children.push(el('p', 'ruler-sub', 'Задайте розмір — уся траса стане цього розміру'));
      }
    }
    if (message) {
      const warn = el('p', 'ruler-sub ruler-sub--warning', message);
      warn.dataset.testid = 'duct-message';
      warn.setAttribute('role', 'alert');
      children.push(warn);
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
    opacity.append(el('span', 'duct-section-title', `Прозорість скану: ${percent} %`));
    const range = el('input', 'duct-range');
    range.type = 'range';
    range.min = '0';
    range.max = '90';
    range.step = '5';
    range.value = String(percent);
    range.dataset.testid = 'scan-opacity';
    range.addEventListener('input', () => {
      transparency = Number(range.value) / 100;
      opacity.firstElementChild!.textContent = `Прозорість скану: ${range.value} %`;
      handlers.onTransparency(transparency);
    });
    opacity.append(range);
    view.append(opacity);
    children.push(view);

    element.replaceChildren(...children);
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
      message = '';
    },
    select(next) {
      choose(next);
    },
  };
}
