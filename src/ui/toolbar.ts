import { ICON_DUCT, ICON_OPEN, ICON_ROUTE, ICON_RULER, ICON_SHOW_ALL, ICON_TRASH } from './icons';

/** Інструмент, який зараз увімкнено (одночасно — лише один). */
export type ToolName = 'none' | 'ruler' | 'route' | 'delete' | 'duct';

export interface ToolbarHandlers {
  onOpen(): void;
  onShowAll(): void;
  onRuler(): void;
  onRoute(): void;
  onRouteDelete(): void;
  onDuct(): void;
}

export interface Toolbar {
  element: HTMLElement;
  /** Кнопки, які мають сенс лише з відкритим сканом. */
  setScanLoaded(loaded: boolean): void;
  /** Чи є в сцені траси (інакше «Видалити траєкторію» і «Повітропровід» неактивні). */
  setHasRoutes(has: boolean): void;
  setActiveTool(tool: ToolName): void;
  setBusy(busy: boolean): void;
}

/** label — повна назва (iPad); short — коротка для нижньої панелі iPhone. */
function makeButton(id: string, icon: string, label: string, short: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-button';
  button.dataset.testid = id;
  button.innerHTML = `${icon}<span class="tool-label"></span><span class="tool-label-short" aria-hidden="true"></span>`;
  button.querySelector('.tool-label')!.textContent = label;
  button.querySelector('.tool-label-short')!.textContent = short;
  // На вузьких екранах видно лише іконку чи коротку назву — повна лишається для VoiceOver.
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

/** Панель кнопок: на iPad — зверху справа, на iPhone вертикально — знизу (див. style.css). */
export function createToolbar(handlers: ToolbarHandlers): Toolbar {
  const element = document.createElement('nav');
  element.className = 'toolbar';
  element.setAttribute('aria-label', 'Дії');

  const open = makeButton('open-scan', ICON_OPEN, 'Відкрити скан', 'Відкрити', handlers.onOpen);
  open.classList.add('tool-button--primary');
  const showAll = makeButton('show-all', ICON_SHOW_ALL, 'Показати все', 'Усе', handlers.onShowAll);
  const ruler = makeButton('ruler', ICON_RULER, 'Рулетка', 'Рулетка', handlers.onRuler);
  const route = makeButton('route', ICON_ROUTE, 'Траса', 'Траса', handlers.onRoute);
  const routeDelete = makeButton('route-delete', ICON_TRASH, 'Видалити траєкторію', 'Видалити', handlers.onRouteDelete);
  const duct = makeButton('duct', ICON_DUCT, 'Повітропровід', 'Труба', handlers.onDuct);
  const toggles: Array<[HTMLButtonElement, ToolName]> = [
    [ruler, 'ruler'],
    [route, 'route'],
    [routeDelete, 'delete'],
    [duct, 'duct'],
  ];
  for (const [button] of toggles) button.setAttribute('aria-pressed', 'false');

  element.append(open, showAll, ruler, route, routeDelete, duct);

  let scanLoaded = false;
  let hasRoutes = false;
  let busy = false;
  const sync = () => {
    open.disabled = busy;
    showAll.disabled = busy;
    ruler.disabled = busy || !scanLoaded;
    route.disabled = busy || !scanLoaded;
    routeDelete.disabled = busy || !scanLoaded || !hasRoutes;
    duct.disabled = busy || !scanLoaded || !hasRoutes;
  };
  sync();

  return {
    element,
    setScanLoaded(loaded) {
      scanLoaded = loaded;
      // Головна дія без скану — відкрити; коли скан є, кнопка стає звичайною.
      open.classList.toggle('tool-button--primary', !loaded);
      sync();
    },
    setHasRoutes(has) {
      hasRoutes = has;
      sync();
    },
    setActiveTool(tool) {
      for (const [button, name] of toggles) {
        const on = tool === name;
        button.setAttribute('aria-pressed', String(on));
        button.classList.toggle('tool-button--active', on);
      }
    },
    setBusy(value) {
      busy = value;
      sync();
    },
  };
}
