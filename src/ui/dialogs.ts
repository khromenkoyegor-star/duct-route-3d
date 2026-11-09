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
