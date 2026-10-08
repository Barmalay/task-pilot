import type { FastifyInstance } from 'fastify';
import type { BudgetDto, CacheDto, DoctorDto, ProfileDto } from '@task-pilot/api-types';
import { budgetLimitsSchema } from '../../budget.ts';
import { EngineError } from '../../engine/engine.ts';
import type { IdParams, ServerDeps } from '../support.ts';

/**
 * Настройки и окружение: профиль команды и личных настроек, лимиты расхода агентов, место на диске и очистка кэша,
 * проверка окружения машины.
 */
export function settingsRoutes(app: FastifyInstance, d: ServerDeps): void {
  app.get('/api/me', async (): Promise<ProfileDto> => {
    if (!d.profile) throw new EngineError('Профиль команды и личных настроек этому серверу не передан', 404);
    return d.redact.deep(d.profile());
  });
  app.get('/api/budget', async (): Promise<BudgetDto> => d.budget.status());
  // Очистка кэша: ошибка (прогон не завершен, QA-браузер открыт) уходит в ответ, как и остальные отказы API.
  const cacheError = (e: unknown) => new EngineError(e instanceof Error ? e.message : String(e), 409);
  app.get('/api/cache', async (): Promise<CacheDto> => d.cache.status());
  app.post<{ Params: IdParams }>('/api/cache/runs/:id/clear', async (req, reply) => {
    if (!d.store.getRun(req.params.id)) return reply.code(404).send({ error: 'not_found', error_description: 'Прогон не найден' });
    try {
      d.cache.clearRun(req.params.id);
    } catch (e) {
      throw cacheError(e);
    }
    return d.cache.status();
  });
  app.post('/api/cache/runs/clear', async (): Promise<CacheDto> => {
    d.cache.clearCompleted();
    return d.cache.status();
  });
  app.post('/api/cache/qa/clear', async (): Promise<CacheDto> => {
    try {
      await d.cache.clearQa();
    } catch (e) {
      throw cacheError(e);
    }
    return d.cache.status();
  });
  app.put('/api/budget', async (req): Promise<BudgetDto> => d.budget.setLimits(budgetLimitsSchema.parse(req.body)));
  app.get('/api/doctor', async (): Promise<DoctorDto> => d.redact.deep({ checks: (await d.doctor?.()) ?? [], at: new Date().toISOString() }));
}
