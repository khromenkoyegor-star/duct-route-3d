/** Повідомлення на весь екран, якщо 3D не запустилось. */
export function createFatalMessage(text: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'fatal';
  box.setAttribute('role', 'alert');
  box.textContent = text;
  return box;
}
