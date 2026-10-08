import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import type { CacheDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { runCache, sizeText } from '../disk.ts';
import { Button, Card, Chip, ErrorBox, Loading, Tip } from '../ui.tsx';

/**
 * Место на диске для колонки "Кэш" и карточки: запрос у них общий. Перечитывается, когда окно снова в фокусе, -
 * например после того, как владелец закрыл QA-браузер.
 */
export function useCache() {
  return useQuery({ queryKey: ['cache'], queryFn: api.cache, refetchOnWindowFocus: true });
}

/** Очистка кэша: ответ сервера с новыми размерами сразу ложится в запрос. */
function useClear<T>(clear: (arg: T) => Promise<CacheDto>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: clear, onSuccess: (next) => qc.setQueryData(['cache'], next) });
}

/**
 * Кнопка очистки с подтверждением: первое нажатие спрашивает, второе удаляет. Без label кнопка из одной иконки,
 * для строки таблицы.
 */
function ClearButton({ label, confirm, hint, disabled, pending, onClear }: { label?: string; confirm: string; hint: string; disabled?: boolean; pending: boolean; onClear: () => void }) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="inline-flex items-center gap-1" role="group" aria-label={confirm}>
        <Button
          variant="danger"
          size="sm"
          icon={Eraser}
          onClick={() => {
            setAsking(false);
            onClear();
          }}
        >
          {confirm}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
          Нет
        </Button>
      </span>
    );
  }
  return (
    <Button
      variant={label ? 'secondary' : 'ghost'}
      size="sm"
      icon={pending ? LoaderCircle : Eraser}
      spin={pending}
      disabled={disabled || pending}
      title={hint}
      aria-label={label ? undefined : hint}
      onClick={() => setAsking(true)}
    >
      {label}
    </Button>
  );
}

/** Ячейка колонки "Кэш": сколько места занимают файлы прогона и, у завершенного прогона, кнопка их очистки. */
export function CacheCell({ runId, issueKey }: { runId: string; issueKey: string }) {
  const cache = useCache();
  const clear = useClear(api.clearRunCache);
  const c = runCache(cache.data, runId);
  // Пока размеры не пришли - многоточие; если не пришли совсем, ошибку показывает карточка "Место на диске".
  if (!cache.data) return <span className="text-slate-400">{cache.isError ? '?' : '…'}</span>;
  if (!c) return <span className="text-slate-400">-</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Tip text={c.clearable ? 'Журналы агентов и логи сборок прогона' : 'Прогон не завершен или выполняется: его файлы еще нужны шагам, очистить можно после завершения'}>
        <span className={c.clearable ? undefined : 'text-slate-500'}>{sizeText(c.bytes)}</span>
      </Tip>
      {c.clearable && (
        <ClearButton
          confirm="Очистить"
          hint={`Очистить кэш прогона ${issueKey}: удалятся журналы агентов и логи сборок, время, сбои и лента останутся`}
          pending={clear.isPending}
          onClear={() => clear.mutate(runId)}
        />
      )}
      {clear.error && <span className="text-xs text-red-700 dark:text-red-300">{clear.error.message}</span>}
    </span>
  );
}

/**
 * Место на диске: файлы прогонов с тем, что из них можно очистить, и кэш QA-браузера. Файлы чистятся только у
 * завершенных прогонов, а кэш QA-браузера - только при закрытом браузере: входы на стенды и в Kibana остаются.
 */
export function CacheCard() {
  const cache = useCache();
  const runs = useClear(api.clearCompletedCache);
  const qa = useClear(api.clearQaCache);
  if (cache.isPending) return <Loading text="Считаю место на диске" />;
  if (cache.isError) return <ErrorBox error={cache.error} title="Не удалось посчитать место на диске" />;
  const c = cache.data;
  const error = runs.error ?? qa.error;
  return (
    <Card className="p-4">
      <h2 className="font-semibold">Место на диске</h2>
      <p className="text-xs text-slate-500">
        Файлы прогонов - журналы агентов и логи сборок. Очистка удаляет их только у завершенных прогонов: время, сбои и лента остаются, пропадают подробности
        вызовов агента в ленте. Кэш QA-браузера - сохраненные страницы и скрипты стендов, входы на стенды и в Kibana при очистке остаются.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-4">
        <div className="min-w-56 flex-1 space-y-2">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-slate-500">Файлы прогонов</span>
            <span className="font-medium tabular-nums">{sizeText(c.runsBytes)}</span>
          </div>
          <p className="text-xs text-slate-500">у завершенных {sizeText(c.clearableBytes)}</p>
          <ClearButton
            label="Очистить у завершенных"
            confirm={`Удалить ${sizeText(c.clearableBytes)}`}
            hint={c.clearableBytes ? 'Удалить файлы всех завершенных прогонов; идущие и упавшие прогоны не трогаются' : 'У завершенных прогонов файлов нет'}
            disabled={!c.clearableBytes}
            pending={runs.isPending}
            onClear={() => runs.mutate(undefined)}
          />
        </div>
        <div className="min-w-56 flex-1 space-y-2">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-slate-500">Кэш QA-браузера</span>
            <span className="font-medium tabular-nums">{sizeText(c.qa.bytes)}</span>
          </div>
          <p className="text-xs text-slate-500">{c.qa.running ? <Chip tone="amber">браузер открыт</Chip> : 'браузер закрыт'}</p>
          <ClearButton
            label="Очистить кэш QA-браузера"
            confirm={`Удалить ${sizeText(c.qa.bytes)}`}
            hint={
              c.qa.running
                ? 'QA-браузер открыт: закройте его окно, потом очистите кэш'
                : c.qa.bytes
                  ? 'Удалить кэш страниц, скриптов и шейдеров QA-браузера; входы на стенды и в Kibana останутся'
                  : 'Кэш QA-браузера пуст'
            }
            disabled={c.qa.running || !c.qa.bytes}
            pending={qa.isPending}
            onClear={() => qa.mutate(undefined)}
          />
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error.message}</p>}
    </Card>
  );
}
