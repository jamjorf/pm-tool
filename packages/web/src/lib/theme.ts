export type Theme = 'light' | 'dark' | 'system';

const KEY = 'pm.theme';

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  return 'system';
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
}

export function resolvedTheme(): 'light' | 'dark' {
  const t = getTheme();
  if (t !== 'system') return t;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function toggleTheme(): 'light' | 'dark' {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}
