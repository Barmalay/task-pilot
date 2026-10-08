import { z } from 'zod';
import { TASK_INPUTS } from './order.ts';

/** Фазы цикла, по которым группируются шаги. */
export const phases = ['task', 'code', 'ci', 'deploy', 'qa', 'finish', 'meta'] as const;

const stepId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, 'id вида область.действие, например jira.start');

/**
 * Настройка шага. jiraStatus - куда шаг переводит задачу по доске: статус доски, "не переводить" или пустое значение -
 * веха шага milestone из профиля доски (jira.yaml).
 */
const paramSchema = z
  .strictObject({
    type: z.enum(['select', 'text', 'boolean', 'jiraStatus']),
    label: z.string().min(1),
    options: z.array(z.string()).optional(),
    default: z.union([z.string(), z.boolean()]).optional(),
    /** Ключ вехи в профиле доски (jira.yaml), к которой шаг переводит задачу без настройки: у jiraStatus обязателен. */
    milestone: z.string().min(1).optional(),
  })
  .refine((p) => p.type !== 'jiraStatus' || p.milestone !== undefined, { message: 'у настройки jiraStatus нужна веха milestone', path: ['milestone'] });

/** Настройки агента шага; промпт и права шаг собирает сам. */
const agentSchema = z.strictObject({
  /** Модель: opus для тяжелых шагов, sonnet для текстов, haiku для классификации. */
  model: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Предохранитель расхода на один запуск агента. */
  maxBudgetUsd: z.number().positive().optional(),
  /** Агенту нужен QA-браузер: инструменты pipeline qa_browser и qa_kibana_logs. Без этого сервер их отклоняет. */
  browser: z.boolean().default(false),
});

/** События вне прогона, по которым шаг запускается заново: новые замечания в PR и изменения задачи в Jira. */
export const triggerEvents = ['pr.review', 'issue.changed'] as const;

/** Данные экранов, которые шаг может изменить: stands - что выкачено на стендах, artifacts - галерея артефактов задачи. */
export const refreshTargets = ['stands', 'artifacts'] as const;

/** Манифест реализованного шага: steps/<id>/step.yaml. */
export const stepManifestSchema = z.strictObject({
  id: stepId,
  title: z.string().min(1),
  hint: z.string().min(1),
  phase: z.enum(phases),
  kind: z.enum(['code', 'agent', 'hybrid', 'manual']),
  requires: z.array(z.string()).default([]),
  provides: z.array(z.string()).default([]),
  gate: z.enum(['none', 'before', 'publish']).default('none'),
  /** false - шаг только читает, и в пробном прогоне выполняется по-настоящему. */
  sideEffects: z.boolean().default(true),
  interactive: z.boolean().default(false),
  params: z.record(z.string(), paramSchema).default({}),
  agent: agentSchema.optional(),
  /**
   * Петля доработки: после успешного выполнения шага движок заново проводит шаги restart этого прогона и сам шаг,
   * не больше max кругов. Шаг, которому нечего дорабатывать, отвечает "уже сделано", и круга нет.
   */
  loop: z
    .strictObject({
      restart: z.array(stepId).min(1),
      max: z.number().int().min(1).max(10).default(3),
      /** Название петли для людей: по нему панель контекста подписывает круги, например "по тесту: 2". */
      title: z.string().min(1).optional(),
    })
    .optional(),
  /** Что устарело на экранах, когда шаг закончился: интерфейс перечитывает это после его успеха или сбоя. */
  refresh: z.array(z.enum(refreshTargets)).default([]),
  /**
   * Шаг работает по событию вне прогона: pr.review - в PR появились замечания без ответа, issue.changed - задача
   * изменилась в Jira. auto - шаг запускает наблюдатель, иначе владелец с экрана прогона.
   */
  trigger: z.strictObject({ event: z.enum(triggerEvents), auto: z.boolean().default(false) }).optional(),
  /**
   * Фоновый шаг идет рядом с основной цепочкой прогона: не ждет ее и не останавливает ее. Стартует, когда выполнены
   * отмеченные шаги цепочки выше него и есть его requires, поэтому место в пресете - самый ранний момент старта.
   */
  background: z.boolean().default(false),
});

export type StepManifest = z.infer<typeof stepManifestSchema>;
export type TriggerEvent = (typeof triggerEvents)[number];
export type StepTrigger = NonNullable<StepManifest['trigger']>;
export type RefreshTarget = (typeof refreshTargets)[number];

/** Признаки шага из манифеста, по которым ядро и интерфейс ведут себя с шагом, не зная его id. */
export interface StepSigns {
  /** Агенту шага нужен QA-браузер: пока шаг выполняется, галерея артефактов живая. */
  browser: boolean;
  /** Что устарело на экранах, когда шаг закончился. */
  refresh: RefreshTarget[];
  /** Название петли доработки для людей; null - петли нет или она без названия. */
  loopTitle: string | null;
  /** Событие вне прогона, по которому шаг запускается заново; null - шаг идет по порядку плана. */
  trigger: StepTrigger | null;
  /** Шаг идет рядом с основной цепочкой прогона и ее не останавливает. */
  background: boolean;
}

/** Признаки шага по его манифесту; у шага, которого нет в каталоге, признаков нет. */
export function stepSigns(manifest: StepManifest | undefined): StepSigns {
  return {
    browser: manifest?.agent?.browser === true,
    refresh: manifest?.refresh ?? [],
    loopTitle: manifest?.loop?.title ?? null,
    trigger: manifest?.trigger ?? null,
    background: manifest?.background === true,
  };
}

/** Шаг из плана, который еще не реализован: steps/_planned.yaml. */
export const plannedStepSchema = z.strictObject({
  id: stepId,
  title: z.string().min(1),
  hint: z.string().min(1),
  phase: z.enum(phases),
  kind: z.enum(['code', 'agent', 'hybrid', 'manual']),
  gate: z.enum(['none', 'before', 'publish']).default('none'),
  stage: z.number().int().min(1).max(9),
});

export type PlannedStep = z.infer<typeof plannedStepSchema>;

/** Пресет: упорядоченный набор шагов цикла, pipelines/<id>.yaml. */
export const presetSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  hint: z.string().min(1),
  steps: z.array(stepId).min(1),
  /** Шаги пресета, которые по умолчанию не отмечены. */
  off: z.array(stepId).default([]),
  /** Ключи контекста, которые есть в прогоне до первого шага: по умолчанию задача и ее AC, у мастера шагов - описание шага. */
  inputs: z.array(z.string().min(1)).default([...TASK_INPUTS]),
  /** Настройки шагов по умолчанию для прогонов пресета: id шага - значения его настроек (params манифеста). */
  params: z.record(stepId, z.record(z.string(), z.union([z.string(), z.boolean()]))).default({}),
});

export type Preset = z.infer<typeof presetSchema>;

/** Короткий текст ошибки валидации для логов и интерфейса. */
export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`).join('; ');
}
