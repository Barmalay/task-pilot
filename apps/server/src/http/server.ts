import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatZodError } from '@task-pilot/step-kit';
import { EngineError } from '../engine/engine.ts';
import { QA_BROWSER_MARK } from '../qa/browser.ts';
import { agentRoutes } from './routes/agent.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { eventsRoutes } from './routes/events.ts';
import { integrationsRoutes } from './routes/integrations.ts';
import { monitorRoutes } from './routes/monitor.ts';
import { runsRoutes } from './routes/runs.ts';
import { serviceRoutes } from './routes/service.ts';
import { settingsRoutes } from './routes/settings.ts';
import { tasksRoutes } from './routes/tasks.ts';
import type { ServerDeps } from './support.ts';

export { notable } from './routes/events.ts';
export type { ServerDeps } from './support.ts';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Собирает HTTP API. Слушает только localhost и отклоняет запросы с чужих страниц. Маршруты разложены по фичам в
 * `routes/`: каталог и пресеты, настройки, интеграции, задачи, прогоны, API агентов, мониторинг, служебные сведения
 * и общий поток.
 */
export function buildServer(d: ServerDeps): FastifyInstance {
  // forceCloseConnections: открытые потоки SSE иначе не дают серверу закрыться при перезапуске.
  const app = Fastify({ logger: false, forceCloseConnections: true });

  app.addHook('onRequest', async (req, reply) => {
    // Агент ведет QA-браузер: из него интерфейс и API Task Pilot недоступны, иначе агент подтвердил бы свой шаг сам.
    if ((req.headers['user-agent'] ?? '').includes(QA_BROWSER_MARK)) {
      return reply.code(403).send({ error: 'forbidden', error_description: 'Из QA-браузера Task Pilot недоступен' });
    }
    if (!LOCAL_HOST.test(req.headers.host ?? '')) {
      return reply.code(403).send({ error: 'forbidden', error_description: 'API доступно только с localhost' });
    }
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      return reply.code(403).send({ error: 'forbidden', error_description: 'Запрос с чужой страницы отклонен' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-task-pilot'] !== '1') {
      return reply.code(403).send({ error: 'forbidden', error_description: 'Нет заголовка x-task-pilot' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'bad_request', error_description: formatZodError(err) });
    const status = err instanceof EngineError ? err.status : typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500;
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'bad_request', error_description: d.redact.text(err instanceof Error ? err.message : String(err)) });
  });

  app.get('/api/health', async () => ({ ok: true }));
  for (const routes of [catalogRoutes, settingsRoutes, integrationsRoutes, tasksRoutes, runsRoutes, agentRoutes, monitorRoutes, serviceRoutes, eventsRoutes]) routes(app, d);
  return app;
}
