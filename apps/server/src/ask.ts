import { join } from 'node:path';
import { AgentError } from './agent/claude.ts';
import { PIPELINE_TOOLS } from './agent/policy.ts';
import type { AgentService } from './agent/service.ts';
import { EngineError } from './engine/engine.ts';
import type { EventBus } from './engine/events.ts';
import type { Waiting } from './engine/status.ts';
import type { Redactor } from './lib/redact.ts';
import type { AskRow, EventRow, RunRow, RunStepRow, Store } from './store/db.ts';

/** Шаг, от имени которого отвечает агент: сессии ответов видны в журнале агентов прогона под этим id. */
export const ASK_STEP = 'pilot.ask';
/** Предел стоимости одного ответа: агент читает ленту и код, а не пишет. */
export const ASK_BUDGET_USD = 0.5;
/** Сколько последних событий ленты получает агент. */
const EVENTS = 150;
/** Сколько прошлых ответов прогона агент видит, чтобы вопрос мог продолжать разговор. */
const EARLIER = 3;

/** Что агент знает о прогоне в момент вопроса. */
export interface AskInput {
  run: RunRow;
  title: (stepId: string) => string;
  steps: RunStepRow[];
  waiting: Waiting | undefined;
  /** Последние события ленты, старые первыми. */
  events: EventRow[];
  /** Прошлые отвеченные вопросы прогона, старые первыми. */
  earlier: AskRow[];
  question: string;
  /** Корень Task Pilot: код шагов, документация. */
  root: string;
  /** Рабочая папка задачи из контекста прогона. */
  worktree: string | null;
  now: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Момент по местному времени: ГГГГ-ММ-ДД ЧЧ:ММ:СС. */
export function localTime(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);

function stepLine(s: RunStepRow, index: number, title: (stepId: string) => string): string {
  const parts = [
    `${index + 1}. ${s.stepId} "${title(s.stepId)}": ${s.status}`,
    s.selected ? '' : ', вне плана',
    s.startedAt ? `, начат ${localTime(s.startedAt)}` : '',
    s.finishedAt ? `, закончен ${localTime(s.finishedAt)}` : '',
    s.note ? `; заметка: ${cut(s.note, 300)}` : '',
    s.error ? `; ошибка: ${cut(s.error, 800)}` : '',
  ];
  return parts.join('');
}

const eventLine = (e: EventRow) => `${localTime(e.ts)} [${e.stepId ?? 'прогон'}] ${e.type}: ${cut((e.message ?? '').replace(/\s+/g, ' '), 400)}`;

/**
 * Задание агенту, который отвечает на вопрос владельца о прогоне: шаги с их статусами, заметками и ошибками, ожидание
 * события, последние события ленты, где лежит код шагов и рабочая папка задачи, прошлые ответы и сам вопрос. Агент
 * только читает: ничего не меняет, команд не запускает и владельцу вопросов не задает.
 */
export function askPrompt(i: AskInput): string {
  const run = i.run;
  const lines = [
    `Вопрос владельца о прогоне ${run.issueKey} в Task Pilot. Ты помогаешь понять, что с прогоном: читаешь ленту, шаги, код шагов и рабочую папку задачи и отвечаешь. Ничего не меняешь, команд не запускаешь и вопросов владельцу не задаешь: он ждет ответа здесь.`,
    '',
    `Прогон: пресет ${run.presetId}, статус ${run.status}, репозиторий ${run.repoId}${run.standId ? `, стенд ${run.standId}` : ''}${run.dryRun ? ', пробный прогон' : ''}. Сейчас ${localTime(i.now)}, время здесь и ниже местное.`,
    '',
    'Шаги по порядку:',
    ...i.steps.map((s, n) => stepLine(s, n, i.title)),
    ...(i.waiting ? ['', `Ожидание события: шаг ${i.waiting.stepId} ждет с ${localTime(i.waiting.since)}, событие ${JSON.stringify(i.waiting.event)}`] : []),
    '',
    `Последние события ленты, старые сверху (${i.events.length}):`,
    ...i.events.map(eventLine),
    '',
    'Где читать подробности:',
    `- код шага: ${join(i.root, 'steps')}/<id шага>/ (index.ts, step.yaml, prompt.md), общие модули шагов: ${join(i.root, 'steps', '_shared')}/`,
    `- устройство движка и шагов: ${join(i.root, 'docs')}/ и ${join(i.root, 'CLAUDE.md')}`,
    ...(i.worktree ? [`- рабочая папка задачи: ${i.worktree}`] : []),
    ...(i.earlier.length ? ['', 'Прошлые вопросы владельца в этом прогоне:', ...i.earlier.flatMap((a) => [`Вопрос: ${a.question}`, `Ответ: ${cut(a.answer ?? '', 1500)}`])] : []),
    '',
    `<вопрос>\n${i.question}\n</вопрос>`,
    '',
    'Ответь по-русски, коротко и по делу: что сейчас происходит, почему и что сделать владельцу. Факты из ленты и кода отделяй от догадок, догадку так и называй. Действия владельца в интерфейсе Task Pilot: у строки шага - Повторить, С замечанием (повтор с замечанием агенту шага), Пропустить, Настроить; у прогона - Остановить и главная кнопка (Запустить, Продолжить, проверить событие сейчас). Пиши без буквы ё и длинного тире, кавычки только прямые.',
  ];
  return lines.join('\n');
}

/** Зависимости сервиса вопросов о прогоне. */
export interface AskServiceDeps {
  store: Store;
  bus: EventBus;
  agents: Pick<AgentService, 'forStep'>;
  redact: Redactor;
  /** Название шага по id: в задании агенту шаги подписаны так же, как на экране. */
  title: (stepId: string) => string;
  /** Корень Task Pilot: агент читает код шагов и документацию. */
  root: string;
}

/**
 * Вопросы владельца о прогоне: что происходит, почему шаг стоит или упал. Отвечает агент, который только читает: ленту
 * и шаги в задании, код шагов, документацию и рабочую папку задачи. Вопрос и ответ хранятся у прогона и видны в ленте
 * событиями ask.asked, ask.answered и ask.failed; работа агента в ленту не пишется. Стоимость ответа учитывается в
 * расходе агентов, но не во времени и стоимости прогона.
 */
export class AskService {
  private readonly d: AskServiceDeps;
  /** Ответы, которые агенты сейчас пишут: остановка и ожидание по id вопроса. */
  private readonly pending = new Map<string, { ctl: AbortController; done: Promise<void> }>();

  constructor(deps: AskServiceDeps) {
    this.d = deps;
  }

  /** Вопросы прогона с ответами, старые первыми. */
  list(runId: string): AskRow[] {
    if (!this.d.store.getRun(runId)) throw new EngineError('Прогон не найден', 404);
    return this.d.store.asksOf(runId);
  }

  /**
   * Задает вопрос о прогоне и сразу возвращает его: агент отвечает в фоне, а ответ приходит событием ask.answered.
   * Пока агент отвечает, второй вопрос по тому же прогону не принимается: ответы шли бы вперемешку.
   */
  ask(runId: string, question: string): AskRow {
    const run = this.d.store.getRun(runId);
    if (!run) throw new EngineError('Прогон не найден', 404);
    if (this.d.store.asksOf(runId).some((a) => a.status === 'pending')) throw new EngineError('Агент еще отвечает на прошлый вопрос: дождитесь ответа', 409);
    const text = this.d.redact.text(question.trim());
    const row = this.d.store.createAsk(runId, text);
    this.d.bus.emitEvent({ runId, type: 'ask.asked', message: `Владелец спрашивает: ${cut(text, 300)}`, data: { askId: row.id } });
    const ctl = new AbortController();
    const done = this.answer(run, row, ctl.signal).finally(() => this.pending.delete(row.id));
    this.pending.set(row.id, { ctl, done });
    return row;
  }

  /** Дожидается ответов, которые агенты сейчас пишут. */
  async settled(): Promise<void> {
    await Promise.all([...this.pending.values()].map((p) => p.done));
  }

  /** Останавливает агентов, которые отвечают: их вопросы закрываются ошибкой. */
  close(): void {
    for (const p of this.pending.values()) p.ctl.abort();
  }

  private async answer(run: RunRow, row: AskRow, signal: AbortSignal): Promise<void> {
    // Прогон могли удалить, пока агент отвечал: тогда ни ответа, ни событий у него уже нет.
    const alive = () => this.d.store.getRun(run.id) !== undefined;
    try {
      const context = this.d.store.getContext(run.id);
      const prompt = askPrompt({
        run,
        title: this.d.title,
        steps: this.d.store.getSteps(run.id),
        waiting: context.waiting as Waiting | undefined,
        events: this.d.store.eventsPage(run.id, null, EVENTS).events,
        earlier: this.d.store
          .asksOf(run.id)
          .filter((a) => a.status === 'answered')
          .slice(-EARLIER),
        question: row.question,
        root: this.d.root,
        worktree: typeof context.worktree === 'string' ? context.worktree : null,
        now: new Date(),
      });
      const agent = this.d.agents.forStep({ runId: run.id, stepId: ASK_STEP, manifest: { agent: { model: 'sonnet', browser: false } }, signal, quiet: true });
      // Только чтение: без правок, команд и MCP; вопросы владельцу и отчеты о ходе работы агенту тоже закрыты.
      const r = await agent.run({ label: 'вопрос о прогоне', prompt, cwd: this.d.root, tools: ['Read', 'Grep', 'Glob'], writeCwd: false, deny: [...PIPELINE_TOOLS], maxBudgetUsd: ASK_BUDGET_USD });
      const answer = this.d.redact.text(r.text.trim()) || 'Агент ничего не ответил';
      if (!alive()) return;
      this.d.store.finishAsk(row.id, { answer, costUsd: r.costUsd });
      this.d.bus.emitEvent({ runId: run.id, type: 'ask.answered', message: `Ответ на вопрос: ${cut(answer.replace(/\s+/g, ' '), 300)}`, data: { askId: row.id, costUsd: r.costUsd } });
    } catch (e) {
      if (!alive()) return;
      const error = this.d.redact.text(signal.aborted ? 'Сервер остановился, пока агент отвечал: спросите снова' : e instanceof Error ? e.message : String(e));
      this.d.store.finishAsk(row.id, { error, costUsd: e instanceof AgentError ? (e.result?.costUsd ?? null) : null });
      this.d.bus.emitEvent({ runId: run.id, type: 'ask.failed', message: `Агент не ответил на вопрос: ${error}`, data: { askId: row.id } });
    }
  }
}
