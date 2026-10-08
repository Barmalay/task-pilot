import { useQuery } from '@tanstack/react-query';
import { FileText, RefreshCw } from 'lucide-react';
import { api } from '../api.ts';
import { Button, Card, Chip, Tip } from '../ui.tsx';

/**
 * Галерея артефактов задачи: скриншоты и кадры Kibana теста на стенде с отметкой, есть ли файл во вложениях Jira.
 * Пока идет тест на стенде, список перечитывается сам: скриншоты появляются по ходу прогона.
 */
export function ArtifactsPanel({ runId, live }: { runId: string; live: boolean }) {
  const q = useQuery({
    queryKey: ['artifacts', runId],
    queryFn: () => api.artifacts(runId),
    refetchInterval: live ? 5000 : false,
  });
  const files = q.data?.files ?? [];
  if (!files.length) return null;
  const inJira = files.filter((f) => f.jira === 'same').length;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">
          Артефакты <span className="font-normal text-slate-500">{files.length}</span>
        </h2>
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          spin={q.isFetching}
          onClick={() => void q.refetch()}
          title="Перечитать папку артефактов и вложения задачи в Jira"
        >
          {inJira ? `в Jira ${inJira}` : 'Обновить'}
        </Button>
      </div>
      {q.data?.jiraError && <p className="px-4 pt-2 text-xs text-amber-700 dark:text-amber-400">С вложениями Jira не сверено: {q.data.jiraError}</p>}
      <ul className="grid grid-cols-2 gap-2 p-3">
        {files.map((f) => {
          const url = api.artifactUrl(runId, f.name);
          return (
            <li key={f.name} className="min-w-0">
              <Tip text={`${f.name}, ${Math.max(1, Math.round(f.size / 1024))} КБ. Открыть в новой вкладке`}>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-md ring-1 ring-slate-200 hover:ring-blue-400 dark:ring-slate-700"
                >
                  {f.image ? (
                    <img
                      src={`${url}?v=${encodeURIComponent(f.modified)}`}
                      alt={f.name}
                      loading="lazy"
                      className="aspect-[4/3] w-full bg-slate-50 object-cover object-top dark:bg-slate-800"
                    />
                  ) : (
                    <span className="flex aspect-[4/3] items-center justify-center bg-slate-50 dark:bg-slate-800">
                      <FileText className="size-6 text-slate-400" aria-hidden />
                    </span>
                  )}
                </a>
              </Tip>
              <div className="mt-1 flex items-center gap-1">
                <span className="truncate font-mono text-[11px] text-slate-600 dark:text-slate-300" title={f.name}>
                  {f.name}
                </span>
                {f.jira === 'same' && (
                  <Tip text="Этот файл уже во вложениях задачи в Jira" className="shrink-0">
                    <Chip tone="green" className="whitespace-nowrap">
                      в Jira
                    </Chip>
                  </Tip>
                )}
                {f.jira === 'other' && (
                  <Tip text="Во вложениях Jira другой файл с этим именем: публикация итогов заменит его" className="shrink-0">
                    <Chip tone="amber" className="whitespace-nowrap">
                      в Jira другой
                    </Chip>
                  </Tip>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Карточка галереи артефактов: пустая галерея не занимает места. */
export function ArtifactsCard({ runId, live }: { runId: string; live: boolean }) {
  const panel = <ArtifactsPanel runId={runId} live={live} />;
  return <Card className="empty:hidden">{panel}</Card>;
}
