/** Native window backdrop, matched to the renderer `--bg` token in styles.css. */
export const WINDOW_BG = {
  light: '#efeee9',
  dark: '#08080a'
} as const;

export type ThemeName = keyof typeof WINDOW_BG;

export const windowBg = (theme: string): string =>
  (theme === 'dark' ? WINDOW_BG.dark : WINDOW_BG.light);