import { BellRing, CircleCheck, CircleDashed, CircleHelp, Clock3, PauseCircle, Search, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { LogLine, MonitorStats } from '@task-pilot/step-kit';
import type { MonitorAlertDto, MonitorCardDto } from '@task-pilot/api-types';
import { attemptHref, attemptIdsIn, formatValue, seriesColor } from '../monitor.ts';
import { Chip, cx, Tip, type Tone } from '../ui.tsx';

const ALERT_STATE: Record<MonitorAlertDto['state'], { label: string; tone: Tone; icon: typeof BellRing; hint: string }> = {
  firing: { label: 'алерт', tone: 'red', icon: BellRing, hint: 'Условие алерта выполнено при последней проверке' },
  ok: { label: 'норма', tone: 'green', icon: CircleCheck, hint: 'Условие алерта не выполнено' },
  nodata: { label: 'мало данных', tone: 'slate', icon: CircleDashed, hint: 'Строк за окно слишком мало для решения или запрос не прошел' },
  paused: { label: 'опрос выключен', tone: 'slate', icon: PauseCircle, hint: 'У дашборда выключен опрос: алерт не проверяется' },
  pending: { label: 'еще не проверялся', tone: 'slate', icon: Clock3, hint: 'Сервер проверит алерт при ближайшем опросе' },
};

/** Состояние алерта: иконка и подпись вместе с цветом, чтобы цвет не нес смысл в одиночку. */
export function AlertChip({ state }: { state: MonitorAlertDto['state'] }) {
  const s = ALERT_STATE[state];
  const Icon = s.icon;
  return (
    <Tip text={s.hint}>
      <Chip tone={s.tone}>
        <Icon className="size-3.5" aria-hidden />
        {s.label}
      </Chip>
    </Tip>
  );
}

const CARD_STATUS: Record<MonitorCardDto['status'], { label: string; tone: Tone; icon: typeof BellRing }> = {
  alert: { label: 'алерт', tone: 'red', icon: BellRing },
  error: { label: 'запрос не прошел', tone: 'amber', icon: TriangleAlert },
  ok: { label: 'норма', tone: 'green', icon: CircleCheck },
  empty: { label: 'нет дашборда', tone: 'slate', icon: CircleHelp },
};

/** Состояние карточки задачи на обзоре. */
export function CardStatus({ status }: { status: MonitorCardDto['status'] }) {
  const s = CARD_STATUS[status];
  const Icon = s.icon;
  return (
    <Chip tone={s.tone}>
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </Chip>
  );
}

/** Строка алерта: состояние, условие и величина с порогом. */
export function AlertRow({ alert }: { alert: MonitorAlertDto }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <AlertChip state={alert.state} />
      <span className="min-w-0 wrap-anywhere text-slate-700 dark:text-slate-200">{alert.text}</span>
      {alert.value !== null && (
        <span className="text-xs tabular-nums text-slate-500">
          сейчас {formatValue(alert.value, alert.kind)}
          {alert.threshold !== null && `, порог ${formatValue(alert.threshold, alert.kind)}`}
        </span>
      )}
      {alert.since && alert.state === 'firing' && <span className="text-xs text-slate-500">с {new Date(alert.since).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
    </li>
  );
}

/** Нагрузка панели на кластер логов за последние минуты: сколько запросов ушло, сколько ответов из кэша. */
export function LoadLine({ load }: { load: MonitorStats }) {
  const minutes = Math.round(load.windowMs / 60_000);
  return (
    <Tip text="Панель бережет общий кластер: поиски уходят пачками _msearch, одинаковые берутся из кэша, не больше двух запросов одновременно">
      <span className={cx('text-xs tabular-nums', load.errors ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500')}>
        кластер за {minutes} мин: запросов {load.calls}, поисков {load.searches}, из кэша {load.cached}
        {load.avgTookMs !== null && `, в среднем ${load.avgTookMs} мс`}
        {load.errors > 0 && `, ошибок ${load.errors}`}
      </span>
    </Tip>
  );
}

const LEVEL_TONE: Record<string, Tone> = { ERROR: 'red', WARN: 'amber', INFO: 'blue' };

function time(t: number): string {
  return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Текст строки с подсвеченными идентификаторами попытки, которые искали. */
function Highlighted({ text, marks }: { text: string; marks: string[] }) {
  if (!marks.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${marks.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g'));
  return (
    <>
      {parts.map((p, i) =>
        marks.includes(p) ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 text-inherit dark:bg-amber-900/60">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

/**
 * Строки лога: время, уровень, текст (длинный раскрывается кликом), под и версия. Идентификаторы попытки входа в
 * тексте ведут на экран одной попытки.
 */
export function LogLines({ lines, services, highlight = [] }: { lines: LogLine[]; services?: { id: string; title: string }[]; highlight?: string[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!lines.length) return <p className="py-4 text-sm text-slate-500">Строк за это окно нет</p>;
  return (
    <ol className="divide-y divide-slate-100 dark:divide-slate-800">
      {lines.map((l, i) => {
        const expanded = open.has(i);
        const ids = attemptIdsIn(l.message).filter((id) => !highlight.includes(id));
        const service = services?.findIndex((s) => s.id === l.service) ?? -1;
        return (
          <li key={`${l.service}${l.t}${i}`} className="py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span className="tabular-nums">{time(l.t)}</span>
              {services && service >= 0 && (
                <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
                  <svg width={12} height={4} aria-hidden>
                    <line x1={1} y1={2} x2={11} y2={2} stroke={seriesColor(service)} strokeWidth={2} strokeLinecap="round" />
                  </svg>
                  {services[service]!.title}
                </span>
              )}
              {l.level && <Chip tone={LEVEL_TONE[l.level] ?? 'slate'}>{l.level}</Chip>}
              {l.logger && <span className="font-mono">{l.logger.split('.').pop()}</span>}
              {l.pod && <span className="font-mono">{l.pod}</span>}
              {l.version && <span className="font-mono">{l.version}</span>}
            </div>
            <button
              type="button"
              className={cx('mt-1 block w-full text-left font-mono text-xs text-slate-800 whitespace-pre-wrap break-words dark:text-slate-100', !expanded && 'line-clamp-3')}
              onClick={() => setOpen((s) => new Set(s.has(i) ? [...s].filter((x) => x !== i) : [...s, i]))}
              aria-expanded={expanded}
              title={expanded ? 'Свернуть строку' : 'Показать строку целиком'}
            >
              <Highlighted text={l.message} marks={highlight} />
            </button>
            {ids.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {ids.map((id) => (
                  <a key={id} href={attemptHref(id, l.t)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950">
                    <Search className="size-3" aria-hidden />
                    попытка {id.length > 14 ? `${id.slice(0, 8)}...` : id}
                  </a>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
