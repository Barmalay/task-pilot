/**
 * Типы ответов API сервера Task Pilot. Пакет содержит только типы: его импортируют и сервер, и интерфейс.
 */
import type {
  AttemptIdScope,
  AttemptOutcome,
  AttemptStep,
  AttemptSummary,
  Dashboard,
  DashboardError,
  DeployMark,
  FeatureDay,
  FeatureProfile,
  FeatureStats,
  Headline,
  IssueRef,
  LogLine,
  MonitorStats,
  PanelValue,
  Period,
  Preset,
  PresetOrderIssue,
  Preview,
  Refresh,
  RunJournal,
  RunStatus,
  StepManifest,
  StepSetting,
  StepSigns,
  StepStatus,
  TimeRange,
} from '@task-pilot/step-kit';

export type { RunJournal };

export interface RunDto {
  id: string;
  issueKey: string;
  repoId: string;
  standId: string | null;
  presetId: string;
  dryRun: boolean;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StepDto extends StepSigns {
  runId: string;
  stepId: string;
  position: number;
  selected: boolean;
  status: StepStatus;
  note: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  title: string;
  hint: string;
  phase: StepManifest['phase'];
  kind: StepManifest['kind'];
  gate: StepManifest['gate'];
  implemented: boolean;
  stage: number | null;
  feedback: string | null;
  /** Замечание владельца к повтору упавшего шага: агент получит его в следующей попытке. */
  retryNote: string | null;
  canRework: boolean;
  agent: { runs: number; costUsd: number; durationMs: number; running: boolean } | null;
  /** Выбранные в прогоне настройки шага поверх умолчаний. */
  params: Record<string, string | boolean>;
  /** Настройки шага: что это, варианты, умолчание и что выбрано; пусто - настроек у шага нет. */
  settings: StepSetting[];
}

export interface ApprovalDto {
  id: string;
  stepId: string;
  preview: Preview;
  createdAt: string;
  /** Линтер нашел запрещенное: подтвердить нельзя. */
  blocked: boolean;
}

export interface QuestionDto {
  id: string;
  runId: string;
  stepId: string;
  sessionId: string | null;
  question: string;
  options: string[];
  status: 'open' | 'answered' | 'expired';
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

/** Вопрос владельца о прогоне и ответ агента, который только читает ленту, шаги и код. */
export interface AskDto {
  id: string;
  runId: string;
  question: string;
  /** pending - агент еще отвечает. */
  status: 'pending' | 'answered' | 'failed';
  /** Ответ в markdown. */
  answer: string | null;
  error: string | null;
  costUsd: number | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface RunViewDto {
  run: RunDto;
  steps: StepDto[];
  context: Record<string, unknown>;
  /** Первое из ожидающих подтверждений: его показывает главная кнопка экрана. */
  approval: ApprovalDto | null;
  /** Все ожидающие подтверждения: шага цепочки и фоновых шагов, от ранних к поздним. */
  approvals: ApprovalDto[];
  questions: QuestionDto[];
  active: boolean;
}

export interface EventDto {
  id: number;
  runId: string | null;
  stepId: string | null;
  ts: string;
  type: string;
  message: string | null;
  data: unknown;
  /** Задача прогона: есть у событий прогонов в общем потоке, из которых строятся уведомления. */
  issueKey?: string | null;
}

/** Страница ленты прогона: события по порядку. */
export interface FeedPageDto {
  events: EventDto[];
  /** Есть события старше этой страницы. */
  more: boolean;
}

/** Кусок диффа правки файла, как его дает CLI: строки с "-", "+" или пробелом в начале. */
export interface PatchHunkDto {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Что инструмент ответил агенту. Длинные тексты обрезаны: у вывода команды остается конец, у остального начало. */
export interface ToolResultDto {
  isError: boolean;
  text: string | null;
  filePath?: string;
  /** Файл создан или изменен. */
  change?: 'create' | 'update';
  patch?: PatchHunkDto[];
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  /** Найденные файлы у поиска. */
  files?: string[];
  /** При показе что-то обрезано. */
  clipped?: boolean;
}

/** Вызов инструмента агентом: что он передал и что получил. */
export interface ToolCallDto {
  tool: string;
  input: Record<string, unknown>;
  result: ToolResultDto | null;
}

/** Подробности события ленты: вызов инструмента, подтверждение, вопрос агента или данные события. */
export type EventDetailsDto =
  | { kind: 'tool'; call: ToolCallDto }
  | { kind: 'approval'; approval: { id: string; status: string; comment: string | null; createdAt: string; decidedAt: string | null; preview: Preview } }
  | { kind: 'question'; question: { question: string; options: string[]; status: string; answer: string | null; createdAt: string; answeredAt: string | null } }
  | { kind: 'data'; data: unknown }
  | { kind: 'none'; reason: string };

export interface SprintDto {
  id: number;
  name: string;
  state: string;
}

export interface TaskDto extends IssueRef {
  runId: string | null;
  runStatus: RunStatus | null;
  /** Сколько сделано у прогона, который запускали и который еще не выполнен; null - нет такого прогона. */
  progress: { percent: number; remainingMs: number } | null;
}

/**
 * Прогноз прогона по истории: ожидаемое время отмеченных шагов, работа Task Pilot и ожидание владельца, сделанное и
 * оставшееся время и процент сделанного по ожидаемому времени шагов.
 */
export interface ForecastDto {
  /** Сколько прогонов истории дали обычное время шагам плана; 0 - истории нет, время по видам шагов. */
  basis: number;
  totalMs: number;
  workMs: number;
  ownerMs: number;
  doneMs: number;
  remainingMs: number;
  percent: number;
  /** Отмеченные шаги по порядку: ожидаемое время и в скольких прогонах истории шаг выполнялся. */
  steps: { stepId: string; expectedMs: number; runs: number }[];
  /** Прогноз при первом запуске прогона; null - прогон еще не запускали. */
  initial: { totalMs: number; workMs: number; ownerMs: number; basis: number; at: string } | null;
}

export interface TasksDto {
  statuses: string[];
  tasks: TaskDto[];
}

/** Что сейчас на стенде: для экрана "Стенды" и селектора стенда в прогоне. */
export interface StandDto {
  id: string;
  title: string;
  url: string | null;
  namespace: string;
  bambooEnv: string;
  /** Почему на стенд нельзя деплоить (выключен, похож на прод, запрещен контуром); null - можно. */
  blocked: string | null;
  notes: string[];
  /** Последний деплой по Bamboo. */
  release: { name: string; state: string | null; lifeCycle: string | null; startedAt: string | null; finishedAt: string | null } | null;
  /** Ветка плана и задача из имени релиза. */
  branch: string | null;
  task: string | null;
  taskUrl: string | null;
  /** Самый новый под приложения по логам и его образ. */
  image: { tag: string; pod: string; since: string } | null;
  /** Отвечает ли well-known стенда; null - проверить нечем. */
  up: boolean | null;
  /** Что не удалось узнать: Bamboo или логи недоступны. */
  errors: string[];
}

/** Файл в папке артефактов задачи (скриншоты и кадры Kibana теста на стенде). */
export interface ArtifactDto {
  name: string;
  size: number;
  modified: string;
  image: boolean;
  /** Вложение Jira с тем же именем: same - тот же файл, other - другой файл, null - во вложениях его нет. */
  jira: 'same' | 'other' | null;
}

export interface ArtifactsDto {
  /** Папка артефактов задачи. */
  dir: string;
  files: ArtifactDto[];
  /** Почему не удалось сверить с вложениями Jira; null - сверено. */
  jiraError: string | null;
}

/**
 * Вид времени прогона: работа агента, работа шага без агента (сборки, CI, деплой, git и Jira), ответы
 * владельца на вопросы агента и ожидание подтверждений.
 */
export type TimeKind = 'agent' | 'system' | 'question' | 'approval';

/** Отрезок времени шага на ленте прогона. */
export interface TimeSegmentDto {
  kind: TimeKind;
  from: string;
  to: string;
}

/** Время шага за все его запуски в прогоне, в миллисекундах. */
export interface StepTimingDto {
  stepId: string;
  title: string;
  /** Сколько раз шаг начинал работу: повторы и круги петли доработки. */
  attempts: number;
  /** Все время работы шага: агент, сборки и системы и ответы на вопросы агента. */
  workMs: number;
  agentMs: number;
  systemMs: number;
  questionsMs: number;
  approvalsMs: number;
  costUsd: number;
  segments: TimeSegmentDto[];
}

/** Ожидание владельца: подтверждение шага или вопрос агента. */
export interface OwnerWaitDto {
  kind: 'approval' | 'question';
  stepId: string;
  /** Что ждало: заголовок подтверждения или начало вопроса. */
  label: string;
  from: string;
  /** null - владелец еще не ответил. */
  to: string | null;
  ms: number;
  /** Чем закончилось: approved, rework, rejected, stale, answered, expired; null - неизвестно или еще ждет. */
  outcome: string | null;
}

/**
 * Время прогона от первого запуска до завершения (у идущего прогона - до сейчас), в миллисекундах.
 * wallMs складывается из работы шагов (workMs), подтверждений, пауз, когда прогон стоял, и остатка между шагами.
 */
export interface RunTimingDto {
  start: string | null;
  end: string | null;
  /** Прогон идет или ждет подтверждения: цифры еще растут. */
  live: boolean;
  wallMs: number;
  workMs: number;
  agentMs: number;
  systemMs: number;
  questionsMs: number;
  approvalsMs: number;
  pauseMs: number;
  otherMs: number;
  costUsd: number;
  steps: StepTimingDto[];
  pauses: { from: string; to: string }[];
  waits: OwnerWaitDto[];
}

/** Строка истории прогонов: время и признаки задачи, по которым потом можно прогнозировать. */
export interface RunHistoryDto {
  run: RunDto;
  summary: string | null;
  timing: Omit<RunTimingDto, 'steps' | 'pauses' | 'waits'> & { steps: Omit<StepTimingDto, 'segments'>[]; questions: number; approvals: number };
  features: {
    labels: string[];
    components: string[];
    type: string | null;
    /** Число критериев приемки; null - в описании не найдены. */
    acCount: number | null;
    /** Сколько файлов изменила реализация. */
    files: number | null;
    /** Кругов всех петель доработки прогона: по тесту, по ревью, по задаче. */
    loops: number;
  };
  /** Сколько в прогоне было падений шагов, правок на подтверждениях, кругов петель и отказов агентам. */
  journal: { failures: number; reworks: number; rejects: number; loops: number; denials: number };
  /** Прогноз при первом запуске прогона; null - прогон запускали до прогнозов. */
  forecast: { totalMs: number } | null;
}

/** Переход, доступный задаче на доске. */
export interface TransitionDto {
  id: string;
  name: string;
  /** Статус, в который ведет переход; null - неизвестно, перетащить карточку этим переходом нельзя. */
  to: string | null;
}

/** Итог проверки доступа: кто владелец по ответу самой системы или почему проверка не прошла. */
export interface IntegrationCheckDto {
  ok: boolean;
  /** Логин, у Claude - почта. */
  login: string | null;
  /** Имя, у Claude - организация. */
  name: string | null;
  /** Подробности: тариф Claude, чем проверен токен. */
  detail: string | null;
  error: string | null;
  at: string;
}

/** Аккаунт интеграции: доступ "как обычно" (id null) или заведенный на экране "Интеграции". */
export interface IntegrationAccountDto {
  id: string | null;
  /** default - из настроек Claude Code, none - вход не нужен, остальное - как задан аккаунт в Task Pilot. */
  kind: 'default' | 'none' | 'token' | 'login' | 'oauth-token' | 'api-key';
  label: string;
  /** Откуда берется доступ. */
  source: string;
  active: boolean;
  /** null - еще не проверялся. */
  check: IntegrationCheckDto | null;
}

/** Вход в Claude через браузер, который идет сейчас. */
export interface ClaudeLoginDto {
  id: string;
  label: string | null;
  state: 'waiting' | 'checking' | 'failed';
  /** Ссылка входа, если браузер не открылся: вход по ней заканчивается кодом. */
  url: string | null;
  error: string | null;
  startedAt: string;
}

/** Интеграция на экране "Интеграции". */
export interface IntegrationDto {
  id: string;
  kind: 'jira' | 'confluence' | 'bitbucket' | 'bamboo' | 'elasticsearch' | 'kibana' | 'claude';
  title: string;
  url: string | null;
  usedBy: string;
  note: string | null;
  /** Где взять токен. */
  tokenHelp: string | null;
  /** Можно завести токен: вход нужен и адрес известен. */
  canToken: boolean;
  /** Можно войти через браузер: только Claude. */
  canLogin: boolean;
  accounts: IntegrationAccountDto[];
  logins: ClaudeLoginDto[];
}

/** Экран "Интеграции". */
export interface IntegrationsDto {
  /** Где лежат токены, заведенные в Task Pilot. */
  secrets: string;
  integrations: IntegrationDto[];
}

/** Место на диске: файлы каждого прогона, что из них можно очистить, и кэш QA-браузера. */
export interface CacheDto {
  /** Прогоны, у которых есть файлы: размер и можно ли их очистить (прогон завершен и не выполняется). */
  runs: { runId: string; bytes: number; clearable: boolean }[];
  runsBytes: number;
  clearableBytes: number;
  /** Кэш страниц QA-браузера; пока браузер открыт, его не очистить. */
  qa: { bytes: number; running: boolean };
}

/** Расход агентов относительно лимита: warn - больше 80% лимита, exhausted - лимит исчерпан, новые агенты не запускаются. */
export type BudgetLevel = 'ok' | 'warn' | 'exhausted';

/** Расход агентов за день или неделю по ценам API. */
export interface BudgetPeriodDto {
  spentUsd: number;
  /** Лимит; null - без лимита. */
  limitUsd: number | null;
  level: BudgetLevel;
  /** Когда начнется следующий день или неделя и расход обнулится. */
  resetsAt: string;
}

/** Расход агентов за текущие день и неделю и худшее из двух состояний. */
export interface BudgetDto {
  day: BudgetPeriodDto;
  week: BudgetPeriodDto;
  level: BudgetLevel;
}

/** Итог проверки окружения: ok - в порядке, warn - работает не все, fail - Task Pilot или важная часть цикла не заработает. */
export type DoctorLevel = 'ok' | 'warn' | 'fail';

/** Одна проверка окружения машины. */
export interface DoctorCheckDto {
  id: string;
  /** Что проверяется. */
  title: string;
  level: DoctorLevel;
  /** Что найдено. */
  detail: string;
  /** Как исправить; null - исправлять нечего. */
  fix: string | null;
}

/** Проверка окружения машины: то же, что печатает pnpm checkup. */
export interface DoctorDto {
  checks: DoctorCheckDto[];
  at: string;
}

/** Строка журнала сервера на экране "Служебное": ошибка, предупреждение или обычная строка. */
export interface ServiceLogLineDto {
  text: string;
  level: 'error' | 'warn' | null;
}

/** Гайд приемки, журнал решений или план в `.claude/<тема>/`: то, что ждет решения владельца. */
export interface ServiceDocDto {
  /** Путь от папки `.claude`: `<тема>/<файл>.md`. */
  path: string;
  title: string;
  kind: 'acceptance' | 'notes' | 'plan';
  modified: string;
  /** В файле есть раздел с вопросами или решениями на подтверждение. */
  questions: boolean;
  /** Владелец отметил файл принятым, и с тех пор файл не менялся. */
  accepted: boolean;
}

/** Служебные сведения о запущенном Task Pilot: сервер, репозиторий, доки на решение и журнал сервера. */
export interface ServiceDto {
  server: {
    startedAt: string;
    node: string;
    /** Коммит репозитория Task Pilot при запуске сервера и сейчас; null - папка не репозиторий git. */
    commitAtStart: string | null;
    commitNow: string | null;
    /** Сервер запустило приложение Task Pilot: только такой перезапускается с экрана. */
    launchedByApp: boolean;
    /** Измененные после запуска файлы, которые сервер подхватит только после перезапуска, пути от корня репозитория. */
    changed: string[];
    /** pnpm-lock.yaml расходится с установленными зависимостями. */
    installNeeded: boolean;
    /** Прогоны, которые выполняются или ждут: выполняющийся не дает перезапустить сервер. */
    runs: { id: string; issueKey: string; status: RunStatus }[];
  };
  repo: {
    branch: string | null;
    commits: { hash: string; subject: string; at: string }[];
    /** Незакоммиченные файлы: двузначный код git status (индекс и рабочая папка, пробел значим) и путь. */
    dirty: { code: string; path: string }[];
    remote: { name: string; url: string; ahead: number | null; behind: number | null } | null;
    error: string | null;
  };
  docs: ServiceDocDto[];
  /** Журнал текущего и прошлого запуска и вывод последнего перезапуска с экрана (`.data/restart.log`). */
  log: { current: ServiceLogLineDto[]; previous: ServiceLogLineDto[]; restart: ServiceLogLineDto[] };
  at: string;
}

/**
 * Профиль в панели сбоку: команда (пакет, слой компании, доска, репозитории, стенды, скиллы агентов) и личные
 * настройки этой машины так, как они применены. Токенов и значений из ~/.claude.json в нем нет.
 */
export interface ProfileDto {
  team: {
    id: string;
    title: string;
    /** Папка пакета команды для людей: от корня Task Pilot или через ~. */
    dir: string;
    /** Слой компании; null - у команды его нет. */
    company: { id: string; dir: string } | null;
    /** Доска для спринтов на экране "Задачи" и ее адрес в Jira; null - доска не задана. */
    board: { name: string; url: string } | null;
    /** Статусы доски по порядку: путь задачи и статусы после его конца. */
    statuses: string[];
    /** Скиллы агентов из team.yaml: тест на стенде и страница вики; null - скилл не задан. */
    skills: { qa: string | null; wiki: string | null };
    /** Пространство вики для новых страниц; null - не задано. */
    wikiSpace: string | null;
    /** Репозитории слоев с путем на этой машине; default - репозиторий по умолчанию. */
    repos: { id: string; title: string; path: string; default: boolean }[];
    /** Сколько стендов: из профилей и из Bamboo. */
    stands: number;
  };
  personal: {
    /** Файл личных настроек для людей и есть ли он. */
    file: string;
    exists: boolean;
    /** Логин Jira из личных настроек; пусто - не задан. */
    me: string;
    /** JDK 21 для сборок Java; null - не задан. */
    javaHome: string | null;
    /** Личный стиль публикуемых текстов: какие правки линтер делает сам. */
    style: { yo: boolean; dash: boolean; quotes: boolean };
  };
}

/** То, что ждет владельца в прогоне: подтверждение шага или вопрос агента. */
export interface AttentionDto {
  runId: string;
  issueKey: string;
  kind: 'approval' | 'question';
  /** Название шага, который ждет, по каталогу. */
  step: string;
  /** Заголовок подтверждения или вопрос агента. */
  text: string;
  /** Когда шаг спросил. */
  at: string;
}

/** Аккаунты, под которыми работает Task Pilot сейчас: активные аккаунты Jira и Claude для шапки. */
export interface AccountDto {
  jira: {
    active: IntegrationAccountDto;
    /** Логин, на который шаги назначают задачи: владелец токена Task Pilot или me личных настроек; пусто - не задан. */
    me: string;
  };
  claude: { active: IntegrationAccountDto };
}

export interface CatalogStepDto extends StepSigns {
  id: string;
  title: string;
  hint: string;
  phase: StepManifest['phase'];
  kind: StepManifest['kind'];
  gate: StepManifest['gate'];
  requires: string[];
  provides: string[];
  sideEffects: boolean;
  implemented: boolean;
  stage: number | null;
  /** Настройки шага с вариантами и умолчанием манифеста: по ним редактор пресетов задает умолчания пресета. */
  settings: StepSetting[];
}

export interface CatalogDto {
  steps: CatalogStepDto[];
  presets: Preset[];
  /** Замечания к порядку шагов пресетов по id пресета: ошибки и предупреждения. */
  presetIssues: Record<string, PresetOrderIssue[]>;
  /** Пресеты, на которые опирается код: их можно править, но не удалять. */
  protectedPresets: string[];
  errors: { file: string; message: string }[];
  loadedAt: string;
}

export interface ProfilesDto {
  repos: { id: string; title: string; contour: string; connected: boolean; default: boolean }[];
  /** repos - репозитории контура, у которых есть окружение на стенде; null - все репозитории контура. */
  stands: { id: string; title: string; contour: string; url: string | null; deployable: boolean; notes: string[]; repos: string[] | null }[];
  contours: { id: string; title: string; connected: boolean; note: string | null }[];
}

/** Фича входа на обзоре мониторинга: профиль и дневные итоги последних дней из истории. */
export interface FeatureSummaryDto {
  profile: FeatureProfile;
  /** Дневные итоги всей истории фичи, старые первыми: строк по baseline, стадиям и ошибкам. */
  days: FeatureDay[];
  /** Когда дневные итоги последний раз обновлялись из логов прода, мс; null - еще не обновлялись. */
  refreshedAt: number | null;
  /** Почему дневные итоги не обновились; null - обновились. */
  error: string | null;
}

/** Фичи входа и ошибки в файлах их профилей. */
export interface FeaturesDto {
  features: FeatureSummaryDto[];
  errors: DashboardError[];
  timeZone: string;
}

/** Статистика фичи за окно дней с историей для графика по дням. */
export interface FeatureStatsDto {
  profile: FeatureProfile;
  stats: FeatureStats;
  /** Вся история дней, старые первыми. */
  days: FeatureDay[];
  /** Окно в днях часового пояса команды, включительно; toPartial - последний день еще идет. */
  window: { from: string; to: string; toPartial: boolean };
  timeZone: string;
  /** В каком-то получасе строк больше предела поиска: взяты первые. */
  truncated: boolean;
  generatedAt: number;
}

/** Задача Jira на панели мониторинга. */
export interface MonitorTaskDto {
  key: string;
  summary: string | null;
  status: string | null;
  url: string;
}

/** Последняя проверка алерта дашборда. */
export interface MonitorAlertDto {
  id: string;
  panel: string;
  text: string;
  /** paused - опрос дашборда выключен, алерт не проверяется. */
  state: 'firing' | 'ok' | 'nodata' | 'paused' | 'pending';
  /** Доля у панели share, число строк у остальных. */
  kind: 'ratio' | 'count';
  value: number | null;
  threshold: number | null;
  since: string | null;
  checkedAt: string | null;
}

/** Карточка задачи на обзоре: цифры ее дашборда или приглашение собрать дашборд. */
export interface MonitorCardDto {
  task: MonitorTaskDto;
  dashboard: { id: string; title: string; refresh: Refresh; services: string[] } | null;
  headlines: Headline[];
  alerts: MonitorAlertDto[];
  /** alert - сработал алерт, error - запросы не прошли, ok - все в норме, empty - дашборда нет. */
  status: 'alert' | 'error' | 'ok' | 'empty';
}

/** Обзор панели: карточки задач по эпикам. */
export interface MonitorOverviewDto {
  configured: boolean;
  groups: { epic: MonitorTaskDto | null; cards: MonitorCardDto[] }[];
  /** Файлы дашбордов с ошибками: такие дашборды не показываются. */
  errors: DashboardError[];
  /** Почему не пришли задачи из Jira; null - пришли. */
  tasksError: string | null;
  load: MonitorStats;
  at: string;
}

/** Данные дашборда за период. */
export interface DashboardDataDto {
  dashboard: Dashboard;
  task: MonitorTaskDto;
  epic: MonitorTaskDto | null;
  period: Period;
  range: TimeRange;
  bucketMs: number;
  refresh: Refresh;
  panels: { id: string; value: PanelValue; discover: string | null }[];
  deploys: DeployMark[];
  alerts: MonitorAlertDto[];
  load: MonitorStats;
  at: string;
}

/** Разбивка панели по полю и сравнение до и после последнего деплоя. */
export interface PanelBreakdownDto {
  panel: string;
  by: string;
  items: { key: string; n: number }[];
  other: number;
  deploy: { version: string; service: string; at: number; before: number; after: number; spanMs: number } | null;
  error: string | null;
}

/** Строки лога панели за окно, новые сверху. */
export interface MonitorLinesDto {
  lines: LogLine[];
  /** Время самой старой строки: с него берется следующая порция. */
  before: number | null;
  discover: string | null;
  error: string | null;
}

/** Профиль пути для формы поиска: идентификаторы, признаки и провайдеры. */
export interface AttemptProfileDto {
  /** Есть ли attempt.yaml в пакете команды; без него путь строится по полям сервисов панели. */
  configured: boolean;
  title: string;
  intro: string | null;
  /** Почему attempt.yaml не прочитался; null - прочитался или его нет. */
  error: string | null;
  ids: { key: string; label: string; scope: AttemptIdScope; sensitive: boolean }[];
  /** Признаки для поиска попыток: события профиля пути и стадии фич; group - откуда признак. */
  signs: { key: string; label: string; group: string }[];
  providers: { key: string; label: string }[];
  /** Окно вокруг момента попытки, мс. */
  windowMs: number;
}

/** Попытка в списке поиска. */
export interface AttemptCandidateDto {
  /** Ключ попытки, по которому открывается ее путь: state или другой ключ попытки. */
  key: string | null;
  at: number;
  end: number;
  durationMs: number;
  outcome: AttemptOutcome;
  outcomeLabel: string | null;
  providers: string[];
  errors: string[];
  services: string[];
  /** Найденные значения; телефон и код - только для экрана. */
  ids: AttemptSummary['ids'];
  milestones: string[];
}

/** Найденные попытки, новые первыми. */
export interface AttemptSearchDto {
  attempts: AttemptCandidateDto[];
  range: TimeRange;
  /** Попыток или строк было больше предела: показаны первые. */
  truncated: boolean;
  errors: string[];
}

/** Путь одной попытки: хронология по всем сервисам, сводка и другие попытки того же человека рядом. */
export interface AttemptPathDto {
  title: string;
  /** Окно, в котором искали. */
  range: TimeRange;
  /** Значения, с которых начинали. */
  seeds: string[];
  steps: AttemptStep[];
  summary: AttemptSummary;
  others: AttemptCandidateDto[];
  services: { id: string; title: string }[];
  /** Сколько кругов поиска по найденным идентификаторам и трассам прошло. */
  rounds: number;
  truncated: boolean;
  errors: string[];
}

/** Правка файла мониторинга по запросу в чате: разговор, черновик агента и его проверка. */
export interface MonitorEditDto {
  id: string;
  /** Что правится: dashboard:<id>, feature:<id> или attempt. */
  target: string;
  status: 'working' | 'ready' | 'invalid' | 'failed' | 'applied' | 'discarded';
  /** Разговор: просьбы владельца (телефоны маской) и ответы агента. */
  messages: { role: 'owner' | 'agent'; text: string; at: string }[];
  /** Текст файла, от которого начата правка. */
  base: string;
  draft: string | null;
  summary: string | null;
  /** Почему черновик не прошел проверку схемой. */
  errors: string[];
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

/** Прошлая версия файла мониторинга: ее можно вернуть. */
export interface MonitorVersionDto {
  id: string;
  target: string;
  note: string | null;
  source: string;
  createdAt: string;
}

/** Правки цели: подпись, путь файла, текущий текст, незакрытая правка и прошлые версии. */
export interface MonitorEditsDto {
  target: string;
  label: string;
  /** Путь файла в пакете команды. */
  file: string;
  source: string | null;
  edit: MonitorEditDto | null;
  versions: MonitorVersionDto[];
}
