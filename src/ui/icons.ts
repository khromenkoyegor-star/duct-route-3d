/** Прості іконки інтерфейсу (SVG, колір — currentColor). */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** Папка — «Відкрити скан». */
export const ICON_OPEN = svg(
  '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>' +
    '<path d="M12 11v5M9.5 13.5 12 11l2.5 2.5"/>',
);

/** Рамка з кутами — «Показати все». */
export const ICON_SHOW_ALL = svg(
  '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>' +
    '<path d="m12 7.5 4 2.25v4.5L12 16.5l-4-2.25v-4.5z"/>',
);

/** Лінійка — «Рулетка». */
export const ICON_RULER = svg(
  '<path d="M3.5 15.5 15.5 3.5l5 5-12 12z"/><path d="m7 12 2 2M9.5 9.5l1.5 1.5M12 7l2 2M14.5 4.5 16 6"/>',
);

/** Ламана з вузлами — «Траса». */
export const ICON_ROUTE = svg(
  '<path d="M5 18.5h6.5v-11H19"/><circle cx="5" cy="18.5" r="2"/><circle cx="11.5" cy="7.5" r="2"/><circle cx="19" cy="7.5" r="2"/>',
);

/** Кошик — «Видалити траєкторію». */
export const ICON_TRASH = svg(
  '<path d="M4 6.5h16M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7"/>' +
    '<path d="m6 6.5.9 12.2c.1.9.8 1.8 1.8 1.8h6.6c1 0 1.7-.9 1.8-1.8L18 6.5M10 10.5v6M14 10.5v6"/>',
);
