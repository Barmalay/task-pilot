import { z, type ZodType } from 'zod';

/** zod для контрактов в модулях шагов (`StepModule.contracts`): шаги берут его из step-kit. */
export { z };

/**
 * Контракты контекста прогона: схемы значений, которые шаги кладут в контекст по ключам из `provides`, и типы,
 * выведенные из них. Шаги берут отсюда типы значений соседей и не импортируют друг друга, а движок проверяет по
 * реестру `CONTEXT_SCHEMAS` каждый выход шага до записи в контекст. Значения, которые целиком собирает шаг, описаны
 * строгими схемами: чужое поле в них - ошибка. Значения, которые приходят из портов (задача Jira, PR), допускают
 * лишние поля: их форма принадлежит системе, а не шагу.
 */

/** Задача Jira: кладет открытие задачи, обновляет шаг "Доработка по задаче". */
export const issueSchema = z.object({
  key: z.string(),
  summary: z.string(),
  status: z.string(),
  type: z.string().optional(),
  updated: z.string().optional(),
  url: z.string(),
  labels: z.array(z.string()),
  components: z.array(z.string()),
  sprint: z.object({ id: z.number(), name: z.string(), state: z.string() }).nullable(),
  assignee: z.object({ name: z.string(), displayName: z.string().optional() }).nullable(),
  epic: z.string().nullable().optional(),
  description: z.string(),
  comments: z.array(z.object({ id: z.string(), author: z.string(), created: z.string() })).optional(),
});

/** Критерии приемки задачи; null - в описании не найдены, пустой список - метка skip_ac. */
export const acSchema = z.array(z.string()).nullable();

/** Что изменилось в задаче с тех пор, как ее видел прогон: пишет наблюдатель, сбрасывает "Доработка по задаче". */
export const issueChangedSchema = z
  .strictObject({
    at: z.string(),
    status: z.string(),
    changes: z.array(
      z.strictObject({
        kind: z.enum(['status', 'description', 'ac', 'comments', 'fields']),
        text: z.string(),
        returned: z.boolean().optional(),
      }),
    ),
  })
  .nullable();
export type IssueChanged = NonNullable<z.infer<typeof issueChangedSchema>>;

/**
 * Утвержденный план: по нему работают реализация, проверка, доработка и публикация. ac - критерии приемки из раздела
 * плана, когда в описании задачи их нет: владелец утвердил их вместе с планом, и по их номерам идут следующие шаги.
 */
export const planSchema = z.strictObject({
  file: z.string(),
  hash: z.string(),
  summary: z.string(),
  questions: z.array(z.string()),
  ac: z.array(z.string()).min(1).optional(),
});
export type Plan = z.infer<typeof planSchema>;

/** Что сделала реализация: кладется в контекст для проверки и коммита. */
export const changesSchema = z.strictObject({
  summary: z.string(),
  files: z.array(z.string()),
  tests: z.array(z.string()),
  buildGreen: z.boolean(),
  /** Сессия агента: шаг "Проверка" продолжает ее, когда чинит сборку. */
  sessionId: z.string(),
});
export type Changes = z.infer<typeof changesSchema>;

/** Итог проверки: что показала последняя сборка. */
export const testReportSchema = z.strictObject({
  tests: z.number(),
  failures: z.number(),
  errors: z.number(),
  skipped: z.number(),
  suites: z.number(),
  /** Новые и измененные классы тестов ветки и выполнились ли они. */
  changedTests: z.array(z.strictObject({ name: z.string(), executed: z.boolean() })),
  builds: z.number(),
  logFile: z.string(),
});
export type TestReport = z.infer<typeof testReportSchema>;

/** Находка ревью шага "Проверка". */
export const findingSchema = z.strictObject({
  file: z.string(),
  line: z.number().nullable(),
  summary: z.string(),
  fixed: z.boolean(),
});
export type Finding = z.infer<typeof findingSchema>;

/** PR из порта SCM: его форму задает система, лишние поля допустимы. */
export const pullRequestRefSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  to: z.string().optional(),
});

/** Зеленая сборка ветки: ее выкатывает шаг "Деплой на стенд". */
export const buildSchema = z.strictObject({
  key: z.string(),
  number: z.number(),
  /** План сборки из профиля репозитория: по нему считается тег образа. */
  plan: z.string(),
  branch: z.string(),
  revision: z.string(),
  /** Тег образа сборки, например 1.0.4-246. */
  tag: z.string().nullable(),
  url: z.string(),
});
export type Build = z.infer<typeof buildSchema>;

/** Релиз проекта деплоя, который выкатил шаг "Деплой на стенд". */
export const releaseSchema = z.strictObject({ id: z.number(), name: z.string() });
export type Release = z.infer<typeof releaseSchema>;

/** Выкаченная сборка: ее тестирует шаг "Тест на стенде". */
export const deployedBuildSchema = z.strictObject({
  stand: z.string(),
  build: z.string(),
  tag: z.string().nullable(),
  resultId: z.number(),
  /** Под с образом сборки, который нашла проверка выкатки. */
  pod: z.string().nullable(),
});
export type DeployedBuild = z.infer<typeof deployedBuildSchema>;

/** Итоги проверки одного критерия приемки, по порядку. */
export const AC_RESULTS = ['пройден', 'не пройден', 'частично', 'не проверен'] as const;
export type AcResult = (typeof AC_RESULTS)[number];

/** Проверка одного AC: строка таблицы итогов в Jira. */
export const acCheckSchema = z.strictObject({
  ac: z.string(),
  scenario: z.string(),
  action: z.string(),
  expected: z.string(),
  result: z.enum(AC_RESULTS),
  /** Факт или причина итога. */
  note: z.string(),
  /** Скриншоты доказательства из папки артефактов, по порядку. */
  files: z.array(z.string()),
});
export type AcCheck = z.infer<typeof acCheckSchema>;

/** Отчет о прогоне AC на стенде: по нему публикуются итоги и чинится код. */
export const qaReportSchema = z.strictObject({
  at: z.string(),
  stand: z.string(),
  /** Тег образа сборки, выкаченной этим прогоном; null - сборку на стенде этот прогон не деплоил. */
  build: z.string().nullable(),
  summary: z.string(),
  results: z.array(acCheckSchema),
  remarks: z.array(z.string()),
  /** Доки задачи: QA-гайд и отчет. */
  guide: z.string(),
  report: z.string(),
  /** Папка скриншотов и кадров Kibana. */
  artifacts: z.string(),
  /** Файлы, на которые ссылается отчет, но которых нет в папке артефактов. */
  missing: z.array(z.string()),
});
export type QaReport = z.infer<typeof qaReportSchema>;

/** Что сделал круг доработки по тесту. */
export const qaFixSchema = z.strictObject({
  round: z.number(),
  /** AC, которые чинил этот круг. */
  failed: z.array(z.string()),
  summary: z.string(),
  files: z.array(z.string()),
  tests: z.array(z.string()),
  buildGreen: z.boolean(),
  at: z.string(),
});
export type QaFix = z.infer<typeof qaFixSchema>;

/** Комментарий с итогами проверки в Jira: повторная публикация в этом прогоне правит его, а не добавляет новый. */
export const qaCommentSchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  key: z.string(),
  rendered: z.object({ images: z.number(), rows: z.number(), unresolved: z.number() }),
  at: z.string(),
});
export type QaComment = z.infer<typeof qaCommentSchema>;

/** Черновик ответа на замечание ревьюера. */
export const reviewReplySchema = z.strictObject({
  commentId: z.number(),
  text: z.string(),
  /** Ответ описывает исправление в коде: к нему при публикации дописывается коммит. */
  fixed: z.boolean(),
});
export type ReviewReply = z.infer<typeof reviewReplySchema>;

/** Что подготовил шаг ответа на ревью: ответы ждут публикации, исправления - коммита и пуша. */
export const prReviewSchema = z.strictObject({
  pr: z.number(),
  replies: z.array(reviewReplySchema),
  summary: z.string(),
  files: z.array(z.string()),
  tests: z.array(z.string()),
  /** Ответы еще не опубликованы. */
  pending: z.boolean(),
  /** Вершина ветки, от которой шли исправления: пуш исправлений ее меняет. */
  base: z.string().nullable(),
  at: z.string(),
});
export type PrReview = z.infer<typeof prReviewSchema>;

/** Смерженный PR задачи. */
export const mergedSchema = z.strictObject({ pr: z.number(), at: z.string() });
export type Merged = z.infer<typeof mergedSchema>;

/** Что опубликовал шаг "Вики": страница и хэш файла страницы в доках, по которому видно, менялся ли он с тех пор. */
export const wikiPageSchema = z.strictObject({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  hash: z.string(),
  at: z.string(),
});
export type WikiPublished = z.infer<typeof wikiPageSchema>;

/** Дашборд мониторинга, который сохранил шаг "Дашборд задачи". */
export const dashboardRefSchema = z.strictObject({ id: z.string(), file: z.string() });
export type DashboardRef = z.infer<typeof dashboardRefSchema>;

/** Что просил владелец у мастера "Новый шаг". */
export const stepRequestSchema = z.strictObject({ description: z.string() });
export type StepRequest = z.infer<typeof stepRequestSchema>;

/** Шаг, который мастер добавил в каталог. */
export const newStepSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  files: z.array(z.string()),
  at: z.string(),
});
export type NewStep = z.infer<typeof newStepSchema>;

/** Правки, которые записал разбор прогона: файлы, итог и проверка тестами. */
export const improvementsSchema = z.strictObject({
  files: z.array(z.string()),
  summary: z.string(),
  /** Итог проверки с правками; null - правились только скиллы, проверять тестами нечего. */
  tests: z.string().nullable(),
  at: z.string(),
});
export type Improvements = z.infer<typeof improvementsSchema>;

/**
 * Реестр контрактов по ключу контекста. Каждый ключ из `provides` реализованного шага обязан быть здесь: каталог
 * иначе считает манифест ошибочным. Ключи, которые пишут только движок, наблюдатель и сервис задач (`waiting`,
 * `loops`, `prSeen`, `repoChoice`), шаги не отдают, и в реестре их нет.
 */
export const CONTEXT_SCHEMAS: Record<string, z.ZodType> = {
  issue: issueSchema,
  ac: acSchema,
  issueChanged: issueChangedSchema,
  issueSeen: z.string().nullable(),
  status: z.string(),
  branch: z.string(),
  worktree: z.string(),
  rebased: z.boolean(),
  plan: planSchema,
  changes: changesSchema,
  testReport: testReportSchema,
  findings: z.array(findingSchema),
  commitSha: z.string(),
  pr: pullRequestRefSchema,
  build: buildSchema,
  ansibleBranch: z.string(),
  ansiblePr: pullRequestRefSchema,
  release: releaseSchema,
  deployedBuild: deployedBuildSchema,
  qaReport: qaReportSchema,
  failedAc: z.array(z.string()),
  qaFix: qaFixSchema,
  qaComment: qaCommentSchema,
  prReview: prReviewSchema,
  merged: mergedSchema,
  wikiPage: wikiPageSchema,
  dashboard: dashboardRefSchema,
  stepRequest: stepRequestSchema,
  newStep: newStepSchema,
  improvements: improvementsSchema,
};

/** Нарушение контракта выхода шага: ключ и понятное описание, что не так. */
export interface ContractIssue {
  key: string;
  message: string;
}

/**
 * Проверяет выходы шага по реестру step-kit и контрактам самого шага (own): возвращает нарушения ключей со схемой и
 * отдельно ключи без схемы. Общий контракт важнее своего. Значения не меняются: схема только проверяет, в контекст
 * ложится ровно то, что вернул шаг. Неопределенные значения движок не записывает, поэтому они не проверяются.
 */
export function checkOutputs(outputs: Record<string, unknown>, own: Record<string, ZodType> = {}): { issues: ContractIssue[]; unknown: string[] } {
  const issues: ContractIssue[] = [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(outputs)) {
    if (value === undefined) continue;
    const schema = CONTEXT_SCHEMAS[key] ?? own[key];
    if (!schema) {
      unknown.push(key);
      continue;
    }
    const r = schema.safeParse(value);
    if (!r.success) issues.push({ key, message: r.error.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ') });
  }
  return { issues, unknown };
}
