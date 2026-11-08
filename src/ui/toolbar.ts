import { ICON_OPEN, ICON_RULER, ICON_SHOW_ALL } from './icons';

export interface ToolbarHandlers {
  onOpen(): void;
  onShowAll(): void;
  onRuler(): void;
}

export interface Toolbar {
  element: HTMLElement;
  /** Кнопки, які мають сенс лише з відкритим сканом. */
  setScanLoaded(loaded: boolean): void;
  setRulerActive(active: boolean): void;
  setBusy(busy: boolean): void;
}

function makeButton(id: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-button';
  button.dataset.testid = id;
  button.innerHTML = `${icon}<span class="tool-label"></span>`;
  button.querySelector('.tool-label')!.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

/** Панель кнопок: на iPad — зверху справа, на iPhone вертикально — знизу (див. style.css). */
export function createToolbar(handlers: ToolbarHandlers): Toolbar {
  const element = document.createElement('nav');
  element.className = 'toolbar';
  element.setAttribute('aria-label', 'Дії');

  const open = makeButton('open-scan', ICON_OPEN, 'Відкрити скан', handlers.onOpen);
  open.classList.add('tool-button--primary');
  const showAll = makeButton('show-all', ICON_SHOW_ALL, 'Показати все', handlers.onShowAll);
  const ruler = makeButton('ruler', ICON_RULER, 'Рулетка', handlers.onRuler);
  ruler.setAttribute('aria-pressed', 'false');

  element.append(open, showAll, ruler);

  let scanLoaded = false;
  let busy = false;
  const sync = () => {
    open.disabled = busy;
    showAll.disabled = busy;
    ruler.disabled = busy || !scanLoaded;
  };
  sync();

  return {
    element,
    setScanLoaded(loaded) {
      scanLoaded = loaded;
      sync();
    },
    setRulerActive(active) {
      ruler.setAttribute('aria-pressed', String(active));
      ruler.classList.toggle('tool-button--active', active);
    },
    setBusy(value) {
      busy = value;
      sync();
    },
  };
}
