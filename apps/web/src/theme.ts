import { useEffect, useState } from 'react';

/** Выбор темы: светлая, темная или как в системе. */
export type Theme = 'light' | 'dark' | 'system';

/** Ключ выбора темы в localStorage; его же читает скрипт в index.html, чтобы страница не мигала светлой до React. */
export const THEME_KEY = 'task-pilot.theme';

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

/** Выбор из хранилища: незнакомое или пустое значение - как в системе. */
export function parseTheme(value: string | null): Theme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Темная ли страница при выборе theme, когда тема системы темная (systemDark) или светлая. */
export function isDark(theme: Theme, systemDark: boolean): boolean {
  return theme === 'system' ? systemDark : theme === 'dark';
}

function stored(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Класс dark на странице и color-scheme: по нему браузер красит полосы прокрутки, поля ввода и списки. */
function apply(theme: Theme): void {
  const dark = isDark(theme, window.matchMedia(SYSTEM_DARK).matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/**
 * Тема страницы и ее смена. Выбор хранится в этом браузере и доходит до других вкладок Task Pilot; "как в системе"
 * следит за темой системы и меняется вместе с ней.
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => {
    apply(theme);
    if (theme !== 'system') return;
    const media = window.matchMedia(SYSTEM_DARK);
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY || e.key === null) setTheme(stored());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const choose = (next: Theme) => {
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Хранилище недоступно (приватный режим): тема действует до перезагрузки страницы.
    }
    setTheme(next);
  };
  return [theme, choose];
}
