import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ZoomOut } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { OwnerWaitDto, RunTimingDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import type { FeedTarget } from '../feed.ts';
import { nextSort } from '../sort.ts';
import { activeMs, clock, duration, ganttRows, shares, sortSteps, spent as ms, TIME_LOOK, timeAxis, type StepSort, type StepSortKey, type TimeLook } from '../timing.ts';
import { Button, Card, Chip, cx, Tip } from '../ui.tsx';

const OUTCOME: Record<string, string> = {
  approved: 'подтверждено',
  rework: 'на доработку',
  rejected: 'отклонено',
  stale: 'сгорело',
  answered: 'ответ',
  expired: 'без ответа',
};

/** Самый короткий участок, который можно выделить масштабом: меньше не разглядеть. */
const MIN_ZOOM_MS = 5_000;

/** Куда ведут клики карточки: к шагу в списке и в ленту на событиях отрезка. */
interface Links {
  onJump: (stepId: string) => void;
  onOpenFeed: (target: FeedTarget) => void;
}

function Swatch({ kind }: { kind: TimeLook }) {
  return <span className={cx('inline-block size-2.5 shrink-0 rounded-sm', TIME_LOOK[kind].bar)} aria-hidden />;
}

function Figure({ label, value, detail, hint }: { label: string; value: string; detail?: string; hint: string }) {
  return (
    <Tip text={hint} className="min-w-0 flex-col items-start">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {detail && <span className="text-xs text-slate-500">{detail}</span>}
    </Tip>
  );
}

function average(list: OwnerWaitDto[]): string {
  const done = list.filter((w) => w.to !== null);
  return done.length ? duration(done.reduce((sum, w) => sum + w.ms, 0) / done.length) : '-';
}

/** Сводка: итоговые цифры и полоса долей времени прогона без пауз; пауза видна отдельной цифрой. */
function Summary({ t }: { t: RunTimingDto }) {
  const questions = t.waits.filter((w) => w.kind === 'question');
  const approvals = t.waits.filter((w) => w.kind === 'approval');
  const parts = shares(t);
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Работа" value={ms(t.workMs)} detail={`агент ${ms(t.agentMs)}, системы ${ms(t.systemMs)}`} hint="Шаги выполнялись: агент, сборки и системы и ответы агенту" />
        <Figure
          label="Ждал вас"
          value={ms(t.questionsMs + t.approvalsMs)}
          detail={`вопросов ${questions.length}, подтверждений ${approvals.length}`}
          hint={`Ответы агенту в среднем ${average(questions)}, подтверждения в среднем ${average(approvals)}`}
        />
        <Figure label="Пауза" value={ms(t.pauseMs)} detail="не входит во время прогона" hint={TIME_LOOK.pause.hint} />
        <Figure label="Агент стоил" value={`$${t.costUsd.toFixed(2)}`} hint="Стоимость всех запусков агента в прогоне по отчетам CLI" />
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        {parts.map((p) => (
          <span key={p.kind} className="h-full" style={{ width: `${Math.max(p.percent, 0.5)}%` }}>
            <Tip text={`${TIME_LOOK[p.kind].label}: ${duration(p.ms)}, ${Math.round(p.percent)}%. ${TIME_LOOK[p.kind].hint}`} className="size-full">
              <span className={cx('block size-full', TIME_LOOK[p.kind].bar)} />
            </Tip>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        {parts.map((p) => (
          <span key={p.kind} className="inline-flex items-center gap-1.5">
            <Swatch kind={p.kind} />
            {TIME_LOOK[p.kind].label} <span className="tabular-nums text-slate-500">{duration(p.ms)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Лента: у каждого шага отрезки его времени на общей оси прогона, долгие паузы свернуты в узкие метки. Щелчок по
 * виду времени в легенде скрывает или показывает его, выделение мышью приближает участок (двойной клик - весь
 * прогон), клик по названию шага ведет к шагу в списке, по отрезку - в ленту на событиях этого отрезка.
 */
function Gantt({ t, onJump, onOpenFeed }: { t: RunTimingDto } & Links) {
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<TimeLook>>(new Set());
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  // Клик в конце выделения - не клик по отрезку: он не должен открывать ленту.
  const dragged = useRef(false);
  const axis = timeAxis(t, range ?? undefined);
  const rows = ganttRows(t, axis, hidden);
  if (!rows.length || !axis) return null;
  const kinds = (['agent', 'system', 'question', 'approval', 'pause'] as TimeLook[]).filter((k) =>
    k === 'pause' ? t.pauses.length > 0 : t.steps.some((s) => s.segments.some((g) => g.kind === k)),
  );
  const toggle = (k: TimeLook) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const percent = (clientX: number) => {
    const r = area.current!.getBoundingClientRect();
    return Math.min(Math.max(((clientX - r.left) / r.width) * 100, 0), 100);
  };
  const startDrag = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const a = percent(x0);
    let b = a;
    let moved = false;
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      b = percent(ev.clientX);
      if (Math.abs(ev.clientX - x0) > 4) moved = true;
      if (moved) setDrag({ a, b });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!moved) return;
      dragged.current = true;
      const from = axis.at(Math.min(a, b));
      const to = axis.at(Math.max(a, b));
      if (to - from >= MIN_ZOOM_MS) setRange({ from, to });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const open = (stepId: string, from: string) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (stepId !== 'pause') onOpenFeed({ stepId, at: from });
  };
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {kinds.map((k) => (
          <Tip key={k} text={hidden.has(k) ? `Показать на ленте: ${TIME_LOOK[k].label.toLowerCase()}` : `Скрыть с ленты: ${TIME_LOOK[k].label.toLowerCase()}`}>
            <button
              type="button"
              aria-pressed={!hidden.has(k)}
              onClick={() => toggle(k)}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800',
                hidden.has(k) ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-200',
              )}
            >
              <Swatch kind={k} />
              {TIME_LOOK[k].label}
            </button>
          </Tip>
        ))}
        {range && (
          <Button variant="ghost" size="sm" icon={ZoomOut} onClick={() => setRange(null)} title="Показать весь прогон">
            Весь прогон
          </Button>
        )}
        <span className="ml-auto text-slate-500">Выделите участок мышью, чтобы приблизить</span>
      </div>
      <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-2">
        <div className="space-y-1">
          {rows.map((r) =>
            r.key === 'pause' ? (
              <span key={r.key} className="block h-4 truncate text-xs leading-4 text-slate-500">
                {r.title}
              </span>
            ) : (
              <button
                key={r.key}
                type="button"
                onClick={() => onJump(r.key)}
                title={`${r.title}: показать шаг в списке`}
                className="block h-4 w-full truncate text-left text-xs leading-4 text-slate-700 hover:text-blue-700 hover:underline dark:text-slate-200 dark:hover:text-blue-400"
              >
                {r.title}
              </button>
            ),
          )}
        </div>
        <div ref={area} className="relative cursor-crosshair touch-none space-y-1 select-none" onPointerDown={startDrag} onDoubleClick={() => setRange(null)}>
          {rows.map((r) => (
            <div key={r.key} className="relative h-4 rounded bg-slate-50 dark:bg-slate-800/60">
              {/* Подпись свернутой паузы - в строке пауз рядом с меткой: справа от нее, а у правого края - слева. */}
              {r.key === 'pause' &&
                axis.breaks.map((b) => (
                  <span
                    key={b.from}
                    className="pointer-events-none absolute top-0 text-[10px] leading-4 whitespace-nowrap text-slate-500"
                    style={b.left > 75 ? { right: `calc(${100 - b.left}% + 4px)` } : { left: `calc(${b.left + b.width}% + 4px)` }}
                  >
                    пауза {duration(b.ms)}
                  </span>
                ))}
              {r.bars.map((b) => (
                <span key={`${b.kind}-${b.from}`} className="absolute inset-y-0.5" style={{ left: `${b.left}%`, width: `${b.width}%` }}>
                  <Tip text={`${TIME_LOOK[b.kind].label}: ${duration(Date.parse(b.to) - Date.parse(b.from))}, ${clock(b.from)}-${clock(b.to)}${r.key === 'pause' ? '' : '. Открыть события в ленте'}`} className="size-full">
                    <button type="button" aria-label={`${r.title}: ${TIME_LOOK[b.kind].label}, ${clock(b.from)}`} onClick={() => open(r.key, b.from)} className={cx('block size-full rounded-sm', TIME_LOOK[b.kind].bar, r.key !== 'pause' && 'cursor-pointer hover:brightness-110')} />
                  </Tip>
                </span>
              ))}
            </div>
          ))}
          {axis.breaks.map((b) => (
            <span key={b.from} className="absolute inset-y-0" style={{ left: `${b.left}%`, width: `${b.width}%` }}>
              <Tip text={`Пауза ${duration(b.ms)}, ${clock(b.from)}-${clock(b.to)}: на ленте свернута`} className="size-full">
                <span className="gantt-break block size-full rounded-sm" />
              </Tip>
            </span>
          ))}
          {drag && <span className="pointer-events-none absolute inset-y-0 rounded-sm border border-blue-400 bg-blue-500/15" style={{ left: `${Math.min(drag.a, drag.b)}%`, width: `${Math.abs(drag.b - drag.a)}%` }} />}
        </div>
      </div>
      <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 text-[11px] text-slate-500 tabular-nums">
        <span />
        <div className="relative h-4">
          <span className="absolute left-0">{clock(new Date(axis.from).toISOString())}</span>
          <span className="absolute right-0">{t.live && !range ? `${clock(t.end!)}, идет` : clock(new Date(axis.to).toISOString())}</span>
        </div>
      </div>
    </div>
  );
}

const COLUMNS: { key: StepSortKey; label: string; kind?: TimeLook }[] = [
  { key: 'title', label: 'Шаг' },
  { key: 'workMs', label: 'Работа' },
  { key: 'agentMs', label: 'Агент', kind: 'agent' },
  { key: 'systemMs', label: 'Системы', kind: 'system' },
  { key: 'questionsMs', label: 'Ответы агенту', kind: 'question' },
  { key: 'approvalsMs', label: 'Подтверждения', kind: 'approval' },
  { key: 'attempts', label: 'Запусков' },
  { key: 'costUsd', label: 'Агент, $' },
];

/** Шаги прогона: сколько каждый работал и сколько ждал вас; щелчок по столбцу сортирует, по шагу - ведет к нему. */
function StepsTable({ t, onJump }: { t: RunTimingDto; onJump: Links['onJump'] }) {
  const [sort, setSort] = useState<StepSort | null>(null);
  const steps = sortSteps(t.steps, sort);
  return (
    <div className="overflow-x-auto px-4 py-3">
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="text-slate-500">
          <tr>
            {COLUMNS.map((c) => {
              const active = sort?.key === c.key;
              const Arrow = active ? (sort.desc ? ArrowDown : ArrowUp) : null;
              return (
                <th key={c.key} className="py-1 pr-3 font-medium" aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                  <button
                    type="button"
                    onClick={() => setSort((s) => nextSort(s, c.key, ['title']))}
                    title={active ? 'Щелкните еще раз, чтобы сменить направление или вернуть порядок прогона' : `Сортировать по столбцу "${c.label}"`}
                    className={cx('inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200', active && 'text-slate-800 dark:text-slate-200')}
                  >
                    {c.kind && <Swatch kind={c.kind} />}
                    {c.label}
                    {Arrow && <Arrow className="size-3" aria-hidden />}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {steps.map((s) => (
            <tr key={s.stepId}>
              <td className="py-1 pr-3">
                <button type="button" onClick={() => onJump(s.stepId)} title="Показать шаг в списке" className="text-left text-slate-800 hover:text-blue-700 hover:underline dark:text-slate-200 dark:hover:text-blue-400">
                  {s.title}
                </button>
              </td>
              <td className="py-1 pr-3 font-medium">{ms(s.workMs)}</td>
              <td className="py-1 pr-3">{ms(s.agentMs)}</td>
              <td className="py-1 pr-3">{ms(s.systemMs)}</td>
              <td className="py-1 pr-3">{ms(s.questionsMs)}</td>
              <td className="py-1 pr-3">{ms(s.approvalsMs)}</td>
              <td className="py-1 pr-3">{s.attempts || '-'}</td>
              <td className="py-1">{s.costUsd > 0 ? s.costUsd.toFixed(2) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ваши ответы: каждый вопрос агента и каждое подтверждение с тем, сколько оно ждало; клик открывает его в ленте. */
function Waits({ t, onOpenFeed }: { t: RunTimingDto; onOpenFeed: Links['onOpenFeed'] }) {
  if (!t.waits.length) return null;
  const titles = new Map(t.steps.map((s) => [s.stepId, s.title]));
  return (
    <div className="px-4 py-3">
      <h3 className="mb-1.5 text-xs font-medium text-slate-500">Ваши ответы</h3>
      <ul className="space-y-0.5 text-xs">
        {t.waits.map((w) => (
          <li key={`${w.kind}-${w.from}`}>
            <button
              type="button"
              onClick={() => onOpenFeed({ stepId: w.stepId, at: w.from })}
              title={`${titles.get(w.stepId) ?? w.stepId}: ${w.label}. Открыть в ленте`}
              className="grid w-full grid-cols-[3rem_7.5rem_minmax(0,1fr)_auto] items-baseline gap-2 rounded-md px-1 py-0.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
            >
              <span className="text-slate-500 tabular-nums">{clock(w.from)}</span>
              <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <Swatch kind={w.kind} />
                {w.kind === 'question' ? 'Вопрос агента' : 'Подтверждение'}
              </span>
              <span className="truncate text-slate-800 dark:text-slate-200">{w.label}</span>
              <span className="whitespace-nowrap text-right tabular-nums">
                {w.to === null ? <Chip tone="amber">ждет {duration(w.ms)}</Chip> : duration(w.ms)}
                {w.to !== null && w.outcome && OUTCOME[w.outcome] && <span className="ml-1.5 text-slate-500">{OUTCOME[w.outcome]}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Время прогона без пауз: сколько работали шаги (агент, сборки и системы), сколько ждал вас на вопросах агента и
 * подтверждениях; пауза показывается отдельно и в время прогона не входит. Ниже лента по шагам с масштабом и
 * фильтром видов времени, таблица шагов с сортировкой и все ваши ответы; клики ведут к шагу и в ленту. Пока прогон
 * идет, цифры перечитываются по событиям и раз в 15 секунд. Прогон, который еще не запускали, карточку не показывает.
 */
export function TimingPanel({ runId, live, onJump, onOpenFeed }: { runId: string; live: boolean } & Links) {
  const q = useQuery({ queryKey: ['timing', runId], queryFn: () => api.timing(runId), refetchInterval: live ? 15_000 : false });
  const t = q.data;
  if (!t?.start || !t.end) return null;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">
          Время прогона{' '}
          <Tip text={`Без пауз. С паузами ${duration(t.wallMs)}, пауз ${duration(t.pauseMs)}`}>
            <span className="font-normal text-slate-500 tabular-nums">{duration(activeMs(t))}</span>
          </Tip>
        </h2>
        <span className="text-xs text-slate-500 tabular-nums">
          {clock(t.start)}-{clock(t.end)}
          {t.live && (
            <Chip tone="blue" className="ml-2">
              идет
            </Chip>
          )}
        </span>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        <Summary t={t} />
        <Gantt t={t} onJump={onJump} onOpenFeed={onOpenFeed} />
        <StepsTable t={t} onJump={onJump} />
        <Waits t={t} onOpenFeed={onOpenFeed} />
      </div>
    </Card>
  );
}
