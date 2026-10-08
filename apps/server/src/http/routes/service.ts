import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServiceDto } from '@task-pilot/api-types';
import { EngineError } from '../../engine/errors.ts';
import type { ServerDeps } from '../support.ts';

const docQuery = z.object({ path: z.string().min(1) });
const acceptBody = z.strictObject({ path: z.string().min(1), accepted: z.boolean() });

function serviceOf(d: ServerDeps) {
  if (!d.service) throw new EngineError('Служебных сведений нет: сервер собран без них', 404);
  return d.service;
}

/** Экран "Служебное": сведения о запущенном сервере, репозитории, доках на решение и журнале, перезапуск. */
export function serviceRoutes(app: FastifyInstance, d: ServerDeps): void {
  app.get('/api/service', async (): Promise<ServiceDto> => serviceOf(d).status());

  // Ответ уходит до остановки: перезапуск идет отдельным процессом, а страница ждет новый сервер сама.
  app.post('/api/service/restart', async (_req, reply) => {
    serviceOf(d).restart();
    return reply.code(202).send({ ok: true });
  });

  app.get('/api/service/doc', async (req): Promise<{ path: string; text: string }> => {
    const { path } = docQuery.parse(req.query);
    return { path, text: serviceOf(d).doc(path) };
  });

  app.post('/api/service/doc/accept', async (req): Promise<ServiceDto> => {
    const { path, accepted } = acceptBody.parse(req.body);
    serviceOf(d).accept(path, accepted);
    return serviceOf(d).status();
  });
}
