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
      ok.focus();
    },
  };
}
