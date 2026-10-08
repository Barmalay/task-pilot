import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  AttemptPathDto,
  AttemptProfileDto,
  AttemptSearchDto,
  DashboardDataDto,
  FeaturesDto,
  FeatureStatsDto,
  MonitorEditDto,
  MonitorEditsDto,
  MonitorLinesDto,
  MonitorOverviewDto,
  PanelBreakdownDto,
} from '@task-pilot/api-types';
import type { EditPreview } from '../../monitor/edits.ts';
import { MonitorError } from '../../monitor/service.ts';
import type { IdParams, ServerDeps } from '../support.ts';

const periodQuery = z.object({ period: z.string().default('1h') });
const breakdownQuery = z.object({ period: z.string().default('1h'), by: z.string().min(1).max(310) });
const refreshBody = z.strictObject({ refresh: z.string().min(1).max(10) });
const linesQuery = z.object({
  panel: z.string().min(1).max(100).optional(),
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
  before: z.coerce.number().int().positive().optional(),
});
const idValues = z.array(z.string().min(1).max(128)).max(10);
const attemptSearchBody = z.strictObject({
  ids: idValues.default([]),
  phone: z.string().max(40).optional(),
  sign: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(60).optional(),
  outcome: z.enum(['success', 'failure', 'unknown']).optional(),
  from: z.number().int().positive().optional(),
  to: z.number().int().positive().optional(),
});
const attemptPathBody = z.strictObject({ ids: idValues.min(1), at: z.number().int().positive().optional() });
const editsQuery = z.object({ target: z.string().min(1).max(120) });
const editBody = z.strictObject({ target: z.string().min(1).max(120), message: z.string().min(1).max(4000) });
const previewQuery = z.object({ period: z.string().max(10).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional() });
const featureQuery = z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional() });

/** Панель мониторинга: логи прода только на чтение; ответы маскируются, как все остальное. */
export function monitorRoutes(app: FastifyInstance, d: ServerDeps): void {
  app.get('/api/monitor/overview', async (): Promise<MonitorOverviewDto> => d.redact.deep(await d.monitor.overview()));
  app.get<{ Params: IdParams }>('/api/monitor/dashboards/:id', async (req): Promise<DashboardDataDto> => d.redact.deep(await d.monitor.data(req.params.id, periodQuery.parse(req.query).period)));
  app.patch<{ Params: IdParams }>('/api/monitor/dashboards/:id', async (req) => d.monitor.setRefresh(req.params.id, refreshBody.parse(req.body).refresh));
  app.get<{ Params: { id: string; panel: string } }>('/api/monitor/dashboards/:id/panels/:panel/breakdown', async (req): Promise<PanelBreakdownDto> => {
    const q = breakdownQuery.parse(req.query);
    return d.redact.deep(await d.monitor.breakdown(req.params.id, req.params.panel, q.period, q.by));
  });
  app.get<{ Params: IdParams }>('/api/monitor/dashboards/:id/lines', async (req): Promise<MonitorLinesDto> => {
    const q = linesQuery.parse(req.query);
    return d.redact.deep(await d.monitor.lines(req.params.id, q.panel ?? null, q.from, q.to, q.before ?? null));
  });
  // Путь одной попытки: поиск и путь идут телом POST, чтобы телефон не попадал в адреса; ответы только на экран.
  const attempts = () => {
    if (!d.attempts) throw new MonitorError('Путь попытки этому серверу не передан', 404);
    return d.attempts;
  };
  app.get('/api/monitor/attempts/profile', async (): Promise<AttemptProfileDto> => attempts().profile());
  app.post('/api/monitor/attempts/search', async (req): Promise<AttemptSearchDto> => d.redact.deep(await attempts().search(attemptSearchBody.parse(req.body))));
  app.post('/api/monitor/attempts/path', async (req): Promise<AttemptPathDto> => d.redact.deep(await attempts().path(attemptPathBody.parse(req.body))));
  // Правка мониторинга по запросу: агент готовит черновик, применяет и возвращает версии владелец.
  const edits = () => {
    if (!d.edits) throw new MonitorError('Правка мониторинга этому серверу не передана', 404);
    return d.edits;
  };
  app.get('/api/monitor/edits', async (req): Promise<MonitorEditsDto> => d.redact.deep(edits().list(editsQuery.parse(req.query).target)));
  app.post('/api/monitor/edits', async (req): Promise<MonitorEditDto> => {
    const b = editBody.parse(req.body);
    return d.redact.deep(edits().request(b.target, b.message));
  });
  app.post<{ Params: IdParams }>('/api/monitor/edits/:id/apply', async (req): Promise<MonitorEditsDto> => d.redact.deep(await edits().apply(req.params.id)));
  app.post<{ Params: IdParams }>('/api/monitor/edits/:id/discard', async (req): Promise<MonitorEditsDto> => d.redact.deep(edits().discard(req.params.id)));
  app.get<{ Params: IdParams }>('/api/monitor/edits/:id/preview', async (req): Promise<EditPreview> => d.redact.deep(await edits().preview(req.params.id, previewQuery.parse(req.query))));
  app.post<{ Params: IdParams }>('/api/monitor/versions/:id/revert', async (req): Promise<MonitorEditsDto> => d.redact.deep(await edits().revert(req.params.id)));
  // Воронки фич входа: обзор без запросов к логам и статистика окна дней.
  const features = () => {
    if (!d.features) throw new MonitorError('Воронки фич этому серверу не переданы', 404);
    return d.features;
  };
  app.get('/api/monitor/features', async (): Promise<FeaturesDto> => d.redact.deep(features().list()));
  app.get<{ Params: IdParams }>('/api/monitor/features/:id', async (req): Promise<FeatureStatsDto> => {
    const q = featureQuery.parse(req.query);
    return d.redact.deep(await features().stats(req.params.id, q.from, q.to));
  });
}
