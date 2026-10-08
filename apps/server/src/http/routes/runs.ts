import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArtifactsDto, AskDto, AttentionDto, EventDetailsDto, FeedPageDto, ForecastDto, RunHistoryDto, RunJournal, RunTimingDto } from '@task-pilot/api-types';
import { ARTIFACT_NAME, artifactsOf, artifactType } from '../../artifacts.ts';
import { eventDetails } from '../../feed.ts';
import { journalOf } from '../../journal.ts';
import { issueKey } from '../../tasks.ts';
import { historyOf, timingOf } from '../../timing.ts';
import { type IdParams, type ServerDeps, type StepParams, stepTitleOf, stream } from '../support.ts';

const createRunBody = z.strictObject({
  issueKey: z.string().min(1),
  presetId: z.string().optional(),
  repoId: z.string().optional(),
  standId: z.string().nullable().optional(),
  dryRun: z.boolean().optional(),
});
const stepBody = z.strictObject({ description: z.string().min(1).max(4000) });
const optionsBody = z.strictObject({ presetId: z.string().optional(), repoId: z.string().optional(), standId: z.string().nullable().optional(), dryRun: z.boolean().optional() });
const runsQuery = z.object({ issue: z.string().optional() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const feedQuery = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(1000).default(300) });
const selectBody = z.strictObject({ selected: z.boolean() });
const retryBody = z.strictObject({ note: z.string().trim().max(4000).optional() });
const paramsBody = z.strictObject({ params: z.record(z.string(), z.union([z.string().max(200), z.boolean(), z.null()])) });
const decisionBody = z.strictObject({ decision: z.enum(['approve', 'reject', 'rework']), comment: z.string().max(4000).optional() });
const answerBody = z.strictObject({ answer: z.string().trim().min(1).max(4000) });
const askBody = z.strictObject({ question: z.string().trim().min(1).max(4000) });

/**
 * Прогоны: заведение и параметры, шаги, запуск и остановка, подтверждения и ответы агентам, то, что ждет владельца во
 * всех прогонах, вопросы владельца о прогоне, время, журнал, прогноз и история, галерея артефактов, лента и ее поток.
 */
export function runsRoutes(app: FastifyInstance, d: ServerDeps): void {
  const stepTitle = stepTitleOf(d);
  const background = (stepId: string) => d.catalog.entry(stepId)?.manifest.background === true;

  // Что ждет владельца во всех прогонах: подтверждения шагов и вопросы агентов, от ранних к поздним.
  app.get('/api/attention', async (): Promise<AttentionDto[]> => {
    const keyOf = (runId: string) => d.store.getRun(runId)?.issueKey ?? '';
    const items: AttentionDto[] = [
      ...d.store.allPendingApprovals().map((a) => ({ runId: a.runId, issueKey: keyOf(a.runId), kind: 'approval' as const, step: stepTitle(a.stepId), text: a.preview.title, at: a.createdAt })),
      ...d.store.allOpenQuestions().map((q) => ({ runId: q.runId, issueKey: keyOf(q.runId), kind: 'question' as const, step: stepTitle(q.stepId), text: q.question, at: q.createdAt })),
    ];
    return d.redact.deep(items.sort((a, b) => a.at.localeCompare(b.at)));
  });

  // Без параметра - последние прогоны всех задач, с issue - все прогоны одной задачи, новые первыми.
  app.get('/api/runs', async (req) => {
    const { issue } = runsQuery.parse(req.query);
    return issue ? d.store.runsOfIssue(issueKey(issue)) : d.store.listRuns(50);
  });

  // Мастер "Новый шаг": прогон PILOT-<n> с описанием шага сразу запускается, дальше он идет как обычный прогон.
  app.post('/api/pilot/steps', async (req) => d.tasks.draftStep(stepBody.parse(req.body).description));

  app.post('/api/runs', async (req) => {
    const { issueKey, ...rest } = createRunBody.parse(req.body);
    const opened = await d.tasks.open(issueKey, { reuse: false, ...rest });
    return { id: opened.id };
  });

  app.get<{ Params: IdParams }>('/api/runs/:id', async (req) => d.engine.view(req.params.id));

  app.get<{ Params: IdParams }>('/api/runs/:id/timing', async (req, reply): Promise<RunTimingDto | undefined> => {
    const run = d.store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not_found', error_description: 'Прогон не найден' });
    return timingOf(d.store, run, stepTitle, new Date(), background);
  });

  app.get<{ Params: IdParams }>('/api/runs/:id/forecast', async (req, reply): Promise<ForecastDto | undefined> => {
    const f = d.forecast.of(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not_found', error_description: 'Прогон не найден' });
    return f;
  });

  app.get<{ Params: IdParams }>('/api/runs/:id/journal', async (req, reply): Promise<RunJournal | undefined> => {
    if (!d.store.getRun(req.params.id)) return reply.code(404).send({ error: 'not_found', error_description: 'Прогон не найден' });
    return journalOf(d.store, req.params.id, stepTitle, d.redact);
  });

  app.get('/api/timing', async (req): Promise<RunHistoryDto[]> => historyOf(d.store, stepTitle, d.redact, historyQuery.parse(req.query).limit, new Date(), background));

  app.delete<{ Params: IdParams }>('/api/runs/:id', async (req) => d.engine.deleteRun(req.params.id));

  // Галерея артефактов задачи: скриншоты и кадры Kibana теста на стенде со сверкой по вложениям Jira.
  app.get<{ Params: IdParams }>('/api/runs/:id/artifacts', async (req): Promise<ArtifactsDto> => {
    const run = d.engine.view(req.params.id).run;
    return artifactsOf(join(d.engine.artifactsDir(run.id), 'qa'), run.issueKey, d.ports.jira, (t) => d.redact.text(t));
  });

  app.get<{ Params: { id: string; name: string } }>('/api/runs/:id/artifacts/:name', async (req, reply) => {
    const { name } = req.params;
    const file = join(d.engine.artifactsDir(req.params.id), 'qa', name);
    if (!ARTIFACT_NAME.test(name) || !existsSync(file) || !statSync(file).isFile()) return reply.code(404).send({ error: 'not_found', error_description: 'Файла нет' });
    const { type, inline } = artifactType(name);
    reply.header('content-type', type).header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`).header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(file));
  });

  app.post<{ Params: IdParams }>('/api/runs/:id/issue', async (req) => {
    await d.tasks.refresh(req.params.id);
    return d.engine.view(req.params.id);
  });

  // Владелец видел изменения задачи и решил, что дорабатывать не нужно: задача в Jira становится новым снимком прогона,
  // плашка гаснет, а скрытые изменения не всплывут снова при следующем изменении задачи.
  app.post<{ Params: IdParams }>('/api/runs/:id/issue-changes/dismiss', async (req) => {
    await d.tasks.refresh(req.params.id);
    return d.engine.view(req.params.id);
  });

  app.patch<{ Params: IdParams }>('/api/runs/:id', async (req) => {
    d.engine.setOptions(req.params.id, optionsBody.parse(req.body));
    return d.engine.view(req.params.id);
  });

  app.patch<{ Params: StepParams }>('/api/runs/:id/steps/:stepId', async (req) => {
    d.engine.setSelected(req.params.id, req.params.stepId, selectBody.parse(req.body).selected);
    return d.engine.view(req.params.id);
  });

  // Настройки шага в прогоне: значение поверх умолчаний пресета и манифеста, null - снова умолчание. Проверки
  // синхронные, а шаг, который ждал подтверждения, спрашивает его заново в фоне.
  app.patch<{ Params: StepParams }>('/api/runs/:id/steps/:stepId/params', async (req) => {
    void d.engine.setParams(req.params.id, req.params.stepId, paramsBody.parse(req.body).params);
    return d.engine.view(req.params.id);
  });

  app.post<{ Params: IdParams }>('/api/runs/:id/start', async (req) => {
    void d.engine.start(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: StepParams }>('/api/runs/:id/steps/:stepId/retry', async (req) => {
    // Замечание к повтору агент шага получит вместе с ошибкой прошлой попытки; без тела запроса - обычный повтор.
    const { note } = retryBody.parse(req.body ?? {});
    void d.engine.retry(req.params.id, req.params.stepId, note);
    return { ok: true };
  });

  app.post<{ Params: StepParams }>('/api/runs/:id/steps/:stepId/skip', async (req) => {
    // Проверки пропуска синхронные: отказ уходит в ответ, а прогон после пропуска идет дальше в фоне.
    void d.engine.skip(req.params.id, req.params.stepId);
    return { ok: true };
  });

  app.post<{ Params: IdParams }>('/api/runs/:id/stop', async (req) => {
    d.engine.stop(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: IdParams }>('/api/approvals/:id', async (req) => {
    const body = decisionBody.parse(req.body);
    // Проверки решения синхронные: ошибка уходит в ответ, а выполнение шагов идет дальше в фоне.
    void d.engine.decide(req.params.id, body.decision, body.comment).catch(() => undefined);
    return { ok: true };
  });

  app.post<{ Params: IdParams }>('/api/questions/:id/answer', async (req) => d.agents.answer(req.params.id, answerBody.parse(req.body).answer));

  // Вопросы владельца о прогоне: агент только читает ленту, шаги и код и отвечает в фоне, ответ приходит событием.
  app.get<{ Params: IdParams }>('/api/runs/:id/asks', async (req): Promise<AskDto[]> => d.asks.list(req.params.id));
  app.post<{ Params: IdParams }>('/api/runs/:id/asks', async (req, reply): Promise<AskDto> => {
    const asked = d.asks.ask(req.params.id, askBody.parse(req.body).question);
    reply.code(201);
    return asked;
  });

  // Лента целиком по страницам, от новых к старым: живой поток отдает только последние события.
  app.get<{ Params: IdParams }>('/api/runs/:id/feed', async (req, reply): Promise<FeedPageDto | undefined> => {
    if (!d.store.getRun(req.params.id)) return reply.code(404).send({ error: 'not_found', error_description: 'Прогон не найден' });
    const q = feedQuery.parse(req.query);
    return d.store.eventsPage(req.params.id, q.before ?? null, q.limit);
  });

  // Подробности события: дифф правки и вывод команды агента, содержимое подтверждения, вопрос с ответом.
  app.get<{ Params: { id: string; eventId: string } }>('/api/runs/:id/events/:eventId', async (req, reply): Promise<EventDetailsDto | undefined> => {
    const e = d.store.getEvent(req.params.id, Number(req.params.eventId));
    if (!e) return reply.code(404).send({ error: 'not_found', error_description: 'Событие не найдено' });
    return d.redact.deep(await eventDetails(d.store, d.dataDir, e));
  });

  app.get<{ Params: IdParams }>('/api/runs/:id/events', (req, reply) => {
    const runId = req.params.id;
    if (!d.store.getRun(runId)) return reply.code(404).send({ error: 'not_found', error_description: 'Прогон не найден' });
    const lastId = Number(req.headers['last-event-id'] ?? 0) || 0;
    stream(req, reply, d.bus, d.store.listEvents(runId, lastId, 300), (e) => e.runId === runId);
  });
}
