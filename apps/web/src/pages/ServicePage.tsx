import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, CircleCheck, FileText, GitBranch, RefreshCw, RotateCcw, ScrollText, Server, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ServiceDocDto, ServiceDto, ServiceLogLineDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { Markdown } from '../components/Markdown.tsx';
import { DOC_KIND, dirtyText, docsShown, restartBlock, restartNeed, restarted, uptimeText } from '../service.ts';
import { RUN_LOOK } from '../status.tsx';
import { ago, Button, Card, Chip, cx, ErrorBox, Loading, PageHeader, useNow } from '../ui.tsx';

/** Сколько страница ждет новый сервер после перезапуска. */
const RESTART_WAIT_MS = 2 * 60_000;
const stamp = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function CardTitle({ icon: Icon, children }: { icon: typeof Server; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 font-semibold dark:border-slate-800">
      <Icon className="size-4 text-slate-500" aria-hidden />
      {children}
    </h2>
  );
}

/** Сервер: когда запущен, нужен ли перезапуск, какие прогоны идут, и сам перезапуск. */
function ServerCard({ data, onRestart, restarting, restartError }: { data: ServiceDto; onRestart: () => void; restarting: boolean; restartError: string | null }) {
  const now = useNow(30_000);
  const s = data.server;
  const need = restartNeed(s);
  const block = restartBlock(s);
  const [showFiles, setShowFiles] = useState(false);
  return (
    <Card>
      <CardTitle icon={Server}>Сервер</CardTitle>
      <div className="space-y-3 px-4 py-3 text-sm">
        <p className="text-slate-700 dark:text-slate-200">
          Запущен {stamp(s.startedAt)}, работает {uptimeText(s.startedAt, now)}. Node {s.node}
          {s.commitAtStart && (
            <>
              , код на коммите <span className="font-mono">{s.commitAtStart}</span>
              {s.commitNow && s.commitNow !== s.commitAtStart && (
                <>
                  , в репозитории уже <span className="font-mono">{s.commitNow}</span>
                </>
              )}
            </>
          )}
          .
        </p>
        <div className={cx('rounded-lg px-3 py-2', need.needed ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200' : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200')}>
          <p className="flex items-start gap-1.5">
            {need.needed ? <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <span>{need.text}</span>
          </p>
          {need.needed && (
            <button type="button" className="mt-1 text-xs underline underline-offset-2" onClick={() => setShowFiles((v) => !v)}>
              {showFiles ? 'Скрыть файлы' : 'Какие файлы'}
            </button>
          )}
          {showFiles && (
            <ul className="mt-1 max-h-48 overflow-y-auto font-mono text-xs">
              {s.changed.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
        {s.installNeeded && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            pnpm-lock.yaml расходится с установленными зависимостями: если сервер после перезапуска не поднимется, выполните в папке Task Pilot pnpm install --offline
          </p>
        )}
        <p className="text-xs text-slate-500">Шаги и пресеты каталог подхватывает сам, интерфейс обновляет сам Vite: их правки перезапуска не требуют.</p>
        <div>
          <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">Прогоны сейчас</h3>
          {s.runs.length ? (
            <ul className="mt-1 space-y-1">
              {s.runs.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <a href={`#/runs/${r.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
                    {r.issueKey}
                  </a>
                  <Chip tone={RUN_LOOK[r.status].tone}>{RUN_LOOK[r.status].label}</Chip>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-slate-500">Ни один прогон не выполняется и не ждет</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            icon={RotateCcw}
            spin={restarting}
            disabled={!!block || restarting}
            variant={need.needed ? 'primary' : 'secondary'}
            onClick={onRestart}
            title={block ?? 'Перезапустить сервер и интерфейс, как pnpm restart: окно в Dock остается, страница обновится сама'}
          >
            {restarting ? 'Перезапускаю' : 'Перезапустить'}
          </Button>
          {restarting && <span className="text-xs text-slate-500">Жду новый сервер, страница обновится сама</span>}
        </div>
        {restartError && (
          <div>
            <ErrorBox error={restartError} title="Перезапуск не прошел" />
            {data.log.restart.length > 0 && <LogLines lines={data.log.restart} />}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Репозиторий Task Pilot: ветка, remote, последние коммиты и незакоммиченные файлы. */
function RepoCard({ repo }: { repo: ServiceDto['repo'] }) {
  const [all, setAll] = useState(false);
  const dirty = all ? repo.dirty : repo.dirty.slice(0, 12);
  return (
    <Card>
      <CardTitle icon={GitBranch}>Репозиторий Task Pilot</CardTitle>
      <div className="space-y-3 px-4 py-3 text-sm">
        {repo.error ? (
          <p className="text-amber-800 dark:text-amber-300">{repo.error}</p>
        ) : (
          <>
            <p className="text-slate-700 dark:text-slate-200">
              Ветка <span className="font-mono">{repo.branch}</span>.{' '}
              {repo.remote ? (
                <>
                  Remote {repo.remote.name}: <span className="font-mono break-all">{repo.remote.url}</span>
                  {repo.remote.ahead !== null && `, не запушено коммитов: ${repo.remote.ahead}`}
                  {repo.remote.behind ? `, отстает на ${repo.remote.behind}` : ''}
                </>
              ) : (
                'Remote нет: коммиты есть только на этой машине'
              )}
            </p>
            <div>
              <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">Последние коммиты</h3>
              <ul className="mt-1 space-y-0.5">
                {repo.commits.map((c) => (
                  <li key={c.hash} className="flex gap-2">
                    <span className="shrink-0 font-mono text-xs leading-5 text-slate-500">{c.hash}</span>
                    <span className="min-w-0 flex-1 wrap-anywhere">{c.subject}</span>
                    <span className="shrink-0 text-xs leading-5 text-slate-500">{ago(c.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">Не закоммичено: {repo.dirty.length}</h3>
              {repo.dirty.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {dirty.map((f) => (
                    <li key={f.path} className="flex items-baseline gap-2">
                      <Chip className="w-8 shrink-0 justify-center font-mono">{f.code.trim()}</Chip>
                      <span className="min-w-0 font-mono text-xs break-all">{f.path}</span>
                      <span className="shrink-0 text-xs text-slate-500">{dirtyText(f.code)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {repo.dirty.length > 12 && (
                <button type="button" className="mt-1 text-xs text-blue-700 hover:underline dark:text-blue-400" onClick={() => setAll((v) => !v)}>
                  {all ? 'Свернуть' : `Все ${repo.dirty.length}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** Окно дока на решение: текст отрисован, "Принято" убирает док из списка, пока его не изменят. */
function DocDialog({ doc, onClose, onAccept, busy }: { doc: ServiceDocDto; onClose: () => void; onAccept: (accepted: boolean) => void; busy: boolean }) {
  const q = useQuery({ queryKey: ['service-doc', doc.path, doc.modified], queryFn: () => api.serviceDoc(doc.path) });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-title"
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl outline-none dark:bg-slate-900"
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <FileText className="size-4 text-slate-500" aria-hidden />
          <div className="min-w-0">
            <h2 id="doc-title" className="truncate font-semibold">
              {doc.title}
            </h2>
            <p className="font-mono text-xs text-slate-500">.claude/{doc.path}</p>
          </div>
          <Button variant="ghost" size="sm" icon={X} className="ml-auto" onClick={onClose} aria-label="Закрыть" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {q.isPending ? <Loading text="Открываю" /> : q.isError ? <ErrorBox error={q.error} title="Не удалось открыть" /> : <Markdown text={q.data.text} className="text-sm text-slate-800 dark:text-slate-100" />}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
          {doc.accepted ? (
            <Button variant="secondary" icon={Undo2} spin={busy} disabled={busy} onClick={() => onAccept(false)} title="Вернуть док в список того, что ждет решения">
              Вернуть в список
            </Button>
          ) : (
            <Button icon={Check} spin={busy} disabled={busy} onClick={() => onAccept(true)} title="Док принят: он уйдет из списка и вернется, если его изменят">
              Принято
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Гайды приемки, журналы решений и планы из .claude, которые ждут решения владельца. */
function DocsCard({ docs }: { docs: ServiceDocDto[] }) {
  const qc = useQueryClient();
  const [showAccepted, setShowAccepted] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const accept = useMutation({
    mutationFn: ({ path, accepted }: { path: string; accepted: boolean }) => api.acceptDoc(path, accepted),
    onSuccess: (data) => {
      qc.setQueryData(['service'], data);
      setOpen(null);
    },
  });
  const shown = docsShown(docs, showAccepted);
  const accepted = docs.filter((d) => d.accepted).length;
  const doc = docs.find((d) => d.path === open);
  return (
    <Card>
      <CardTitle icon={FileText}>Что ждет вашего решения</CardTitle>
      <div className="px-4 py-3 text-sm">
        {shown.length ? (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {shown.map((d) => (
              <li key={d.path} className="flex flex-wrap items-center gap-2 py-2">
                <Chip tone={d.kind === 'acceptance' ? 'blue' : d.kind === 'notes' ? 'violet' : 'slate'}>{DOC_KIND[d.kind]}</Chip>
                {d.questions && <Chip tone="amber">есть вопросы</Chip>}
                {d.accepted && <Chip tone="green">принято</Chip>}
                <button type="button" className="min-w-0 flex-1 text-left font-medium hover:underline" onClick={() => setOpen(d.path)} title="Открыть">
                  {d.title}
                </button>
                <span className="font-mono text-xs text-slate-500">{d.path}</span>
                <span className="text-xs text-slate-500">{ago(d.modified)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-slate-500">Ничего не ждет: все гайды и журналы в .claude приняты</p>
        )}
        {accepted > 0 && (
          <button type="button" className="mt-2 text-xs text-blue-700 hover:underline dark:text-blue-400" onClick={() => setShowAccepted((v) => !v)}>
            {showAccepted ? 'Скрыть принятые' : `Показать принятые: ${accepted}`}
          </button>
        )}
        {accept.error && <ErrorBox error={accept.error} title="Отметка не сохранилась" />}
      </div>
      {doc && <DocDialog doc={doc} busy={accept.isPending} onClose={() => setOpen(null)} onAccept={(value) => accept.mutate({ path: doc.path, accepted: value })} />}
    </Card>
  );
}

function LogLines({ lines }: { lines: ServiceLogLineDto[] }) {
  return (
    <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-700 dark:bg-slate-800 dark:text-slate-200">
      {lines.map((l, i) => (
        <div key={i} className={cx(l.level === 'error' && 'text-red-700 dark:text-red-400', l.level === 'warn' && 'text-amber-700 dark:text-amber-400')}>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

const LOGS = [
  { id: 'current', label: 'Этот запуск' },
  { id: 'previous', label: 'Прошлый запуск' },
  { id: 'restart', label: 'Перезапуск с экрана' },
] as const;

/** Журнал сервера и интерфейса: этот запуск, прошлый (в нем причина, если сервер упал) и вывод перезапуска. */
function LogCard({ log }: { log: ServiceDto['log'] }) {
  const [tab, setTab] = useState<(typeof LOGS)[number]['id']>('current');
  const lines = log[tab];
  const problems = lines.filter((l) => l.level).length;
  return (
    <Card>
      <CardTitle icon={ScrollText}>Журнал сервера</CardTitle>
      <div className="px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-1">
          {LOGS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                'rounded-md px-2 py-1 text-xs font-medium',
                tab === t.id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              {t.label} <span className="tabular-nums opacity-70">{log[t.id].length}</span>
            </button>
          ))}
          {problems > 0 && <Chip tone="red">ошибок и предупреждений: {problems}</Chip>}
        </div>
        {lines.length ? <LogLines lines={lines} /> : <p className="mt-2 text-slate-500">Журнал пуст</p>}
        <p className="mt-2 text-xs text-slate-500">Последние строки .data/launcher.log, launcher.prev.log и restart.log; известные токены скрыты.</p>
      </div>
    </Card>
  );
}

/**
 * Экран "Служебное": запущенный сервер и нужен ли ему перезапуск, прогоны в работе, репозиторий Task Pilot, гайды и
 * журналы, которые ждут решения владельца, и журнал сервера. Перезапуск идет так же, как pnpm restart; страница ждет
 * новый сервер и обновляется сама.
 */
export function ServicePage() {
  const [restart, setRestart] = useState<{ before: string; since: number } | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  // Пока идет перезапуск, сведения опрашиваются и в фоне: окно могли свернуть, а новый сервер нужно заметить сразу.
  const service = useQuery({ queryKey: ['service'], queryFn: api.service, refetchInterval: restart ? 1500 : 30_000, refetchIntervalInBackground: !!restart, retry: !restart });
  const start = useMutation({
    mutationFn: api.restartServer,
    onMutate: () => setRestartError(null),
    onSuccess: () => service.data && setRestart({ before: service.data.server.startedAt, since: Date.now() }),
  });
  // Новый сервер ответил: страница перезагружается, чтобы взять и новый интерфейс.
  const data = service.data;
  useEffect(() => {
    if (!restart) return;
    if (restarted(restart.before, data?.server)) window.location.reload();
    else if (Date.now() - restart.since > RESTART_WAIT_MS) {
      setRestart(null);
      setRestartError('Новый сервер не ответил за 2 минуты. Если страница не открывается, запустите в папке Task Pilot pnpm restart и посмотрите .data/restart.log');
    }
  }, [restart, data, service.dataUpdatedAt, service.errorUpdatedAt]);
  return (
    <section className="space-y-4">
      <PageHeader
        title="Служебное"
        help='Сведения о самом Task Pilot: когда запущен сервер и нужен ли ему перезапуск, что сейчас выполняется, что в репозитории, какие гайды и журналы ждут вашего решения и что сервер писал в журнал. Машину проверяет вкладка "Окружение", расход агентов - "История"'
        actions={
          <Button variant="ghost" icon={RefreshCw} spin={service.isFetching} onClick={() => void service.refetch()} title="Перечитать сведения">
            Обновить
          </Button>
        }
      />
      {service.isPending && <Loading text="Собираю сведения" />}
      {service.error && !restart && <ErrorBox error={service.error} title="Сведения не получены" />}
      {start.error && <ErrorBox error={start.error} title="Перезапуск не начат" />}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <ServerCard data={data} onRestart={() => start.mutate()} restarting={!!restart || start.isPending} restartError={restartError} />
            <RepoCard repo={data.repo} />
          </div>
          <div className="space-y-4">
            <DocsCard docs={data.docs} />
            <LogCard log={data.log} />
          </div>
        </div>
      )}
    </section>
  );
}
