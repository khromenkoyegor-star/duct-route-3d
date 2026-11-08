/** Кольори сцени для світлої й темної теми (системні кольори iOS). */
export interface SceneTheme {
  background: number;
  gridCenter: number;
  grid: number;
  axisX: number;
  axisY: number;
  axisZ: number;
}

export const LIGHT_THEME: SceneTheme = {
  background: 0xf2f2f7, // systemGroupedBackground
  gridCenter: 0x8e8e93,
  grid: 0xc7c7cc,
  axisX: 0xff3b30, // systemRed
  axisY: 0x34c759, // systemGreen
  axisZ: 0x007aff, // systemBlue
};

export const DARK_THEME: SceneTheme = {
  background: 0x000000,
  gridCenter: 0x8e8e93,
  grid: 0x3a3a3c,
  axisX: 0xff453a,
  axisY: 0x30d158,
  axisZ: 0x0a84ff,
};

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function currentTheme(): SceneTheme {
  return darkQuery?.matches ? DARK_THEME : LIGHT_THEME;
}

/** Викликає `onChange`, коли система перемикає світлу/темну тему. Повертає функцію відписки. */
export function watchTheme(onChange: (theme: SceneTheme) => void): () => void {
  if (!darkQuery) return () => {};
  const listener = () => onChange(currentTheme());
  darkQuery.addEventListener('change', listener);
  return () => darkQuery.removeEventListener('change', listener);
}
