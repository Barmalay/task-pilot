import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Lock, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AttemptCandidateDto, AttemptSearchDto } from '@task-pilot/api-types';
import { api, type AttemptSearchQuery } from '../api.ts';
import { clock, formatDuration, idText, idValues, OUTCOME_VIEW, SEARCH_WINDOWS, splitIds } from '../attempts.ts';
import { attemptHref } from '../monitor.ts';
import { Button, Card, Chip, cx, ErrorBox, Tip } from '../ui.tsx';

interface SearchForm {
  ids: string;
  phone: string;
  window: string;
  from: string;
  to: string;
  sign: string;
  provider: string;
  outcome: '' | 'success' | 'failure' | 'unknown';
}

const EMPTY: SearchForm = { ids: '', phone: '', window: '24h', from: '', to: '', sign: '', provider: '', outcome: '' };

/**
 * Последний поиск попыток: живет только в памяти вкладки, чтобы после пути можно было вернуться к списку, а телефон не
 * попал ни в адрес страницы, ни в хранилище браузера.
 */
let last: { form: SearchForm; result: AttemptSearchDto } | null = null;

function queryOf(f: SearchForm, now: number): AttemptSearchQuery {
  const span = SEARCH_WINDOWS.find((w) => w.id === f.window);
  const from = span ? now - span.ms : f.from ? new Date(f.from).getTime() : undefined;
  const to = span ? now : f.to ? new Date(f.to).getTime() : undefined;
  return {
    ids: splitIds(f.ids),
    ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
    ...(f.sign ? { sign: f.sign } : {}),
    ...(f.provider ? { provider: f.provider } : {}),
    ...(f.outcome ? { outcome: f.outcome } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

const input = 'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';
const label = 'flex flex-col gap-1 text-xs text-slate-500';

/** Список попыток: время, длительность, итог, провайдер, этапы, ошибки, телефон и ссылка на путь. */
export function AttemptList({ attempts, empty }: { attempts: AttemptCandidateDto[]; empty: string }) {
  if (!attempts.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {attempts.map((a, i) => {
        const outcome = OUTCOME_VIEW[a.outcome];
        const phone = idValues(a, 'phone')[0];
        return (
          <li key={`${a.key ?? 'line'}-${a.at}-${i}`} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5">
            <div className="w-32 shrink-0 text-sm tabular-nums">
              <div className="font-medium">{clock(a.at, true)}</div>
              <div className="text-xs text-slate-500">{formatDuration(a.durationMs)}</div>
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone={outcome.tone}>{outcome.label}</Chip>
                {a.outcomeLabel && <span className="text-sm text-slate-700 dark:text-slate-200">{a.outcomeLabel}</span>}
                {a.providers.map((p) => (
                  <Chip key={p} tone="blue">
                    {p}
                  </Chip>
                ))}
                {phone && (
                  <Tip text="Телефон виден только на этом экране">
                    <span className="inline-flex items-center gap-1 text-xs tabular-nums text-slate-600 dark:text-slate-300">
                      <Lock className="size-3" aria-hidden />
                      {idText(phone)}
                    </span>
                  </Tip>
                )}
              </div>
              {a.milestones.length > 0 && <div className="truncate text-xs text-slate-500">{a.milestones.join(' → ')}</div>}
              {a.errors.length > 0 && <div className="truncate text-xs text-red-700 dark:text-red-300">{a.errors.join('; ')}</div>}
              <div className="text-xs text-slate-400">{a.services.join(', ')}</div>
            </div>
            {a.key ? (
              <a href={attemptHref(a.key, a.at)} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950">
                Путь
                <ArrowRight className="size-4" aria-hidden />
              </a>
            ) : (
              <span className="text-xs text-slate-400">нет ключа попытки</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Поиск попыток входа: один или несколько идентификаторов, телефон, признак, провайдер и итог в окне. Все условия
 * сразу: в списке только попытки, где есть каждое. Запрос уходит телом POST, телефон в адрес не попадает.
 */
export function AttemptSearch() {
  const profile = useQuery({ queryKey: ['monitor', 'attempts', 'profile'], queryFn: api.attemptProfile, staleTime: 60_000 });
  const [form, setForm] = useState<SearchForm>(last?.form ?? EMPTY);
  const search = useMutation({
    mutationFn: (q: AttemptSearchQuery) => api.attemptSearch(q),
    onSuccess: (result) => {
      last = { form, result };
    },
  });
  const result = search.data ?? last?.result ?? null;
  const set = <K extends keyof SearchForm>(k: K, v: SearchForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const ready = splitIds(form.ids).length > 0 || form.phone.trim().length > 0 || form.sign.length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) search.mutate(queryOf(form, Date.now()));
  };
  const p = profile.data;
  const groups = [...new Set((p?.signs ?? []).map((s) => s.group))];
  return (
    <Card className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Найти попытку</h2>
        <span className="text-xs text-slate-500">одно или несколько условий, в списке - попытки, где есть все</span>
      </div>
      {p?.error && <p className="text-sm text-amber-800 dark:text-amber-300">{p.error}: путь строится по полям сервисов панели</p>}
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className={cx(label, 'md:col-span-2')}>
          Идентификаторы
          <span className="relative">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-slate-400" aria-hidden />
            <input
              value={form.ids}
              onChange={(e) => set('ids', e.target.value)}
              placeholder={`${(p?.ids ?? []).filter((i) => !i.sensitive).map((i) => i.label).slice(0, 5).join(', ') || 'state, correlationId'}, трасса`}
              className={cx(input, 'pl-8 font-mono')}
              aria-label="Идентификаторы попытки через пробел или запятую"
            />
          </span>
        </label>
        <label className={label}>
          <span className="inline-flex items-center gap-1">
            Телефон
            <Tip text="Телефон уходит на сервер телом запроса и виден только на этом экране: в адрес страницы, базу и журналы он не попадает">
              <Lock className="size-3" aria-label="Только на экране" />
            </Tip>
          </span>
          <input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+7 916 123-45-67" inputMode="tel" autoComplete="off" className={cx(input, 'tabular-nums')} />
        </label>
        <label className={label}>
          Когда
          <select value={form.window} onChange={(e) => set('window', e.target.value)} className={input}>
            {SEARCH_WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
            <option value="custom">свое окно</option>
          </select>
        </label>
        {form.window === 'custom' && (
          <>
            <label className={label}>
              С
              <input type="datetime-local" value={form.from} onChange={(e) => set('from', e.target.value)} className={input} />
            </label>
            <label className={label}>
              По
              <input type="datetime-local" value={form.to} onChange={(e) => set('to', e.target.value)} className={input} />
            </label>
          </>
        )}
        <label className={label}>
          Признак
          <select value={form.sign} onChange={(e) => set('sign', e.target.value)} className={input}>
            <option value="">любой</option>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {(p?.signs ?? [])
                  .filter((s) => s.group === g)
                  .map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className={label}>
          Провайдер
          <select value={form.provider} onChange={(e) => set('provider', e.target.value)} className={input}>
            <option value="">любой</option>
            {(p?.providers ?? []).map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Итог
          <select value={form.outcome} onChange={(e) => set('outcome', e.target.value as SearchForm['outcome'])} className={input}>
            <option value="">любой</option>
            <option value="success">успех</option>
            <option value="failure">отказ</option>
            <option value="unknown">итог не найден</option>
          </select>
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" icon={Search} spin={search.isPending} disabled={!ready || search.isPending} title={ready ? undefined : 'Нужен идентификатор, телефон или признак'}>
            Найти
          </Button>
          {(result || form !== EMPTY) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                last = null;
                search.reset();
                setForm(EMPTY);
              }}
            >
              Очистить
            </Button>
          )}
        </div>
      </form>
      {search.isError && <ErrorBox error={search.error} title="Поиск не прошел" />}
      {result && (
        <div className="space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
          <div className="flex flex-wrap items-baseline gap-x-3 text-xs text-slate-500">
            <span>
              найдено {result.attempts.length}
              {result.truncated ? ', показаны первые' : ''}
            </span>
            <span className="tabular-nums">
              окно {clock(result.range.from, true)} - {clock(result.range.to, true)}
            </span>
            {result.errors.map((e) => (
              <span key={e} className="text-amber-800 dark:text-amber-300">
                {e}
              </span>
            ))}
          </div>
          <AttemptList attempts={result.attempts} empty="Попыток с такими условиями в окне нет" />
        </div>
      )}
    </Card>
  );
}
