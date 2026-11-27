/** Індикатор завантаження і повідомлення про помилку — картки по центру екрана в стилі iOS. */

export interface Progress {
  element: HTMLElement;
  /** detail — другий рядок дрібніше (наприклад, розмір файлу). */
  show(text: string, detail?: string): void;
  hide(): void;
}

export function createProgress(): Progress {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.dataset.testid = 'progress';
  backdrop.hidden = true;
  const card = document.createElement('div');
  card.className = 'card card--progress';
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const label = document.createElement('p');
  label.className = 'card-text';
  const detailLine = document.createElement('p');
  detailLine.className = 'card-detail';
  card.append(spinner, label, detailLine);
  backdrop.append(card);
  return {
    element: backdrop,
    show(text, detail) {
      label.textContent = text;
      detailLine.textContent = detail ?? '';
      detailLine.hidden = !detail;
      backdrop.hidden = false;
    },
    hide() {
      backdrop.hidden = true;
    },
  };
}

export interface Alert {
  element: HTMLElement;
  show(title: string, message: string): void;
}

export function createAlert(): Alert {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.dataset.testid = 'alert';
  backdrop.hidden = true;
  const card = document.createElement('div');
  card.className = 'card card--alert';
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const title = document.createElement('h2');
  title.className = 'card-title';
  title.id = 'alert-title';
  const text = document.createElement('p');
  text.className = 'card-text';
  text.dataset.testid = 'alert-text';
  card.setAttribute('aria-labelledby', title.id);
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'card-button';
  ok.textContent = 'Зрозуміло';
  ok.addEventListener('click', () => {
    backdrop.hidden = true;
  });
  card.append(title, text, ok);
  backdrop.append(card);
  return {
    element: backdrop,
    show(heading, message) {
      title.textContent = heading;
      text.textContent = message;
      backdrop.hidden = false;
      // Фокус на кнопку — лише для клавіатури (без товстої рамки після дотику, як в iOS).
      ok.focus({ focusVisible: false } as FocusOptions);
    },
  };
}

export interface ChoiceButton {
  label: string;
  /** cancel — «Скасувати» (звичайний шрифт), destructive — червона, default — жирна. */
  role?: 'default' | 'cancel' | 'destructive';
  testid?: string;
  /** Викликається одразу в обробнику натискання (важливо для відкриття «Файлів» на iOS). */
  onSelect?(): void;
}

export interface Choice {
  element: HTMLElement;
  readonly open: boolean;
  /** Віконце-питання з кнопками: дві — поруч, більше — одна під одною (як в iOS). */
  show(title: string, message: string, buttons: readonly ChoiceButton[]): void;
  hide(): void;
}

export function createChoice(): Choice {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.dataset.testid = 'choice';
  backdrop.hidden = true;
  const card = document.createElement('div');
  card.className = 'card card--alert card--choice';
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const title = document.createElement('h2');
  title.className = 'card-title';
  title.id = 'choice-title';
  const text = document.createElement('p');
  text.className = 'card-text';
  text.id = 'choice-text';
  text.dataset.testid = 'choice-text';
  card.setAttribute('aria-labelledby', title.id);
  card.setAttribute('aria-describedby', text.id);
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  card.append(title, text, actions);
  backdrop.append(card);

  const hide = () => {
    backdrop.hidden = true;
    actions.replaceChildren();
  };

  return {
    element: backdrop,
    get open() {
      return !backdrop.hidden;
    },
    show(heading, message, buttons) {
      title.textContent = heading;
      text.textContent = message;
      actions.classList.toggle('card-actions--row', buttons.length === 2);
      actions.replaceChildren(
        ...buttons.map((b) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `card-button card-button--${b.role ?? 'default'}`;
          if (b.testid) button.dataset.testid = b.testid;
          button.textContent = b.label;
          button.addEventListener('click', () => {
            hide();
            b.onSelect?.();
          });
          return button;
        }),
      );
      backdrop.hidden = false;
      const preferred = actions.querySelector<HTMLButtonElement>('.card-button--cancel') ?? actions.querySelector('button');
      preferred?.focus({ focusVisible: false } as FocusOptions);
    },
    hide,
  };
}

// ───────────────────────── Меню «Файл» (етап 6) ─────────────────────────

export interface MenuItem {
  label: string;
  testid: string;
  /** Викликається одразу в обробнику натискання (важливо для «Файлів» і «Поділитися» на iOS). */
  onSelect(): void;
}

export interface Menu {
  element: HTMLElement;
  readonly open: boolean;
  /** Показати пункти біля кнопки `anchor`: під нею, а якщо вона внизу екрана (iPhone) — над нею. */
  show(anchor: HTMLElement, items: readonly MenuItem[]): void;
  hide(): void;
}

/**
 * Маленьке меню в стилі iOS: лише потрібні пункти, без «Скасувати» — закривається дотиком будь-де поза
 * ним (або Esc на клавіатурі iPad).
 */
export function createMenu(label: string): Menu {
  const backdrop = document.createElement('div');
  backdrop.className = 'menu-backdrop';
  backdrop.dataset.testid = 'menu';
  backdrop.hidden = true;
  const panel = document.createElement('div');
  panel.className = 'menu';
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', label);
  backdrop.append(panel);

  const hide = () => {
    backdrop.hidden = true;
    panel.replaceChildren();
  };
  // Дотик поза меню лише закриває його (не натискає те, що під ним).
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) hide();
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
  // Повернули пристрій чи змінився розмір вікна — меню закривається (як в iOS), а не лишається за краєм.
  window.addEventListener('resize', () => {
    if (!backdrop.hidden) hide();
  });

  return {
    element: backdrop,
    get open() {
      return !backdrop.hidden;
    },
    show(anchor, items) {
      panel.replaceChildren(
        ...items.map((item) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'menu-item';
          button.dataset.testid = item.testid;
          button.setAttribute('role', 'menuitem');
          button.textContent = item.label;
          button.addEventListener('click', () => {
            hide();
            item.onSelect();
          });
          return button;
        }),
      );
      backdrop.hidden = false;
      // Біля кнопки: під нею, а якщо кнопка в нижній половині екрана (панель iPhone) — над нею.
      const r = anchor.getBoundingClientRect();
      const host = backdrop.getBoundingClientRect();
      const gap = 8;
      if (r.top - host.top > host.height / 2) {
        panel.style.top = '';
        panel.style.bottom = `${host.bottom - r.top + gap}px`;
      } else {
        panel.style.bottom = '';
        panel.style.top = `${r.bottom - host.top + gap}px`;
      }
      const width = panel.offsetWidth;
      const left = Math.min(Math.max(r.left - host.left, gap), Math.max(gap, host.width - width - gap));
      panel.style.left = `${left}px`;
      panel.querySelector<HTMLButtonElement>('button')?.focus({ focusVisible: false } as FocusOptions);
    },
    hide,
  };
}

// ───────────────────────── Віконце з полем (назва проєкту) ─────────────────────────

export interface PromptOptions {
  title: string;
  message?: string;
  value: string;
  okLabel: string;
  onOk(value: string): void;
}

export interface Prompt {
  element: HTMLElement;
  readonly open: boolean;
  show(options: PromptOptions): void;
  hide(): void;
}

/** Віконце «Назва проєкту» з полем і кнопками «Скасувати» / «Зберегти» (Enter — те саме, що «Зберегти»). */
export function createPrompt(): Prompt {
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.dataset.testid = 'prompt';
  backdrop.hidden = true;
  const card = document.createElement('form');
  card.className = 'card card--alert card--choice';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.noValidate = true;
  const title = document.createElement('h2');
  title.className = 'card-title';
  title.id = 'prompt-title';
  card.setAttribute('aria-labelledby', title.id);
  const text = document.createElement('p');
  text.className = 'card-text';
  const field = document.createElement('input');
  field.type = 'text';
  // 17 px: менший шрифт у полі змушує Safari на iPhone збільшувати сторінку.
  field.className = 'card-input';
  field.dataset.testid = 'prompt-input';
  field.autocomplete = 'off';
  field.enterKeyHint = 'done';
  field.setAttribute('aria-labelledby', title.id);
  const actions = document.createElement('div');
  actions.className = 'card-actions card-actions--row';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'card-button card-button--cancel';
  cancel.dataset.testid = 'prompt-cancel';
  cancel.textContent = 'Скасувати';
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.className = 'card-button card-button--default';
  ok.dataset.testid = 'prompt-ok';
  actions.append(cancel, ok);
  card.append(title, text, field, actions);
  backdrop.append(card);

  let onOk: ((value: string) => void) | null = null;
  const hide = () => {
    backdrop.hidden = true;
    onOk = null;
  };
  const sync = () => {
    ok.disabled = field.value.trim() === '';
  };
  field.addEventListener('input', sync);
  cancel.addEventListener('click', hide);
  card.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = field.value.trim();
    if (!value || !onOk) return;
    const done = onOk;
    hide();
    done(value);
  });

  return {
    element: backdrop,
    get open() {
      return !backdrop.hidden;
    },
    show(options) {
      title.textContent = options.title;
      text.textContent = options.message ?? '';
      text.hidden = !options.message;
      field.value = options.value;
      ok.textContent = options.okLabel;
      onOk = options.onOk;
      sync();
      backdrop.hidden = false;
      // Курсор у полі, текст виділено — можна одразу надрукувати свою назву або просто натиснути «Зберегти».
      field.focus();
      field.select();
    },
    hide,
  };
}
