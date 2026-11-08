/**
 * «Видалити траєкторію»: панель зі списком усіх трас у сцені («Траса 1 · 4 точки · 7 350 мм»).
 * Вибрана траса підсвічується на сцені (камеру можна крутити, щоб її роздивитись);
 * «Видалити Трасу N» прибирає її. Номери решти трас не змінюються.
 */
import { formatPointCount, type Route, routeLength } from '../core/route';
import { formatMm } from '../core/units';

export interface RouteDeletePanel {
  element: HTMLElement;
  readonly open: boolean;
  readonly selected: number | null;
  /** Показати (або оновити) список трас. */
  show(routes: readonly Route[]): void;
  hide(): void;
}

export interface RouteDeleteHandlers {
  onSelect(id: number | null): void;
  onDelete(id: number): void;
  onClose(): void;
}

export function createRouteDelete(handlers: RouteDeleteHandlers): RouteDeletePanel {
  const element = document.createElement('div');
  element.className = 'panel route-delete-panel';
  element.dataset.testid = 'route-delete-panel';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-labelledby', 'route-delete-title');
  element.hidden = true;
  const head = document.createElement('div');
  head.className = 'ruler-head';
  const title = document.createElement('p');
  title.className = 'ruler-title';
  title.id = 'route-delete-title';
  title.textContent = 'Видалити траєкторію';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ruler-done';
  close.dataset.testid = 'route-delete-close';
  close.textContent = 'Закрити';
  close.addEventListener('click', () => handlers.onClose());
  head.append(title, close);
  const hint = document.createElement('p');
  hint.className = 'ruler-sub';
  hint.textContent = 'Виберіть трасу — вона стане червоною на сцені';
  const list = document.createElement('ul');
  list.className = 'route-list';
  list.dataset.testid = 'route-list';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'panel-button panel-button--danger';
  remove.dataset.testid = 'route-delete-confirm';
  element.append(head, hint, list, remove);

  let routes: readonly Route[] = [];
  let selected: number | null = null;

  const render = () => {
    if (selected !== null && !routes.some((r) => r.id === selected)) selected = null;
    list.replaceChildren(
      ...routes.map((route) => {
        const item = document.createElement('li');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'route-row';
        row.dataset.testid = `route-row-${route.id}`;
        const on = route.id === selected;
        row.classList.toggle('route-row--selected', on);
        row.setAttribute('aria-pressed', String(on));
        const name = document.createElement('span');
        name.className = 'route-row-name';
        name.textContent = `Траса ${route.id}`;
        const meta = document.createElement('span');
        meta.className = 'route-row-meta';
        meta.textContent = `${formatPointCount(route.nodes.length)} · ${formatMm(routeLength(route.nodes))}`;
        row.append(name, meta);
        row.addEventListener('click', () => {
          selected = on ? null : route.id;
          handlers.onSelect(selected);
          render();
        });
        item.append(row);
        return item;
      }),
    );
    remove.disabled = selected === null;
    remove.textContent = selected === null ? 'Видалити трасу' : `Видалити Трасу ${selected}`;
  };

  remove.addEventListener('click', () => {
    if (selected === null) return;
    const id = selected;
    selected = null;
    handlers.onDelete(id);
  });

  return {
    element,
    get open() {
      return !element.hidden;
    },
    get selected() {
      return selected;
    },
    show(next) {
      routes = next;
      element.hidden = false;
      render();
    },
    hide() {
      element.hidden = true;
      selected = null;
    },
  };
}
