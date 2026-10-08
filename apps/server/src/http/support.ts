import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ports } from '@task-pilot/step-kit';
import type { DoctorCheckDto, ProfileDto } from '@task-pilot/api-types';
import type { AgentService } from '../agent/service.ts';
import type { AskService } from '../ask.ts';
import type { BudgetService } from '../budget.ts';
import type { CacheService } from '../cache.ts';
import type { CatalogView } from '../catalog/catalog.ts';
import type { PresetEditor } from '../catalog/presets.ts';
import type { Profiles } from '../config.ts';
import { EngineError, type Engine } from '../engine/engine.ts';
import type { EventBus } from '../engine/events.ts';
import type { ForecastService } from '../forecast.ts';
import type { IntegrationService } from '../integrations/service.ts';
import type { Redactor } from '../lib/redact.ts';
import type { AttemptService } from '../monitor/attempts.ts';
import type { EditService } from '../monitor/edits.ts';
import type { FeatureService } from '../monitor/features.ts';
import type { MonitorService } from '../monitor/service.ts';
import type { QaLogs } from '../qa/logs.ts';
import type { ServiceInfo } from '../service.ts';
import type { EventRow, Store } from '../store/db.ts';
import type { TaskService } from '../tasks.ts';

/** Зависимости HTTP API. */
export interface ServerDeps {
  profiles: Profiles;
  store: Store;
  bus: EventBus;
  catalog: CatalogView;
  engine: Engine;
  tasks: TaskService;
  agents: AgentService;
  ports: Ports;
  redact: Redactor;
  /** Интеграции: откуда берется доступ к внешним системам и под какими аккаунтами работает Task Pilot. */
  integrations: IntegrationService;
  /** Правка пресетов из интерфейса. */
  presets: PresetEditor;
  /** Служебная папка: в ней журналы потока агентов, из которых лента берет подробности вызовов. */
  dataDir: string;
  /** Панель мониторинга прода. */
  monitor: MonitorService;
  /** Воронки фич входа; без них раздела фич на мониторинге нет. */
  features?: FeatureService;
  /** Путь одной попытки входа: поиск попыток и хронология одной. */
  attempts?: AttemptService;
  /** Правка мониторинга по запросу в чате: черновик агента, применение и версии. */
  edits?: EditService;
  /** Расход агентов и лимиты на день и неделю. */
  budget: BudgetService;
  /** Место на диске: файлы прогонов и кэш QA-браузера, их очистка. */
  cache: CacheService;
  /** Прогноз времени прогонов по истории. */
  forecast: ForecastService;
  /** Вопросы владельца о прогоне к агенту, который только читает. */
  asks: AskService;
  /** Профиль для панели сбоку: команда и личные настройки; без него панель показывает только аккаунты и историю. */
  profile?: () => ProfileDto;
  /** Проверка окружения машины, как pnpm checkup; без нее проверок нет. */
  doctor?: () => Promise<DoctorCheckDto[]>;
  /** Служебные сведения о запущенном Task Pilot и перезапуск; без них экрана "Служебное" нет. */
  service?: ServiceInfo;
  /** Логи теста на стенде, когда агент не называет сервис: qa.logs team.yaml; без них агент должен назвать сервис. */
  qaLogs?: QaLogs | null;
}

export type IdParams = { id: string };
export type StepParams = { id: string; stepId: string };

/** Токен агента из заголовка: выдается на один запуск и знает только свой прогон и шаг. */
export function agentToken(req: FastifyRequest): string {
  const token = req.headers['x-task-pilot-agent'];
  if (typeof token !== 'string' || !token) throw new EngineError('Нет токена агента', 401);
  return token;
}

/** Название шага для журнала и времени прогона: по каталогу, а у шага вне каталога - его id. */
export function stepTitleOf(d: Pick<ServerDeps, 'catalog'>): (stepId: string) => string {
  return (stepId) => d.catalog.entry(stepId)?.manifest.title ?? stepId;
}

/** Открывает поток SSE и пересылает в него события, прошедшие фильтр. */
export function stream(
  req: FastifyRequest,
  reply: FastifyReply,
  bus: EventBus,
  backlog: EventRow[],
  accept: (e: EventRow) => boolean,
  shape: (e: EventRow) => unknown = (e) => e,
): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (e: EventRow) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(shape(e))}\n\n`);
  res.write('retry: 3000\n\n');
  for (const e of backlog) send(e);
  const onEvent = (e: EventRow) => {
    if (accept(e)) send(e);
  };
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.raw.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
  });
}
