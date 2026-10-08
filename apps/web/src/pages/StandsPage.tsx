import { useQuery } from '@tanstack/react-query';
import { Ban, Container, ExternalLink, GitBranch, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { StandDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import type { Tone } from '../ui.tsx';
import { ago, Button, Card, Chip, cx, ErrorBox, Loading, PageHeader, Tip } from '../ui.tsx';

/** Состояние последнего деплоя: подпись и цвет. */
function deployLook(release: NonNullable<StandDto['release']>): { label: string; tone: Tone; hint: string } {
  if (release.lifeCycle && release.lifeCycle !== 'FINISHED') return { label: 'идет деплой', tone: 'blue', hint: 'Деплой на стенд идет прямо сейчас' };
  if (release.state === 'SUCCESS') return { label: 'выкачен', tone: 'green', hint: 'Последний деплой на стенд прошел успешно' };
  return { label: release.state?.toLowerCase() ?? 'неизвестно', tone: 'red', hint: 'Последний деплой на стенд закончился неуспешно' };
}

function StandCard({ s }: { s: StandDto }) {
  const look = s.release ? deployLook(s.release) : null;
  const time = s.release?.finishedAt ?? s.release?.startedAt ?? null;
  return (
    <Card className={cx('p-4', s.blocked && 'opacity-80')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Tip text={s.up === null ? 'Проверить стенд нечем: в профиле нет адреса стенда или пути его проверки (health)' : s.up ? 'Стенд отвечает: проверка стенда вернула 200' : 'Стенд не отвечает: проверка стенда недоступна'}>
              <span className={cx('size-2.5 rounded-full', s.up === null ? 'bg-slate-300 dark:bg-slate-600' : s.up ? 'bg-emerald-500' : 'bg-red-500')} aria-hidden />
            </Tip>
            <h2 className="font-semibold">{s.title}</h2>
            {s.blocked && (
              <Tip text={s.blocked}>
                <Chip tone="slate">
                  <Ban className="size-3" aria-hidden />
                  деплой запрещен
                </Chip>
              </Tip>
            )}
          </div>
          <p className="mt-0.5 font-mono text-xs text-slate-500">
            {s.bambooEnv} · {s.namespace}
          </p>
        </div>
        {s.url && (
          <Tip text="Открыть стенд в новой вкладке">
            <a href={s.url} target="_blank" rel="noreferrer" className="shrink-0 text-slate-400 hover:text-blue-600">
              <ExternalLink className="size-4" aria-hidden />
            </a>
          </Tip>
        )}
      </div>

      {s.release && look ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium">{s.release.name}</span>
            <Tip text={look.hint}>
              <Chip tone={look.tone}>{look.label}</Chip>
            </Tip>
            {time && (
              <Tip text={new Date(time).toLocaleString('ru-RU')}>
                <span className="text-xs text-slate-500">{ago(time)}</span>
              </Tip>
            )}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
            {s.branch && (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3.5" aria-hidden />
                {s.branch}
              </span>
            )}
            {s.task && s.taskUrl && (
              <Tip text="Задача этого релиза в Jira">
                <a href={s.taskUrl} target="_blank" rel="noreferrer" className="font-mono text-blue-700 hover:underline dark:text-blue-400">
                  {s.task}
                </a>
              </Tip>
            )}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">Деплоев на стенд Bamboo не показывает</p>
      )}

      <div className="mt-2 text-xs text-slate-600 dark:text-slate-300">
        {s.image ? (
          <Tip text={`Самый новый под по логам: ${s.image.pod}, пишет в лог с ${new Date(s.image.since).toLocaleString('ru-RU')}`}>
            <span className="inline-flex items-center gap-1">
              <Container className="size-3.5" aria-hidden />
              образ <span className="font-mono">{s.image.tag}</span>
            </span>
          </Tip>
        ) : (
          <span className="text-slate-400">по логам за 3 часа подов не видно</span>
        )}
      </div>

      {s.notes.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-slate-500">
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {s.errors.length > 0 && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{s.errors.join('; ')}</p>}
    </Card>
  );
}

/** Экран "Стенды": что сейчас выкачено на стенды контура репозитория. Только просмотр: деплой идет шагом прогона. */
export function StandsPage() {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles, staleTime: Infinity });
  const [repoId, setRepoId] = useState<string | undefined>(undefined);
  const stands = useQuery({ queryKey: ['stands', repoId ?? 'default'], queryFn: () => api.stands(repoId), staleTime: 60_000 });
  // Выбор репозитория нужен, только если стенды есть у контуров нескольких репозиториев.
  const repos = profiles.data?.repos.filter((r) => profiles.data?.stands.some((s) => s.contour === r.contour)) ?? [];
  const current = repoId ?? repos.find((r) => r.default)?.id ?? repos[0]?.id;

  return (
    <section>
      <PageHeader
        className="mb-4"
        title="Стенды"
        help='Что сейчас выкачено на каждый стенд: релиз и его задача, состояние и время деплоя, образ самого нового пода и отвечает ли стенд. Здесь только просмотр: деплой идет шагом "Деплой на стенд" в прогоне задачи'
        actions={
          <>
            {repos.length > 1 && (
              <Tip text="Стенды какого репозитория показать">
                <select
                  aria-label="Репозиторий"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={current}
                  onChange={(e) => setRepoId(e.target.value)}
                >
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </select>
              </Tip>
            )}
            <Button variant="ghost" icon={RefreshCw} spin={stands.isFetching} onClick={() => void stands.refetch()} title="Перечитать Bamboo, логи стендов и проверить, отвечают ли они">
              Обновить
            </Button>
          </>
        }
      />
      {stands.isLoading && <Loading text="Спрашиваю Bamboo и логи стендов" />}
      {stands.error && <ErrorBox error={stands.error} title="Не удалось узнать, что на стендах" />}
      {stands.data && !stands.data.length && <Card className="p-6 text-sm text-slate-500">У контура этого репозитория нет стендов в профилях</Card>}
      {stands.data && stands.data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {stands.data.map((s) => (
            <StandCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </section>
  );
}
