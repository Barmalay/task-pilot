import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KibanaTarget } from '@task-pilot/step-kit';
import { EngineError } from '../../engine/engine.ts';
import { defaultLogTarget, serviceLogTarget } from '../../qa/logs.ts';
import { agentToken, type IdParams, type ServerDeps } from '../support.ts';

const askBody = z.strictObject({ question: z.string().min(1).max(4000), options: z.array(z.string().min(1).max(200)).max(8).default([]) });
const waitQuery = z.object({ wait: z.coerce.number().int().min(0).max(60).default(25) });
const progressBody = z.strictObject({ message: z.string().min(1).max(500) });
const browserBody = z.strictObject({ actions: z.array(z.record(z.string(), z.unknown())).min(1).max(60) });
const kibanaBody = z.strictObject({
  minutes: z.number().int().positive().max(24 * 60).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  phrases: z.array(z.string().min(1).max(300)).max(20).default([]),
  service: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
});

/** API для MCP-сервера pipeline: вопросы владельцу, прогресс, QA-браузер и логи Kibana; доступ только по токену запуска агента. */
export function agentRoutes(app: FastifyInstance, d: ServerDeps): void {
  app.post('/api/agent/questions', async (req) => {
    const body = askBody.parse(req.body);
    return d.agents.ask(agentToken(req), body.question, body.options);
  });

  app.get<{ Params: IdParams }>('/api/agent/questions/:id', async (req) => {
    const { wait } = waitQuery.parse(req.query);
    return d.agents.wait(agentToken(req), req.params.id, wait * 1000);
  });

  app.post<{ Params: IdParams }>('/api/agent/questions/:id/expire', async (req) => {
    d.agents.expire(agentToken(req), req.params.id);
    return { ok: true };
  });

  app.post('/api/agent/progress', async (req) => {
    d.agents.progress(agentToken(req), progressBody.parse(req.body).message);
    return { ok: true };
  });

  // QA-браузер для агента: песочница агента без сети, поэтому скрипты скилла запускает сервер, и только для шага,
  // которому манифест разрешает браузер.
  const browserSession = (req: FastifyRequest) => {
    const s = d.agents.session(agentToken(req));
    if (!s) throw new EngineError('Неизвестный или завершившийся агент', 401);
    if (d.catalog.entry(s.stepId)?.manifest.agent?.browser !== true) throw new EngineError(`Шагу ${s.stepId} QA-браузер не разрешен`, 403);
    return s;
  };

  app.post('/api/agent/browser', async (req) => {
    const s = browserSession(req);
    const { actions } = browserBody.parse(req.body);
    await d.ports.browser.ensure();
    const output = await d.ports.browser.act(actions, `${d.engine.artifactsDir(s.runId)}/qa`);
    return { output: d.redact.text(output) };
  });

  app.post('/api/agent/kibana-logs', async (req) => {
    const s = browserSession(req);
    const { service, ...q } = kibanaBody.parse(req.body);
    if (!!q.from !== !!q.to) throw new EngineError('Окно времени задается парой from и to', 400);
    let target: KibanaTarget;
    try {
      // Без service - логи по умолчанию из team.yaml пакета команды, с service - логи этого сервиса на стенде прогона.
      target = service ? serviceLogTarget(d.profiles, d.store.getRun(s.runId)?.standId ?? null, service) : defaultLogTarget(d.profiles, d.qaLogs);
    } catch (e) {
      throw new EngineError(e instanceof Error ? e.message : String(e), 400);
    }
    await d.ports.browser.ensure();
    return { output: d.redact.text(await d.ports.browser.kibanaLogs({ ...q, target })) };
  });
}
