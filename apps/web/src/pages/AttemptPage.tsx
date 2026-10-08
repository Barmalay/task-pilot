import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Copy, Lock, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AttemptStep } from '@task-pilot/step-kit';
import type { AttemptPathDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { clock, formatDuration, idText, OUTCOME_VIEW, visibleSteps, type StepsMode } from '../attempts.ts';
import { AttemptList } from '../components/AttemptSearch.tsx';
import { EditButton, EditDrawer, useMonitorEdit } from '../components/MonitorEdit.tsx';
import { attemptHref, seriesColor } from '../monitor.ts';
import { Button, Card, Chip, cx, ErrorBox, Loading, Tip, type Tone } from '../ui.tsx';

const KIND: Record<string, { label: string; tone: Tone }> = {
  step: { label: 'шаг', tone: 'blue' },
  action: { label: 'действие', tone: 'violet' },
  error: { label: 'ошибка', tone: 'red' },
  outcome: { label: 'итог', tone: 'green' },
  info: { label: 'служебная', tone: 'slate' },
};

function copy(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}

/** Значения сводки: подписи идентификаторов и значения с копированием; чувствительные - с замком. */
function Ids({ path }: { path: AttemptPathDto }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
      {path.summary.ids.map((id) => (
        <div key={id.key} className="contents">
          <dt className="flex items-center gap-1 text-slate-500">
            {id.label}
            {id.sensitive && (
              <Tip text="Видно только на этом экране: в базу, журналы и агентам не уходит">
                <Lock className="size-3" aria-label="Только на экране" />
              </Tip>
            )}
          </dt>
          <dd className="flex min-w-0 flex-wrap gap-1">
            {id.values.slice(0, 8).map((v) => (
              <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800">
                {id.scope === 'attempt' && !path.seeds.includes(v) ? (
                  <a href={attemptHref(v, path.summary.start ?? undefined)} className="truncate text-blue-700 hover:underline dark:text-blue-300" title="Путь от этого значения">
                    {v}
                  </a>
                ) : (
                  <span className="truncate">{idText(v)}</span>
                )}
                <button type="button" onClick={() => copy(v)} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" aria-label={`Скопировать ${id.label}`}>
                  <Copy className="size-3" aria-hidden />
                </button>
              </span>
            ))}
            {id.values.length > 8 && <span className="text-xs text-slate-500">еще {id.values.length - 8}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Summary({ path }: { path: AttemptPathDto }) {
  const s = path.summary;
  const outcome = OUTCOME_VIEW[s.outcome];
  return (
    <Card className="grid gap-4 px-4 py-3 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={outcome.tone}>{outcome.label}</Chip>
          {s.outcomeLabel && <span className="text-sm font-medium">{s.outcomeLabel}</span>}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-500">начало</dt>
          <dd className="tabular-nums">{s.start ? clock(s.start, true) : '-'}</dd>
          <dt className="text-slate-500">длительность</dt>
          <dd className="tabular-nums">{formatDuration(s.durationMs)}</dd>
          <dt className="text-slate-500">провайдер</dt>
          <dd>{s.providers.join(', ') || '-'}</dd>
          <dt className="text-slate-500">ошибок</dt>
          <dd className={cx(s.errors.length > 0 && 'font-medium text-red-700 dark:text-red-300')}>{s.errors.length}</dd>
        </dl>
        <ul className="space-y-0.5 text-xs text-slate-500">
          {s.services.map((x) => (
            <li key={x.service} className="flex items-center gap-1.5">
              <svg width={10} height={10} aria-hidden>
                <circle cx={5} cy={5} r={4} fill={seriesColor(path.services.findIndex((y) => y.id === x.service))} />
              </svg>
              {path.services.find((y) => y.id === x.service)?.title ?? x.service}: строк {x.lines}, {clock(x.first)} - {clock(x.last)}
            </li>
          ))}
        </ul>
      </div>
      <Ids path={path} />
    </Card>
  );
}

/** Этапы попытки с временем между ними. */
function Milestones({ path }: { path: AttemptPathDto }) {
  const m = path.summary.milestones;
  if (!m.length) return null;
  return (
    <Card className="px-4 py-3">
      <h2 className="mb-2 text-sm font-semibold">Этапы</h2>
      <ol className="flex flex-wrap items-center gap-y-2 text-sm">
        {m.map((x, i) => (
          <li key={`${x.label}-${x.t}`} className="flex items-center">
            {i > 0 && <span className="mx-2 text-xs tabular-nums text-slate-400">→ {formatDuration(x.sincePrev ?? 0)} →</span>}
            <Tip text={`${clock(x.t)}, ${path.services.find((y) => y.id === x.service)?.title ?? x.service}`}>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 dark:bg-slate-800">{x.label}</span>
            </Tip>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function StepRow({ step, color, gap }: { step: AttemptStep; color: string; gap: number }) {
  const [open, setOpen] = useState(false);
  const kind = step.event ? KIND[step.event.kind]! : null;
  const head = step.event ? `${step.event.label}${step.event.detail ? `: ${step.event.detail}` : ''}` : step.message.split('\n')[0]!;
  return (
    <li className={cx('border-l-2 py-1 pl-2', step.error ? 'border-red-400 bg-red-50/60 dark:bg-red-950/30' : 'border-transparent')}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 text-left" aria-expanded={open}>
        <span className="w-24 shrink-0 font-mono text-xs tabular-nums text-slate-500">{clock(step.t)}</span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-400">+{formatDuration(gap)}</span>
        <span className="inline-flex w-28 shrink-0 items-center gap-1 truncate text-xs text-slate-600 dark:text-slate-300">
          <svg width={8} height={8} aria-hidden>
            <circle cx={4} cy={4} r={3.5} fill={color} />
          </svg>
          {step.service}
        </span>
        {kind && <Chip tone={step.error ? 'red' : kind.tone}>{step.error && step.event?.kind !== 'error' ? 'ошибка' : kind.label}</Chip>}
        {!kind && step.error && <Chip tone="red">ошибка</Chip>}
        <span className={cx('min-w-32 flex-1 truncate text-sm', !step.event && 'font-mono text-xs text-slate-600 dark:text-slate-300')}>{head}</span>
        {step.event?.provider && <Chip tone="blue">{step.event.provider}</Chip>}
        {step.fields.length > 0 && (
          <span className="flex w-full min-w-0 flex-wrap gap-x-3 pl-26 text-xs text-slate-500">
            {step.fields.map((f) => (
              <span key={f.label} className="max-w-full truncate" title={`${f.label}: ${f.value}`}>
                {f.label}: {f.value}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-26 space-y-1">
          <pre className="max-h-96 overflow-auto rounded-md bg-slate-50 p-2 font-mono text-xs whitespace-pre-wrap text-slate-700 dark:bg-slate-900 dark:text-slate-200">{step.message}</pre>
          <div className="text-xs text-slate-400">
            {step.level} · {step.logger}
            {step.trace ? ` · трасса ${step.trace}` : ''} · с начала {formatDuration(step.sinceStart)}
          </div>
        </div>
      )}
    </li>
  );
}

/** Хронология: главное или все строки, фильтры по сервисам и тексту; строка раскрывается до текста лога. */
function Timeline({ path }: { path: AttemptPathDto }) {
  const [mode, setMode] = useState<StepsMode>('main');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const present = path.summary.services.map((s) => s.service);
  const shown = useMemo(() => new Set(present.filter((s) => !hidden.has(s))), [present.join(), hidden]);
  const steps = visibleSteps(path.steps, mode, hidden.size ? shown : null, text);
  const colorOf = (service: string) => seriesColor(Math.max(0, path.services.findIndex((s) => s.id === service)));
  return (
    <Card className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Хронология</h2>
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Какие строки показывать">
          {(
            [
              ['main', 'главное'],
              ['all', 'все строки'],
            ] as const
          ).map(([id, title]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              onClick={() => setMode(id)}
              className={cx(
                'rounded-md px-2 py-0.5 text-xs font-medium',
                mode === id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              {title}
            </button>
          ))}
        </div>
        {present.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={!hidden.has(s)}
            onClick={() => setHidden((h) => (h.has(s) ? new Set([...h].filter((x) => x !== s)) : new Set([...h, s])))}
            className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs', hidden.has(s) ? 'text-slate-400 line-through' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200')}
          >
            <svg width={8} height={8} aria-hidden>
              <circle cx={4} cy={4} r={3.5} fill={colorOf(s)} />
            </svg>
            {s}
          </button>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="текст в строках"
          className="ml-auto w-48 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-900"
          aria-label="Фильтр строк по тексту"
        />
        <span className="text-xs tabular-nums text-slate-500">
          {steps.length} из {path.steps.length}
        </span>
      </div>
      {steps.length ? (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {steps.map((s, i) => (
            // Время от предыдущей видимой строки: в режиме "главное" служебные строки между ними не считаются.
            <StepRow key={`${s.service}-${s.t}-${i}`} step={s} color={colorOf(s.service)} gap={i ? s.t - steps[i - 1]!.t : 0} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">Строк под фильтром нет{mode === 'main' ? ': служебные строки видны в режиме "все строки"' : ''}</p>
      )}
    </Card>
  );
}

/**
 * Путь одной попытки входа: сводка (итог, длительность, провайдер, телефон, коды и ключи), этапы с временем между
 * ними, ошибки, хронология по всем сервисам и другие попытки того же человека рядом. Сервер ищет строки кругами по
 * найденным ключам и трассам; телефон и код видны только на этом экране.
 */
export function AttemptPage({ value, at }: { value: string; at: number | null }) {
  const q = useQuery({ queryKey: ['monitor', 'attempt-path', value, at], queryFn: () => api.attemptPath([value], at), enabled: value.trim().length >= 4, staleTime: 60_000 });
  const profile = useQuery({ queryKey: ['monitor', 'attempts', 'profile'], queryFn: api.attemptProfile, staleTime: 60_000 });
  // Правила пути правятся по запросу, только когда у команды есть attempt.yaml: без него путь строится по полям сервисов.
  const edit = useMonitorEdit('attempt');
  return (
    <div className="space-y-4">
      <nav aria-label="Путь" className="flex items-center gap-1 text-sm text-slate-500">
        <a href="#/monitor" className="hover:underline">
          Мониторинг
        </a>
        <ChevronRight className="size-3.5" aria-hidden />
        <span>Путь попытки</span>
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{q.data?.title ?? 'Путь попытки входа'}</h1>
        <Chip className="font-mono">{value}</Chip>
        {q.data && (
          <span className="text-xs tabular-nums text-slate-500">
            искали {clock(q.data.range.from, true)} - {clock(q.data.range.to, true)}, кругов {q.data.rounds}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {profile.data?.configured && <EditButton edit={edit} />}
          <Button variant="ghost" size="sm" icon={RefreshCw} spin={q.isFetching} disabled={q.isFetching} onClick={() => void q.refetch()}>
            Обновить
          </Button>
        </span>
      </div>
      {edit.open && <EditDrawer edit={edit} previewable={false} />}
      {value.trim().length < 4 ? (
        <Card className="p-5 text-sm text-slate-600 dark:text-slate-300">Путь открывается из поиска на экране мониторинга или из строки лога с идентификатором попытки.</Card>
      ) : q.isPending ? (
        <Loading text="Собираю строки попытки во всех сервисах" />
      ) : q.isError ? (
        <ErrorBox error={q.error} title="Путь не собрался" />
      ) : !q.data.steps.length ? (
        <Card className="p-5 text-sm text-slate-600 dark:text-slate-300">В окне вокруг попытки строк с этим значением нет.</Card>
      ) : (
        <>
          {(q.data.truncated || q.data.errors.length > 0) && (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {q.data.truncated && <p>Строк больше предела одного поиска: показаны первые.</p>}
              {q.data.errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          )}
          <Summary path={q.data} />
          <Milestones path={q.data} />
          {q.data.summary.errors.length > 0 && (
            <Card className="px-4 py-3">
              <h2 className="mb-1 text-sm font-semibold">Ошибки</h2>
              <ul className="space-y-0.5 text-sm">
                {q.data.summary.errors.map((e, i) => (
                  <li key={`${e.t}-${i}`} className="flex gap-2">
                    <span className="font-mono text-xs tabular-nums text-slate-500">{clock(e.t)}</span>
                    <span className="text-xs text-slate-500">{e.service}</span>
                    <span className="text-red-700 dark:text-red-300">{e.label}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Timeline path={q.data} />
          {q.data.others.length > 0 && (
            <Card className="px-4 py-3">
              <h2 className="text-sm font-semibold">Другие попытки этого человека рядом</h2>
              <p className="mb-1 text-xs text-slate-500">Найдены по тому же телефону, accountId или другим признакам человека, но это отдельные попытки</p>
              <AttemptList attempts={q.data.others} empty="" />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
