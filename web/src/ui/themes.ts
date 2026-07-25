/**
 * Themes.
 *
 * Every theme is a set of CSS custom properties applied via a `data-theme`
 * attribute on `<html>`; there is no per-theme layout code and no conditional
 * rendering. That constraint is what keeps the retro themes usable: they change
 * how the app looks, never how it works, so tap targets stay finger-sized and
 * text stays legible even when the palette is from 1985.
 */

export type ThemeId =
  | 'auto'
  | 'dark'
  | 'light'
  | 'win95'
  | 'win31'
  | 'system7'
  | 'platinum'
  | 'workbench'
  | 'dos';

export interface Theme {
  id: ThemeId;
  name: string;
  note: string;
  group: 'Modern' | 'Retro';
  /** Swatch colours for the picker: [background, surface, accent]. */
  swatch: [string, string, string];
}

export const THEMES: Theme[] = [
  {
    id: 'auto',
    name: 'Auto',
    note: 'Follows your device between light and dark.',
    group: 'Modern',
    swatch: ['#12141c', '#f4f5f8', '#7aa2f7'],
  },
  {
    id: 'dark',
    name: 'Dark',
    note: 'The default. Easy on the eyes at 2am, which is when hints get used.',
    group: 'Modern',
    swatch: ['#12141c', '#1b1e29', '#7aa2f7'],
  },
  {
    id: 'light',
    name: 'Light',
    note: 'Plain and bright, for reading in daylight.',
    group: 'Modern',
    swatch: ['#f6f7fa', '#ffffff', '#2f5fd0'],
  },
  {
    id: 'win95',
    name: 'Windows 95',
    note: 'Teal desktop, raised grey buttons, navy title bars.',
    group: 'Retro',
    swatch: ['#008080', '#c0c0c0', '#000080'],
  },
  {
    id: 'win31',
    name: 'Windows 3.1',
    note: 'Flatter and heavier than 95, with double-bevelled edges.',
    group: 'Retro',
    swatch: ['#a0a0a0', '#c0c0c0', '#000080'],
  },
  {
    id: 'system7',
    name: 'System 7',
    note: 'Black on white, hairline borders, dithered grey desktop.',
    group: 'Retro',
    swatch: ['#8f8f8f', '#ffffff', '#000000'],
  },
  {
    id: 'platinum',
    name: 'Mac OS 9',
    note: 'Platinum greys with a soft blue highlight.',
    group: 'Retro',
    swatch: ['#5c5c5c', '#dedede', '#3366cc'],
  },
  {
    id: 'workbench',
    name: 'Workbench 1.3',
    note: 'Amiga blue and orange, four colours and no apologies.',
    group: 'Retro',
    swatch: ['#0055aa', '#ffffff', '#ff8800'],
  },
  {
    id: 'dos',
    name: 'DOS',
    note: 'Text mode: blue panels, grey text, everything monospaced.',
    group: 'Retro',
    swatch: ['#000000', '#0000aa', '#ffff55'],
  },
];

export const DEFAULT_THEME: ThemeId = 'dark';

const STORAGE_KEY = 'omni-uhs:theme';
const SCALE_KEY = 'omni-uhs:text-scale';

export type TextScale = 'small' | 'medium' | 'large';
export const DEFAULT_SCALE: TextScale = 'medium';

const isThemeId = (value: string | null): value is ThemeId =>
  value !== null && THEMES.some((theme) => theme.id === value);

/**
 * Theme and text size live in localStorage rather than IndexedDB.
 *
 * They have to be readable *synchronously*, before the first paint — an async
 * read means the app flashes the default theme on every launch, which is
 * especially ugly going from a dark theme to Workbench blue.
 */
export function readTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function readTextScale(): TextScale {
  try {
    const stored = localStorage.getItem(SCALE_KEY);
    return stored === 'small' || stored === 'large' || stored === 'medium'
      ? stored
      : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE;
  }
}

/** Resolve 'auto' against the device preference. */
export function resolveTheme(id: ThemeId): Exclude<ThemeId, 'auto'> {
  if (id !== 'auto') return id;
  const prefersLight =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  return prefersLight ? 'light' : 'dark';
}

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  root.dataset['theme'] = resolveTheme(id);
  root.dataset['themeChoice'] = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode: the theme just will not persist */
  }
}

export function applyTextScale(scale: TextScale): void {
  document.documentElement.dataset['scale'] = scale;
  try {
    localStorage.setItem(SCALE_KEY, scale);
  } catch {
    /* as above */
  }
}

/** Called once before React mounts. */
export function initTheme(): void {
  applyTheme(readTheme());
  applyTextScale(readTextScale());

  // Keep 'auto' honest when the device flips between light and dark.
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (readTheme() === 'auto') applyTheme('auto');
    });
  }
}
