// VisualAssault's full theme catalog with a picker, following Bracketeer's
// and Sweeper's pattern. Keep in sync with themes.css (vendored @ v0.3.0)
// if VisualAssault adds themes.
export const AVAILABLE_THEMES = [
  'blue-oval-theme',
  'bubblegum-theme',
  'commander-keen-theme',
  'electric-lime-theme',
  'flambeau-theme',
  'flambeau-inverse-theme',
  'green-acres-theme',
  'hacker-theme',
  'hawkeye-theme',
  'lava-theme',
  'merica-theme',
  'neon-theme',
  'red-barn-theme',
  'retrowave-theme',
] as const;

export type Theme = (typeof AVAILABLE_THEMES)[number];

export const DEFAULT_THEME: Theme = 'retrowave-theme';

export const THEME_LABELS: Record<Theme, string> = {
  'blue-oval-theme': 'Blue Oval',
  'bubblegum-theme': 'Bubblegum',
  'commander-keen-theme': 'Commander Keen',
  'electric-lime-theme': 'Electric Lime',
  'flambeau-theme': 'Flambeau',
  'flambeau-inverse-theme': 'Flambeau Inverse',
  'green-acres-theme': 'Green Acres',
  'hacker-theme': 'Hacker',
  'hawkeye-theme': 'Hawkeye',
  'lava-theme': 'Lava',
  'merica-theme': 'Merica',
  'neon-theme': 'Neon',
  'red-barn-theme': 'Red Barn',
  'retrowave-theme': 'Retrowave',
};

const STORAGE_KEY = 'playtime-roi-theme';

export function getStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (AVAILABLE_THEMES as readonly string[]).includes(stored)) return stored as Theme;
  } catch {
    // localStorage unavailable
  }
  return null;
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore
  }
}

/** The class goes on document.body so it covers the whole window, dialogs included. */
export function applyTheme(theme: Theme): void {
  AVAILABLE_THEMES.forEach((t) => document.body.classList.remove(t));
  document.body.classList.add(theme);
}
