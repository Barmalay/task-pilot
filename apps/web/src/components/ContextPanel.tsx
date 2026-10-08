import { ExternalLink } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { WaitEvent } from '@task-pilot/step-kit';
import type { StepDto } from '@task-pilot/api-types';
import { Chip, Tip } from '../ui.tsx';
import { buildVerdict } from '../verdict.ts';
import { waitWords } from '../waiting.ts';

const LABELS: Record<string, string> = {
  status: 'Статус в Jira',
  branch: 'Ветка',
  worktree: 'Рабочая папка',
  rebased: 'Был ребейз',
  plan: 'План',
  changes: 'Изменения',
  testReport: 'Тесты',
  findings: 'Ревью',
  commitSha: 'Коммит',
  pr: 'PR',
  build: 'Сборка',
  ansibleBranch: 'Ветка конфига деплоя',
  ansiblePr: 'PR конфига деплоя',
  release: 'Релиз',
  deployedBuild: 'На стенде',
  qaReport: 'Тест на стенде',
  failedAc: 'Не прошли AC',
  qaFix: 'Доработка по тесту',
  loops: 'Круги доработки',
  qaComment: 'Итоги в Jira',
  prReview: 'Ответ на ревью',
  waiting: 'Ждет',
  merged: 'Мерж',
  wikiPage: 'Вики',
  improvements: 'Разбор прогона',
  newStep: 'Новый шаг',
};

/** Ключи, которые показывает шапка экрана задачи и плашка изменений задачи. */
const IN_HEADER = new Set(['issue', 'repoChoice', 'ac', 'stepRequest', 'issueChanged']);
/** Служебные отметки наблюдателя: что он уже видел в PR и в задаче. */
const INTERNAL = new Set(['prSeen', 'issueSeen']);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="wrap-anywhere text-slate-800 dark:text-slate-200">{children}</dd>
    </div>
  );
}

function show(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Длинное резюме свернуто до нескольких строк: колонка контекста не растягивается на весь экран. */
function Long({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 240) return <p>{text}</p>;
  return (
    <>
      <p className={open ? undefined : 'line-clamp-4'}>{text}</p>
      <button type="button" className="mt-0.5 text-xs text-blue-700 hover:underline dark:text-blue-400" onClick={() => setOpen(!open)}>
        {open ? 'Свернуть' : 'Полностью'}
      </button>
    </>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-wrap gap-1">{children}</div>;
}

/** Ссылка на адрес из внешней системы: ссылкой становится только веб-адрес, иначе просто текст. */
function Link({ url, children }: { url: unknown; children: ReactNode }) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return <span className="font-medium">{children}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline dark:text-blue-400">
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

function Path({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 font-mono text-xs text-slate-500">{children}</p>;
}

/** Что отрисовщикам известно о прогоне. */
interface RenderEnv {
  /** Название петли доработки шага для людей из его манифеста, без названия - id шага. */
  loopTitle: (stepId: string) => string;
  /** Весь контекст прогона: отрисовщику ключа бывают нужны соседние ключи. */
  context: Record<string, unknown>;
}

const RENDER: Record<string, (value: unknown, env: RenderEnv) => ReactNode | undefined> = {
  plan: (v) =>
    isObj(v) && typeof v.summary === 'string' ? (
      <>
        <Long text={v.summary} />
        {typeof v.file === 'string' && <Path>{v.file}</Path>}
      </>
    ) : undefined,

  changes: (v, env) => {
    if (!isObj(v) || typeof v.summary !== 'string') return undefined;
    // Итог сборки - по самой поздней проверке: отчет агента реализации устаревает после проверки и CI.
    const verdict = buildVerdict(env.context);
    return (
      <>
        <Long text={v.summary} />
        <Facts>
          <Chip>файлов: {Array.isArray(v.files) ? v.files.length : 0}</Chip>
          {verdict && (
            <Tip text={verdict.hint}>
              <Chip tone={verdict.tone}>{verdict.label}</Chip>
            </Tip>
          )}
        </Facts>
      </>
    );
  },

  testReport: (v) => {
    if (!isObj(v) || typeof v.tests !== 'number') return undefined;
    const failed = num(v.failures) + num(v.errors);
    const changed = Array.isArray(v.changedTests) ? v.changedTests.filter(isObj) : [];
    const executed = changed.filter((t) => t.executed === true).length;
    return (
      <Facts>
        <Chip>тестов: {v.tests}</Chip>
        <Chip tone={failed ? 'red' : 'green'}>упало: {failed}</Chip>
        <Chip>пропущено: {num(v.skipped)}</Chip>
        {changed.length ? (
          <Chip tone={executed === changed.length ? 'green' : 'amber'}>
            новые и измененные: выполнено {executed} из {changed.length}
          </Chip>
        ) : (
          <Chip>новых и измененных тестов нет</Chip>
        )}
        <Chip>сборок: {num(v.builds)}</Chip>
      </Facts>
    );
  },

  findings: (v) => {
    if (!Array.isArray(v)) return undefined;
    if (!v.length) return 'замечаний нет';
    const fixed = v.filter((f) => isObj(f) && f.fixed === true).length;
    return `находок: ${v.length}, исправлено: ${fixed}`;
  },

  commitSha: (v) =>
    typeof v === 'string' ? (
      <span className="font-mono" title={v}>
        {v.slice(0, 8)}
      </span>
    ) : undefined,

  pr: (v) => {
    if (!isObj(v) || (typeof v.id !== 'number' && typeof v.id !== 'string')) return undefined;
    return (
      <>
        <Link url={v.url}>#{String(v.id)}</Link>
        {typeof v.title === 'string' && v.title && <span className="ml-1.5">{v.title}</span>}
      </>
    );
  },

  build: (v) =>
    isObj(v) && typeof v.key === 'string' ? (
      <>
        <Link url={v.url}>{v.key}</Link>
        {typeof v.tag === 'string' && <Path>образ {v.tag}</Path>}
      </>
    ) : undefined,

  release: (v) => (isObj(v) && typeof v.name === 'string' ? <span className="font-mono">{v.name}</span> : undefined),

  deployedBuild: (v) =>
    isObj(v) && typeof v.stand === 'string' ? (
      <>
        {v.stand}
        {typeof v.tag === 'string' && <span className="font-mono">, образ {v.tag}</span>}
        {typeof v.pod === 'string' && <Path>под {v.pod}</Path>}
      </>
    ) : undefined,

  ansiblePr: (v) => (isObj(v) && (typeof v.id === 'number' || typeof v.id === 'string') ? <Link url={v.url}>#{String(v.id)}</Link> : undefined),

  qaReport: (v) => {
    if (!isObj(v) || !Array.isArray(v.results)) return undefined;
    const results = v.results.filter(isObj);
    const count = (r: string) => results.filter((x) => x.result === r).length;
    const failed = count('не пройден') + count('частично');
    return (
      <>
        {typeof v.summary === 'string' && <Long text={v.summary} />}
        <Facts>
          <Chip tone={failed ? 'red' : 'green'}>
            пройдено {count('пройден')} из {results.length}
          </Chip>
          {failed > 0 && <Chip tone="red">не прошли: {failed}</Chip>}
          {count('не проверен') > 0 && <Chip tone="amber">не проверено: {count('не проверен')}</Chip>}
        </Facts>
        {typeof v.report === 'string' && <Path>{v.report}</Path>}
      </>
    );
  },

  failedAc: (v) => (Array.isArray(v) ? (v.length ? `AC ${v.join(', ')}` : 'нет') : undefined),

  qaFix: (v) => {
    if (!isObj(v) || typeof v.summary !== 'string') return undefined;
    const green = v.buildGreen === true;
    return (
      <>
        <Long text={v.summary} />
        <Facts>
          <Chip>круг {num(v.round)}</Chip>
          {Array.isArray(v.failed) && <Chip>AC {v.failed.join(', ')}</Chip>}
          <Chip>файлов: {Array.isArray(v.files) ? v.files.length : 0}</Chip>
          <Chip tone={green ? 'green' : 'red'}>{green ? 'сборка зеленая' : 'сборка не зеленая'}</Chip>
        </Facts>
      </>
    );
  },

  loops: (v, env) => {
    if (!isObj(v)) return undefined;
    const rounds = Object.entries(v).filter(([, n]) => typeof n === 'number');
    return rounds.length ? rounds.map(([step, n]) => `${env.loopTitle(step)}: ${String(n)}`).join(', ') : undefined;
  },

  qaComment: (v) =>
    isObj(v) && typeof v.id === 'string' ? (
      <>
        <Link url={v.url}>комментарий {v.id}</Link>
        {isObj(v.rendered) && (
          <Path>
            миниатюр {num(v.rendered.images)}, неразобранной разметки {num(v.rendered.unresolved)}
          </Path>
        )}
      </>
    ) : undefined,

  prReview: (v) => {
    if (!isObj(v) || !Array.isArray(v.replies)) return undefined;
    const replies = v.replies.filter(isObj);
    return (
      <>
        {typeof v.summary === 'string' && v.summary && <Long text={v.summary} />}
        <Facts>
          <Chip>PR #{String(v.pr)}</Chip>
          <Chip>ответов: {replies.length}</Chip>
          <Chip>по коду: {replies.filter((r) => r.fixed === true).length}</Chip>
          <Chip tone={v.pending === true ? 'amber' : 'green'}>{v.pending === true ? 'ждут публикации' : 'опубликованы'}</Chip>
        </Facts>
      </>
    );
  },

  waiting: (v) => {
    if (!isObj(v) || !isObj(v.event) || typeof v.event.kind !== 'string') return undefined;
    const event = v.event as unknown as WaitEvent;
    const when = (iso: unknown) => (typeof iso === 'string' ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
    // Ожидание со сроком считается от начала ожидания события, а не от последней проверки.
    const since = when('since' in event ? event.since : v.since);
    const until = 'deadline' in event ? when(event.deadline.at) : '';
    return `${waitWords(event).of}${since ? ` с ${since}` : ''}${until ? `, срок ${until}` : ''}`;
  },

  merged: (v) => (isObj(v) && typeof v.pr === 'number' && v.pr > 0 ? `PR #${v.pr} смержен` : undefined),

  wikiPage: (v) => (isObj(v) && typeof v.title === 'string' ? <Link url={v.url}>{v.title}</Link> : undefined),

  improvements: (v) => {
    if (!isObj(v) || !Array.isArray(v.files)) return undefined;
    return (
      <>
        {typeof v.summary === 'string' && v.summary && <Long text={v.summary} />}
        <Facts>
          <Chip>файлов: {v.files.length}</Chip>
          {typeof v.tests === 'string' && <Chip tone="green">{v.tests}</Chip>}
        </Facts>
        {v.files.length > 0 && <Path>{v.files.filter((f) => typeof f === 'string').join(', ')}</Path>}
      </>
    );
  },

  newStep: (v) =>
    isObj(v) && typeof v.id === 'string' ? (
      <>
        {typeof v.title === 'string' ? v.title : v.id} <span className="font-mono text-xs text-slate-500">{v.id}</span>
        <Path>steps/{v.id}, файлов {Array.isArray(v.files) ? v.files.length : 0}; коммит по вашей команде</Path>
      </>
    ) : undefined,
};

// Для значения неожиданной формы отрисовщик возвращает undefined: тогда оно показывается как есть.
function render(key: string, value: unknown, env: RenderEnv): ReactNode {
  return (Object.hasOwn(RENDER, key) ? RENDER[key]!(value, env) : undefined) ?? show(value);
}

/**
 * Контекст прогона: что шаги узнали и сделали. Известные ключи (план, изменения, тесты, ревью, коммит, PR,
 * сборка, релиз и выкатка, итоги теста на стенде, доработка по ним, публикация, ответ на ревью, ожидание и мерж,
 * вики, разбор прогона и новый шаг) показываются по-русски в читаемом виде, остальные как есть; круги петель
 * подписаны названиями петель из манифестов шагов прогона. Данные задачи показывает шапка экрана, изменения задачи -
 * плашка, а служебные отметки наблюдателя не показываются.
 */
export function ContextPanel({ context, steps }: { context: Record<string, unknown>; steps: Pick<StepDto, 'stepId' | 'loopTitle'>[] }) {
  const rest = Object.entries(context).filter(([k]) => !IN_HEADER.has(k) && !INTERNAL.has(k));
  if (!rest.length) return <p className="px-4 py-6 text-sm text-slate-500">Шаги еще ничего не записали</p>;
  const env: RenderEnv = { loopTitle: (stepId) => steps.find((s) => s.stepId === stepId)?.loopTitle ?? stepId, context };
  return (
    <dl className="divide-y divide-slate-100 px-4 py-2 dark:divide-slate-800">
      {rest.map(([key, value]) => (
        <Row key={key} label={LABELS[key] ?? key}>
          {render(key, value, env)}
        </Row>
      ))}
    </dl>
  );
}
