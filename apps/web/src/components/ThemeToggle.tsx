import type { LucideIcon } from 'lucide-react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type Theme } from '../theme.ts';
import { cx, Tip } from '../ui.tsx';

const CHOICES: { theme: Theme; icon: LucideIcon; hint: string }[] = [
  { theme: 'light', icon: Sun, hint: 'Светлая тема' },
  { theme: 'system', icon: Monitor, hint: 'Тема как в системе: меняется вместе с ней' },
  { theme: 'dark', icon: Moon, hint: 'Темная тема' },
];

/** Переключатель темы в шапке: светлая, как в системе или темная. Выбор хранится в этом браузере. */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex shrink-0 items-center rounded-lg border border-slate-200 p-0.5 dark:border-slate-700" role="group" aria-label="Тема">
      {CHOICES.map(({ theme: t, icon: Icon, hint }) => (
        <Tip key={t} text={hint}>
          <button
            type="button"
            onClick={() => setTheme(t)}
            aria-pressed={theme === t}
            aria-label={hint}
            className={cx(
              'rounded-md p-1 transition-colors',
              theme === t ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        </Tip>
      ))}
    </div>
  );
}
