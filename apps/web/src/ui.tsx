import type { LucideIcon } from 'lucide-react';
import { CircleHelp, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import type { ComponentProps, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Склеивает классы, пропуская пустые. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Сколько времени прошло с момента: только что, 5 мин, 3 ч или 2 дн назад; пустая строка без момента. */
export function ago(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} ч назад` : `${Math.round(hours / 24)} дн назад`;
}

/** Текущее время, которое обновляется раз в everyMs: подписи "5 мин назад" на долго открытом экране не застывают. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-800',
  secondary:
    'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600 dark:hover:bg-slate-700',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300 dark:text-slate-300 dark:hover:bg-slate-800',
  danger: 'bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50 dark:bg-slate-800 dark:text-red-300 dark:ring-red-800 dark:hover:bg-red-950',
  warning: 'bg-amber-500 text-white hover:bg-amber-600 shadow-sm',
};

const SIZES: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-xs gap-1.5',
  md: 'px-3.5 py-2 text-sm gap-2',
  lg: 'px-5 py-3 text-base gap-2.5',
};

/**
 * Подсказка при наведении мыши и фокусе с клавиатуры. Появляется быстрее системной, не обрезается краем окна
 * и прокручиваемыми блоками, а обертка ловит наведение и у выключенной кнопки, поэтому подсказка может
 * объяснить, почему кнопка выключена. Без текста выводит только содержимое; wide - для пояснения в несколько фраз.
 */
export function Tip({ text, children, className, wide }: { text?: ReactNode; children: ReactNode; className?: string; wide?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const id = useId();
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 300);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const a = anchor.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const below = a.bottom + 6 + b.height <= window.innerHeight - 8;
    setPos({
      top: below ? a.bottom + 6 : Math.max(8, a.top - 6 - b.height),
      left: Math.min(Math.max(8, a.left + a.width / 2 - b.width / 2), window.innerWidth - b.width - 8),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // Подсказка стоит на месте окна, а содержимое прокручивается: при прокрутке она прячется.
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [open]);

  if (!text) return <>{children}</>;
  return (
    <span ref={anchor} className={cx('inline-flex', className)} aria-describedby={id} onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide} onFocus={show} onBlur={hide}>
      {children}
      <span id={id} className="sr-only">
        {text}
      </span>
      {open &&
        createPortal(
          <div
            ref={bubble}
            aria-hidden
            style={pos ?? { top: 0, left: 0, visibility: 'hidden' }}
            className={cx(
              'pointer-events-none fixed z-[100] rounded-md bg-slate-900 px-2.5 py-1.5 text-xs leading-snug font-normal text-white shadow-lg dark:bg-slate-100 dark:text-slate-900',
              wide ? 'max-w-md' : 'max-w-72',
            )}
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Кнопка с иконкой. title показывается подсказкой Tip, в том числе у выключенной кнопки. */
export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  spin,
  className,
  children,
  type,
  title,
  ...rest
}: ComponentProps<'button'> & { variant?: Variant; size?: Size; icon?: LucideIcon; spin?: boolean }) {
  const button = (
    <button
      type={type ?? 'button'}
      className={cx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed',
        // Выключенная кнопка не принимает наведение, и его ловит обертка подсказки.
        title && 'disabled:pointer-events-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {Icon && <Icon className={cx('size-4 shrink-0', spin && 'animate-spin')} aria-hidden />}
      {children}
    </button>
  );
  return title ? (
    <Tip text={title} className={rest.disabled ? 'cursor-not-allowed' : undefined}>
      {button}
    </Tip>
  ) : (
    button
  );
}

/**
 * Заголовок экрана: название, значок подсказки с пояснением, что на экране и как им пользоваться, строка под
 * названием для живых сведений экрана (сколько чего есть) и кнопки справа. Пояснение не занимает место на экране:
 * оно видно при наведении на значок и при фокусе с клавиатуры.
 */
export function PageHeader({
  title,
  help,
  icon,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  help?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {icon}
          {title}
          {help && (
            <Tip text={help} wide>
              <span tabIndex={0} role="img" aria-label="Что на этом экране" className="inline-flex cursor-help rounded-full text-slate-400 outline-offset-2 hover:text-slate-600 dark:hover:text-slate-200">
                <CircleHelp className="size-4" aria-hidden />
              </span>
            </Tip>
          )}
        </h1>
        {children && <div className="mt-0.5 text-sm text-slate-500">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Состояние выпадающей панели у кнопки: открыта ли она и узел, внутри которого кнопка и панель. Панель закрывается
 * Escape, нажатием мимо этого узла и переходом на другой экран.
 */
export function usePopover(): { open: boolean; toggle: () => void; close: () => void; ref: RefObject<HTMLDivElement | null> } {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('hashchange', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('hashchange', close);
    };
  }, [open, close]);
  return { open, toggle, close, ref };
}

/** Выпадающая панель под кнопкой шапки, по правому краю кнопки. */
export function Popover({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="dialog"
      aria-label={label}
      className={cx(
        'absolute top-full right-0 z-30 mt-2 max-h-[calc(100vh-5rem)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl motion-safe:animate-pop-in dark:border-slate-700 dark:bg-slate-900',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Панель, которая выезжает справа поверх экрана. Закрывается Escape, кнопкой, нажатием мимо панели и переходом на
 * другой экран: ссылка в панели сразу показывает свой экран.
 */
export function Drawer({ label, header, onClose, children }: { label: string; header: ReactNode; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  // Фокус ставится только при открытии: Escape и Tab сразу работают внутри панели.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl outline-none motion-safe:animate-drawer-in dark:bg-slate-900"
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0 flex-1">{header}</div>
          <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label="Закрыть панель" />
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Карточка-подложка. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900', className)}>{children}</div>;
}

const TONES = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
} as const;

export type Tone = keyof typeof TONES;

/** Короткая плашка. */
export function Chip({ children, tone = 'slate', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium', TONES[tone], className)}>{children}</span>;
}

/** Индикатор загрузки с подписью. */
export function Loading({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      {text}
    </div>
  );
}

/** Сообщение об ошибке. */
export function ErrorBox({ error, title = 'Что-то пошло не так' }: { error: unknown; title?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 whitespace-pre-wrap">{message}</div>
      </div>
    </div>
  );
}
