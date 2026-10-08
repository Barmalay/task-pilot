import type { ZodType } from 'zod';
import type { LintIssue, LintResult, TextStyle } from './lint.ts';
import type { AttemptProfile } from './attempt.ts';
import type { MonitorTarget } from './monitor.ts';
import type { FeatureProfile } from './funnel.ts';
import type { Dashboard, LogRequest, LogResult, MonitorServiceProfile, MonitorStats } from './monitor.ts';
import type { Contour, JiraConfig, RepoProfile, StandProfile } from './profiles.ts';
import type { WaitEvent } from './waiting.ts';

/** Состояние шага в прогоне. */
export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_owner'
  | 'succeeded'
  | 'already'
  | 'simulated'
  | 'skipped'
  | 'failed'
  | 'blocked'
  /** Ждет внешнего события (сборки, деплоя, мержа PR): прогон продолжит наблюдатель. */
  | 'waiting';

/** Состояние прогона целиком; waiting - шаг ждет внешнего события, waiting_owner - ждет владельца. */
export type RunStatus = 'idle' | 'running' | 'waiting_owner' | 'waiting' | 'paused' | 'completed' | 'failed';

/** Спринт доски. */
export interface SprintRef {
  id: number;
  name: string;
  /** active, future или closed. */
  state: string;
}

/** Краткая карточка задачи Jira. */
export interface IssueRef {
  key: string;
  summary: string;
  status: string;
  type?: string;
  updated?: string;
  url: string;
  labels: string[];
  components: string[];
  sprint: SprintRef | null;
  /** Исполнитель: логин и имя для показа; null - задача не назначена. */
  assignee: { name: string; displayName?: string } | null;
  /** Ключ эпика задачи (Epic Link); null - задача без эпика, нет поля - порт его не читает. */
  epic?: string | null;
}

/** Комментарий задачи без текста: по ним видно, кто и когда писал в задаче. */
export interface IssueCommentRef {
  id: string;
  /** Логин автора, как jira.me профиля. */
  author: string;
  created: string;
}

/** Задача Jira с полями, которые нужны шагам. */
export interface Issue extends IssueRef {
  description: string;
  /** Комментарии без текста; нет - порт их не читал. */
  comments?: IssueCommentRef[];
}

/** Переход доски, доступный задаче сейчас. */
export interface Transition {
  id: string;
  name: string;
  /** Статус, в который ведет переход, если Jira его сообщила. */
  to?: string;
}

/** Порт Jira: шаги работают с ним, не зная, что за ним стоит, MCP или REST. */
export interface JiraPort {
  search(jql: string, limit: number): Promise<IssueRef[]>;
  getIssue(key: string): Promise<Issue>;
  getTransitions(key: string): Promise<Transition[]>;
  transition(key: string, transitionId: string): Promise<void>;
  assign(key: string, username: string): Promise<void>;
  /** Спринты доски в нужном состоянии. */
  sprints(boardId: number, state: 'active' | 'future'): Promise<SprintRef[]>;
  /** Вложения задачи. */
  attachments(key: string): Promise<JiraAttachment[]>;
  /** Загружает файл вложением к задаче. Файл с тем же именем Jira не заменяет, а добавляет рядом. */
  attach(key: string, file: string): Promise<JiraAttachment>;
  deleteAttachment(id: string): Promise<void>;
  /** Создает комментарий в wiki-разметке Jira или правит существующий и сообщает, как Jira его отрисовала. */
  comment(key: string, body: string, commentId?: string): Promise<JiraComment>;
}

/** Вложение задачи Jira. */
export interface JiraAttachment {
  id: string;
  filename: string;
  /** Размер в байтах: вместе с именем показывает, загружен ли уже тот же файл. */
  size: number;
  created: string;
}

/** Опубликованный комментарий Jira и то, как Jira его отрисовала. */
export interface JiraComment {
  id: string;
  url: string;
  /** По renderedBody: картинок, строк таблиц и неразобранной разметки (`|thumbnail!`, `[^`). */
  rendered: { images: number; rows: number; unresolved: number };
}

/** Результат команды git. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Порт git: обертка над CLI без интерактивных запросов пароля. */
export interface GitPort {
  /** Выполняет команду и бросает ошибку при ненулевом коде выхода. */
  run(cwd: string, args: string[]): Promise<GitResult>;
  /** Выполняет команду и возвращает код выхода как есть. */
  tryRun(cwd: string, args: string[]): Promise<GitResult>;
}

/** Результат команды оболочки: код выхода и хвост вывода, полный вывод пишется в logFile. */
export interface ShellResult {
  code: number;
  /** Последние килобайты общего вывода stdout и stderr. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

/** Порт запуска команд оболочки: сборка и тесты. */
export interface ShellPort {
  /**
   * Выполняет команду в песочнице без сети: писать можно в cwd, writeDirs, ~/.m2 и временные папки,
   * файлы с токенами не читаются. Код сборки ветки считается недоверенным: его пишет агент.
   */
  run(
    command: string,
    options: { cwd: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; logFile?: string; writeDirs?: string[] },
  ): Promise<ShellResult>;
}

/** Репозиторий в Bitbucket своего контура. */
export interface ScmRepoRef {
  contour: string;
  project: string;
  repo: string;
}

/** Pull request в Bitbucket. */
export interface PullRequestRef {
  id: number;
  title: string;
  url: string;
  /** Ветка, в которую направлен PR, если Bitbucket ее сообщил. */
  to?: string;
}

/** Ревьюер PR и его оценка: APPROVED, NEEDS_WORK или UNAPPROVED (еще не оценил). */
export interface PrReviewer {
  name: string;
  status: string;
}

/** Комментарий в PR; ответы в его ветке идут плоским списком по времени. */
export interface PrComment {
  id: number;
  author: string;
  text: string;
  createdAt: string;
  /** OPEN или RESOLVED. */
  state: string;
  /** Файл и строка комментария к коду; null - общий комментарий. */
  file: string | null;
  line: number | null;
  replies: { id: number; author: string; text: string; createdAt: string }[];
}

/** Состояние PR: мерж, оценки ревьюеров и активные комментарии. */
export interface PullRequestState extends PullRequestRef {
  /** OPEN, MERGED или DECLINED. */
  state: string;
  /** Автор PR, как Bitbucket показывает его имя в комментариях. */
  author: string;
  reviewers: PrReviewer[];
  comments: PrComment[];
}

/** Порт Bitbucket: PR ветки задачи. Мержат и оценивают PR люди: порт их решения только читает. */
export interface ScmPort {
  /** Открытые PR из ветки; null - Bitbucket не знает такой ветки в этом репозитории. */
  openPullRequests(ref: ScmRepoRef, branch: string): Promise<PullRequestRef[] | null>;
  createPullRequest(ref: ScmRepoRef, input: { title: string; description: string; from: string; to: string; reviewers: string[] }): Promise<PullRequestRef>;
  /** Самый новый PR из ветки в любом состоянии, в том числе смерженный; null - такого нет. */
  findPullRequest(ref: ScmRepoRef, branch: string): Promise<PullRequestRef | null>;
  pullRequest(ref: ScmRepoRef, id: number): Promise<PullRequestState>;
  /** Ответ в ветку комментария PR. */
  reply(ref: ScmRepoRef, prId: number, commentId: number, text: string): Promise<void>;
}

/** Сборка ветки плана Bamboo. */
export interface BuildResult {
  /** Ключ сборки, например BUILDS-SBMKPKEYCLOAKSSO246-4. */
  key: string;
  number: number;
  /** Successful, Failed или Unknown, пока сборка не закончилась. */
  state: string;
  /** Queued, Pending, InProgress, Finished или NotBuilt. */
  lifeCycle: string;
  /** Коммит, из которого собрано, полным sha. */
  revision: string | null;
  /** Страница сборки в Bamboo. */
  url: string;
}

/** Релиз деплой-проекта Bamboo. */
export interface DeployVersion {
  id: number;
  name: string;
  /** Сборка, из которой сделан релиз. */
  buildKey: string | null;
  /** Ветка плана, например feature-TEAM-2799 или master. */
  branch: string | null;
}

/** Последний деплой на окружение. */
export interface EnvironmentStatus {
  envId: number;
  envName: string;
  version: { id: number; name: string } | null;
  /** SUCCESS, FAILED или UNKNOWN, пока деплой идет. */
  state: string | null;
  /** QUEUED, PENDING, IN_PROGRESS или FINISHED. */
  lifeCycle: string | null;
  resultId: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Результат деплоя. */
export interface DeployResult {
  id: number;
  envId: number | null;
  versionId: number | null;
  versionName: string | null;
  state: string;
  lifeCycle: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Строки лога, если их запросили. */
  log?: string[];
}

/**
 * Порт Bamboo одного контура: сборки веток, релизы и деплой. Деплой на окружение, которого нет
 * среди разрешенных стендов или которое запрещено в контуре (прод), порт отклоняет сам.
 */
export interface BambooPort {
  /** Адрес Bamboo для ссылок на сборки, окружения и деплои в его интерфейсе. */
  readonly url: string;
  /** Ветка плана сборки для ветки git; null - Bamboo ее еще не завел. */
  planBranch(plan: string, branch: string): Promise<{ key: string; name: string } | null>;
  /** Сборки плана или ветки плана, новые первыми, включая идущие и стоящие в очереди. */
  builds(planKey: string, limit: number): Promise<BuildResult[]>;
  /** Последние строки лога заданий сборки: упавших, а если таких нет - всех. */
  buildLog(buildKey: string, maxLines: number): Promise<string[]>;
  /** Релизы деплой-проекта, новые первыми. */
  versions(project: number, limit: number): Promise<DeployVersion[]>;
  /** Имя, которое Bamboo предлагает для релиза из этой сборки. */
  nextVersionName(project: number, buildKey: string): Promise<string>;
  createVersion(project: number, buildKey: string, name: string): Promise<DeployVersion>;
  /** Последний деплой на каждое окружение деплой-проекта. */
  environments(project: number): Promise<EnvironmentStatus[]>;
  /** Деплои на окружение, новые первыми. */
  environmentResults(envId: number, limit: number): Promise<DeployResult[]>;
  /** Ставит деплой релиза на окружение в очередь. */
  deploy(envId: number, versionId: number): Promise<{ resultId: number }>;
  deployResult(resultId: number, withLog: boolean): Promise<DeployResult>;
}

/** Под приложения на стенде и образ, из которого он запущен. */
export interface PodImage {
  pod: string;
  /** Тег образа, например 1.0.4-246 или 1.0.273-master. */
  tag: string;
  firstSeen: string;
  lastSeen: string;
}

/** Ответ адреса стенда: HTTP-статус (0 - адрес не ответил) и окружение из заголовка X-Environment, если оно есть. */
export interface ProbeResult {
  status: number;
  environment: string | null;
}

/** Порт логов стендов: что запущено в namespace по логам и отвечает ли стенд. */
export interface StandLogsPort {
  /** Id представления данных индекса в Kibana для ссылок Discover; нет - ссылки идут по умолчанию скрипта. */
  readonly dataView?: string;
  /** Поды приложения по namespace за последние минуты, новые первыми. */
  pods(app: string, namespaces: string[], sinceMinutes: number): Promise<Record<string, PodImage[]>>;
  /** Ответ по адресу: статус и среда из заголовка header (serviceHeader контура); без заголовка среды нет. */
  probe(url: string, header?: string): Promise<ProbeResult>;
}

/** Логи прода для панели мониторинга: только чтение, каждый запрос в границах времени, строки небольшой порцией. */
export interface MonitorLogsPort {
  /** Выполняет запросы; ответ на каждый в том же порядке, ошибка одного запроса приходит его ответом вида error. */
  run(requests: LogRequest[]): Promise<LogResult[]>;
  /** Нагрузка на источник логов за последние минуты. */
  stats(): MonitorStats;
}

/** Ошибка в файле дашборда: такой дашборд не показывается, пока файл не исправят. */
export interface DashboardError {
  file: string;
  message: string;
}

/** Панель мониторинга: сервисы и дашборды из файлов Task Pilot и логи прода. */
export interface MonitorPort extends MonitorLogsPort {
  /** Сервисы из monitor.yaml. */
  services(): MonitorServiceProfile[];
  /** Дашборды из dashboards/<id>/dashboard.yaml пакета команды и ошибки в файлах; перечитываются, когда файлы меняются. */
  dashboards(): { dashboards: Dashboard[]; errors: DashboardError[] };
  /** Разбирает YAML дашборда и проверяет его схемой и сервисами профиля; dashboard null, если есть ошибки. */
  validate(source: string): { dashboard: Dashboard | null; errors: string[] };
  /** Проверяет YAML дашборда и записывает его как есть в dashboards/<id>/dashboard.yaml пакета команды; возвращает дашборд и путь. */
  save(source: string): Promise<{ dashboard: Dashboard; file: string }>;
  /** Профили фич из features/<id>.yaml пакета команды и ошибки в файлах; перечитываются, когда файлы меняются. */
  features(): { features: FeatureProfile[]; errors: DashboardError[] };
  /** Разбирает YAML профиля фичи и проверяет его схемой и сервисами профиля; feature null, если есть ошибки. */
  validateFeature(source: string): { feature: FeatureProfile | null; errors: string[] };
  /** Проверяет YAML профиля фичи и записывает его как есть в features/<id>.yaml пакета команды. */
  saveFeature(source: string): Promise<{ feature: FeatureProfile; file: string }>;
  /** Профиль пути одной попытки (attempt.yaml пакета команды): null - файла нет; error - файл есть, но не прошел проверку. */
  attempt(): { profile: AttemptProfile | null; error: string | null };
  /** Разбирает YAML профиля пути и проверяет его схемой и сервисами панели; attempt null, если есть ошибки. */
  validateAttempt(source: string): { attempt: AttemptProfile | null; errors: string[] };
  /** Проверяет YAML профиля пути и записывает его как есть в attempt.yaml пакета команды. */
  saveAttempt(source: string): Promise<{ attempt: AttemptProfile; file: string }>;
  /** Текст файла цели правки как он лежит в пакете команды; null - файла нет. */
  readSource(target: MonitorTarget): string | null;
}

/** Внешние системы, доступные шагам. */
export interface Ports {
  jira: JiraPort;
  git: GitPort;
  shell: ShellPort;
  scm: ScmPort;
  /** Bamboo контура; ошибка, если у контура Bamboo не настроен. */
  bamboo(contour: Contour): BambooPort;
  /** Логи стендов из источника профиля стенда (поле logs). */
  logs(source: string): StandLogsPort;
  /** QA-браузер Task Pilot для прогона AC на стенде. */
  browser: BrowserPort;
  /** Вики Confluence: страницы по задачам. */
  wiki: WikiPort;
  /** Сам Task Pilot: журнал прогона и проверка правок его файлов. */
  pilot: PilotPort;
  /** Панель мониторинга: дашборды задач и логи прода только на чтение. */
  monitor: MonitorPort;
}

/** Запись журнала прогона: шаг и время. */
export interface JournalEntry {
  stepId: string;
  /** Название шага для людей. */
  step: string;
  at: string;
  /** Событие ленты, из которого взята запись: по нему экран прогона открывает ее подробности. У ответов на вопросы его нет. */
  eventId?: number;
}

/** Что происходило в прогоне помимо успешных шагов: по журналу разбор прогона ищет, что улучшить в промптах и скиллах. */
export interface RunJournal {
  /**
   * Решения владельца: на подтверждениях - переделать с замечанием или отклонить, у упавшего шага - повторить с
   * замечанием агенту (retry, title - ошибка прошлой попытки).
   */
  corrections: (JournalEntry & { decision: 'rework' | 'rejected' | 'retry'; title: string; comment: string | null })[];
  /** Вопросы агентов, на которые владелец ответил. */
  questions: (JournalEntry & { question: string; answer: string })[];
  /** Падения шагов. */
  failures: (JournalEntry & { error: string })[];
  /** Вызовы инструментов, в которых агенту отказано. */
  denials: (JournalEntry & { tools: string[] })[];
  /** Круги петель доработки. */
  loops: (JournalEntry & { round: number; max: number })[];
}

/** Итог проверки правок Task Pilot: команды по порядку и их вывод. */
export interface PilotCheck {
  ok: boolean;
  results: { command: string; ok: boolean; summary: string; output: string }[];
}

/** Сам Task Pilot: журнал прогона для разбора и проверка правок его файлов на копии. */
export interface PilotPort {
  /** Корень репозитория Task Pilot. */
  readonly root: string;
  /** Скиллы агентов: папка skills плагина пакета команды. По ним работают шаги, их правит разбор прогона. */
  readonly skillsDir: string;
  /** Правила текстов команды для агентов: rules.md пакета команды; его тоже правит разбор прогона. */
  readonly teamRules?: string;
  journal(runId: string): Promise<RunJournal>;
  /**
   * Проверка типов шагов и тесты tests на копии Task Pilot, в которой файлы overlay (пути от корня) подменены,
   * а null удален. Настоящая папка не меняется, команды идут в песочнице без сети.
   */
  check(overlay: Record<string, string | null>, tests: string[]): Promise<PilotCheck>;
}

/** Страница вики: тело в markdown и версия, по которой видно, не правил ли ее кто-то после чтения. */
export interface WikiPage {
  id: string;
  title: string;
  space: string;
  version: number;
  url: string;
  markdown: string;
}

/** Порт вики Confluence. Создание и обновление - внешние действия: их делает код шага после подтверждения. */
export interface WikiPort {
  getPage(id: string): Promise<WikiPage>;
  /** Страница пространства с точным заголовком; null - такой нет. */
  findPage(space: string, title: string): Promise<WikiPage | null>;
  createPage(input: { space: string; title: string; parentId: string | null; markdown: string }): Promise<{ id: string; url: string }>;
  /** Перезаписывает тело страницы целиком. */
  updatePage(input: { id: string; title: string; markdown: string; comment: string }): Promise<{ id: string; url: string }>;
}

/** Откуда выгружать логи сервиса: индекс, контейнер, namespace стенда (пусто - все) и поля записи. */
export interface KibanaTarget {
  index: string;
  container: string;
  namespace: string;
  messageField: string;
  loggerField: string;
  /** Поля Kubernetes источника: контейнер, namespace и время записи. */
  containerField: string;
  namespaceField: string;
  timeField: string;
}

/**
 * QA-браузер Task Pilot: отдельный видимый Chrome, в котором агент ведет прогон, а владелец решает капчу и
 * вводит коды. Шаг проверяет, что браузер запущен (ensure); действия в нем агент выполняет инструментами
 * pipeline, а сервер передает их сюда.
 */
export interface BrowserPort {
  readonly port: number;
  /** Запускает браузер, если его нет. Чужой Chrome на порту - ошибка. */
  ensure(): Promise<{ started: boolean }>;
  /** Отвечает ли сейчас Chrome на порту браузера; без метода браузер считается закрытым. */
  running?(): Promise<boolean>;
  /** Выполняет действия драйвера QA-браузера (cdp.mjs); скриншоты ложатся в shotDir. Возвращает вывод. */
  act(actions: unknown, shotDir: string): Promise<string>;
  /** Текстовая выгрузка логов контейнера target через открытую в браузере вкладку Kibana. */
  kibanaLogs(q: { minutes?: number; from?: string; to?: string; phrases: string[]; target: KibanaTarget }): Promise<string>;
}

/** Правила текстов для агентов сверх общих правил шагов: правила команды и личный стиль того, от чьего имени тексты. */
export interface StepTexts {
  /** Правила команды для агентов: rules.md пакета команды; пусто - их нет. */
  rules: string;
  /** Личный стиль публикуемых текстов из личных настроек. */
  style: TextStyle;
}

/** Пакет команды для шагов: чей прогон и какие скиллы команды берут шаги теста на стенде и страницы вики. */
export interface StepTeam {
  id: string;
  title: string;
  /** Папка скилла теста на стенде в плагине команды (SKILL.md и справочники); null - в team.yaml его нет. */
  qaSkill: string | null;
  /** Папка скилла страницы вики; null - в team.yaml его нет. */
  wikiSkill: string | null;
  /** Пространство вики для новых страниц из team.yaml; null - не задано. */
  wikiSpace: string | null;
}

/** Запуск агента Claude из шага. ToolSearch, ask_owner и report_progress добавляются всегда. */
export interface AgentRequest {
  /** Короткое имя запуска для журнала: "план", "исправление сборки". */
  label: string;
  prompt: string;
  cwd: string;
  /** Встроенные инструменты: Read, Grep, Glob, Edit, Write, Bash. */
  tools: string[];
  /** Папки, куда агенту можно писать, кроме cwd. */
  writeDirs?: string[];
  /** false - в cwd писать нельзя, только в writeDirs: так работают шаги, которые не меняют код. */
  writeCwd?: boolean;
  /** Дополнительные разрешения: правила Bash(...) и инструменты MCP. */
  allow?: string[];
  /** Дополнительные запреты сверх общих: git push и commit, запись во внешние системы, файлы с токенами. */
  deny?: string[];
  /** MCP-серверы владельца из ~/.claude.json, которые нужны шагу. */
  mcp?: string[];
  /** JSON Schema итога: агент вернет объект по ней. */
  schema?: Record<string, unknown>;
  /** Модель; по умолчанию из манифеста шага. */
  model?: string;
  /** Продолжить сессию агента из прошлого результата. */
  resume?: string;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
}

/** Итог запуска агента. */
export interface AgentResult {
  sessionId: string;
  /** Последний текст агента. */
  text: string;
  /** Объект по schema запроса. */
  output: unknown;
  costUsd: number;
  durationMs: number;
  turns: number;
  /** Инструменты, в которых агенту было отказано. */
  denials: string[];
}

/** Агент, привязанный к прогону и шагу: вопросы владельцу и журнал попадают в этот шаг. */
export interface StepAgent {
  run(request: AgentRequest): Promise<AgentResult>;
  /** Последняя сессия шага с этой меткой: для продолжения прерванной работы. */
  lastSession(label: string): { sessionId: string; status: string } | null;
}

/** Текст, который шаг публикует: показывается на подтверждении и проверяется линтером. */
export interface PreviewText {
  id: string;
  label: string;
  text: string;
  /** Публикуемый текст обязан пройти линтер; внутренние документы - нет. */
  publish: boolean;
  /**
   * Публикуемый текст, который шаг проверил линтером сам: например, у обновляемой страницы вики только новые и измененные
   * строки. Движок такой текст заново не проверяет, а замечания линтера шаг кладет в `lint` превью.
   */
  stepLinted?: boolean;
  /**
   * Как показывать текст на подтверждении: markdown - отрисованным (план, описание PR, страница вики), jira - так, как
   * его отрисует Jira по wiki-разметке (комментарий в Jira), без поля - обычным текстом. У отрисованного текста есть
   * переключатель на исходник. Это способ показа, а не содержимое: в хэш подтверждения поле не входит.
   */
  format?: 'markdown' | 'jira';
}

/** То, что владелец видит и подтверждает перед выполнением шага. */
export interface Preview {
  title: string;
  summary?: string;
  actions: string[];
  /** Содержимое под подтверждение: при любом его изменении подтверждение сгорает. */
  payload: unknown;
  /** Для gate: before шаг может сообщить, что подтверждение сейчас не нужно. */
  requiresApproval?: boolean;
  /** Тексты для публикации и документы на утверждение; входят в хэш подтверждения. */
  texts?: PreviewText[];
  /**
   * Справка на подтверждении: владелец ее видит, но в хэш подтверждения она не входит. Для того, что меняется само и
   * не подтверждается, например живых цифр с прода: иначе подтверждение сгорало бы с каждым новым значением.
   */
  notes?: { id: string; label: string; text: string }[];
  /** На что обратить внимание: например, изменены существующие тесты. */
  warnings?: string[];
  /**
   * Открытые вопросы владельцу, например вопросы плана: окно подтверждения показывает поле ответа у каждого, и ответы
   * уходят шагу замечанием "Переделать" списком с номерами вопросов. В хэш подтверждения не входят.
   */
  questions?: string[];
  /** Замечания линтера; блокирующие не дают подтвердить. Проверку текстов добавляет движок. */
  lint?: LintIssue[];
}

/** Ответ шага на вопрос "уже сделано?". */
export interface DoneResult {
  note: string;
  outputs?: Record<string, unknown>;
}

/** Все, что движок передает шагу при выполнении. */
/**
 * Связанный прогон: самый новый прогон той же задачи в другом репозитории. Так ведется задача, которая меняет
 * несколько репозиториев: у каждого свой прогон с веткой, PR, сборкой и деплоем.
 */
export interface LinkedRun {
  runId: string;
  repo: RepoProfile;
  status: RunStatus;
  steps: { id: string; selected: boolean; status: StepStatus }[];
  /** Значение из контекста связанного прогона. */
  get<T = unknown>(key: string): T | undefined;
}

export interface StepContext {
  run: { id: string; issueKey: string; dryRun: boolean };
  params: Record<string, unknown>;
  /** Значение из общего контекста прогона. */
  get<T = unknown>(key: string): T | undefined;
  repo: RepoProfile;
  /** Контур репозитория: шаги с git и Bamboo работают только в подключенном контуре. */
  contour: Contour | undefined;
  stand: StandProfile | undefined;
  /** Репозиторий конфига деплоя сервиса (k8s-ansible) из deployRepo профиля репозитория. */
  deployRepo: RepoProfile | undefined;
  /** Пакет команды: ее скиллы для шагов теста на стенде и вики. */
  team: StepTeam;
  /** Правила текстов команды и личный стиль: агентам - правилами, проверкам текстов шага - стилем. */
  texts: StepTexts;
  jira: JiraConfig;
  ports: Ports;
  /** Агент Claude для этого шага. */
  agent: StepAgent;
  /**
   * Папки задачи: рабочие доки и артефакты в репозитории, служебные файлы прогона и папка, где доки
   * пишет агент. CLI не дает агенту писать в папки .claude даже по явному разрешению, поэтому агент
   * работает с копией доков в agentDocs, а шаг возвращает ее в docs (stageDocs в steps/_shared). Шаги
   * цепочки идут по одному и делят одну копию, у фонового шага она своя.
   */
  paths: { docs: string; artifacts: string; run: string; agentDocs: string };
  /** Черновик из prepare: сохраняется между запусками и доступен preview и run. */
  draft: unknown;
  /** Замечание владельца, с которым шаг переделывается; есть только в prepare. */
  feedback: string | null;
  /** Линтер текстов с секретами и именами из профиля. */
  lint(text: string): LintResult;
  /** Связанные прогоны задачи в других репозиториях; читаются заново при каждом вызове, поэтому ожидание видит их ход. */
  linked(): LinkedRun[];
  /** Стенд по id, в том числе прочитанный из Bamboo; undefined - такого нет. */
  standById(id: string): StandProfile | undefined;
  /**
   * Событие, которого шаг ждал перед этим входом: наблюдатель увидел его, или владелец нажал "проверить сейчас".
   * По нему шаг, ожидая дальше, держит прежний срок. null - шаг не ждал.
   */
  waited: WaitEvent | null;
  /** Срабатывает, когда владелец останавливает прогон. */
  signal: AbortSignal;
  /** Память шага на одно выполнение: общая для done, preview, simulate и run. */
  scratch: Map<string, unknown>;
  log(message: string, data?: unknown): void;
}

/**
 * Реализация шага. Обязателен только run; done делает шаг идемпотентным, prepare готовит
 * черновик до подтверждения (обычно агентом) и переделывает его по замечанию владельца,
 * preview нужен шагам с подтверждением, simulate - пробному прогону, resume - продолжению после ожидания.
 */
export interface StepModule {
  done?(c: StepContext): Promise<DoneResult | null>;
  prepare?(c: StepContext): Promise<unknown>;
  preview?(c: StepContext): Promise<Preview>;
  simulate?(c: StepContext): Promise<Record<string, unknown>>;
  run(c: StepContext): Promise<Record<string, unknown>>;
  /** Шагу петли: начинать ли новый круг после этого запуска (например, ничего не исправлено); без метода - всегда. */
  again?(c: StepContext, outputs: Record<string, unknown>): boolean | Promise<boolean>;
  /**
   * Продолжение шага, который ждал события, брошенного из run или resume: подтвержденное действие уже идет (сборка
   * собирается, деплой в очереди), и когда событие случилось, движок вызывает resume вместо done, preview и
   * подтверждения. Шаг продолжает с того места, где ждал, и возвращает выходы, как run, или ждет дальше. Шаг без
   * resume после такого ожидания выполняется с начала.
   */
  resume?(c: StepContext, event: WaitEvent): Promise<Record<string, unknown>>;
  /**
   * Контракты новых ключей, которые кладет только этот шаг и которых нет в `CONTEXT_SCHEMAS` step-kit: так шаг
   * описывает свой выход, не трогая step-kit (например, шаг из мастера "Новый шаг"). Ключ, который читают другие
   * шаги, описывается в step-kit: иначе им пришлось бы импортировать тип из чужого шага.
   */
  contracts?: Record<string, ZodType>;
}
