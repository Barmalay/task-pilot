import { z } from 'zod';

const profileId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const regex = z
  .string()
  .min(1)
  .refine((s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  }, 'не регулярное выражение');

/**
 * Правило, по которому стенды контура берутся из Bamboo: стенд - окружение проекта деплоя репозитория контура, имя
 * которого подходит под include. Окружение, похожее на прод, или с id из forbiddenBambooEnvIds стендом не становится.
 */
export const standRuleSchema = z.strictObject({
  /** Регулярное выражение по имени окружения в Bamboo. */
  include: regex,
  /** Начало id стенда: id - это начало плюс имя окружения в нижнем регистре. */
  idPrefix: z.string().regex(/^[a-z0-9-]*$/).default(''),
  /** Источник логов стендов из logs.yaml слоев. */
  logs: z.string().min(1),
  /** Заметки к стендам по имени окружения в Bamboo. */
  notes: z.record(z.string(), z.array(z.string().min(1))).default({}),
  /**
   * Адрес сервиса на стенде: {service} - id репозитория, {host} - namespace стенда, в котором host.from заменено на
   * host.to. По нему проверка выкатки спрашивает сервис и сверяет заголовок X-Environment с namespace стенда.
   */
  serviceUrl: z.string().min(1).optional(),
  host: z.strictObject({ from: regex, to: z.string() }).optional(),
});

export type StandRule = z.infer<typeof standRuleSchema>;

/** Контур: свои git, Bamboo и учетные данные. Токены одного контура не уходят в другой. */
export const contourSchema = z.strictObject({
  id: profileId,
  title: z.string().min(1),
  git: z.url(),
  bamboo: z.url(),
  /** Имена MCP-серверов из ~/.claude.json, которые обслуживают контур. */
  mcp: z.strictObject({
    bitbucket: z.string().optional(),
    bamboo: z.string().optional(),
  }),
  connected: z.boolean(),
  /** Окружения Bamboo, куда деплой запрещен всегда, даже если токен это позволяет. */
  forbiddenBambooEnvIds: z.array(z.number().int()).default([]),
  /**
   * Имена окружений, похожих на прод, сверх слова prod, которое запрещено всегда: например reserve|staging. Такое
   * окружение стендом не становится, и деплой на стенд с таким namespace или окружением Bamboo запрещен.
   */
  prodLike: regex.optional(),
  /** Стенд по умолчанию для прогонов: первый стенд контура, чье окружение в Bamboo подходит под правило; стенды из Bamboo идут с него. */
  defaultStand: regex.optional(),
  /** Как Bamboo контура называет образы сборок и релизы: по тегу образа проверка выкатки узнает сборку на стенде. */
  builds: z
    .strictObject({
      /** Тег образа сборки ветки плана: {build} - номер сборки, {branch} - номер ветки плана. */
      branchTag: z.string().min(1),
      /** Тег образа сборки самого плана (основной ветки): {build} - номер сборки. */
      masterTag: z.string().min(1),
      /** Имя релиза основной ветки плана, например ^release-\d+$: у такого релиза нет задачи. */
      masterRelease: regex.optional(),
    })
    .optional(),
  /** Заголовок ответа сервиса со средой, в которой он запущен: по нему видно, что ответил сервис этого стенда, а не соседнего. */
  serviceHeader: z.string().min(1).optional(),
  /** Стенды контура из Bamboo по правилу; без правила стенды контура - только профили стендов (папки stands слоев). */
  stands: standRuleSchema.optional(),
  /**
   * Как деплой контура берет ветку k8s-ansible задачи. byName - скрипт деплоя сам находит ветку с именем ветки
   * релиза; customize - только из формы Customize Deploy, которую отправляет владелец. customizeUrl - страница этой
   * формы, {envId} и {versionId} в адресе заменяются окружением стенда и релизом. Без раздела - byName.
   */
  deploy: z
    .strictObject({
      ansibleBranch: z.enum(['byName', 'customize']),
      customizeUrl: z.url().optional(),
    })
    .optional(),
  note: z.string().optional(),
});

export type Contour = z.infer<typeof contourSchema>;

/** Профиль репозитория, с которым работают шаги. Пути с ~ раскрывает сервер при загрузке. */
export const repoProfileSchema = z.strictObject({
  id: profileId,
  title: z.string().min(1),
  contour: profileId,
  /** Репозиторий, который выбирается, когда задача не подсказала другой. */
  default: z.boolean().default(false),
  /**
   * Как узнать репозиторий по задаче: компоненты Jira, метки вида repo:<проект>/<репозиторий> и сторона. Сторона
   * различает репозитории одного компонента: задача с меткой frontend или backend, а без меток с префиксом [Front]
   * или [Back] в названии, идет в репозиторий своей стороны.
   */
  match: z
    .strictObject({
      components: z.array(z.string()).default([]),
      labels: z.array(z.string()).default([]),
      side: z.enum(['frontend', 'backend']).optional(),
    })
    .default({ components: [], labels: [] }),
  path: z.string().min(1),
  remote: z.string().default('origin'),
  baseBranch: z.string().default('master'),
  branchPattern: z.string().default('feature/{KEY}'),
  worktreesDir: z.string().min(1),
  build: z
    .strictObject({
      javaHome: z.string().optional(),
      command: z.string().min(1),
    })
    .optional(),
  /** Allowlist путей для стейджинга коммита. */
  commitPaths: z.array(z.string()).default([]),
  bitbucket: z
    .strictObject({
      project: z.string(),
      repo: z.string(),
      reviewers: z.array(z.string()).default([]),
    })
    .optional(),
  bamboo: z
    .strictObject({
      plan: z.string(),
      deploymentProject: z.number().int(),
    })
    .optional(),
  docsDir: z.string().default('.claude/{KEY}'),
  artifactsDir: z.string().default('.claude/artifacts/{KEY}'),
  /** Репозиторий конфига деплоя сервиса (k8s-ansible): id его профиля в том же контуре. */
  deployRepo: profileId.optional(),
  /** Заметки агенту об устройстве репозитория: где лежат настройки сервисов и как они связаны с окружениями. */
  notes: z.array(z.string().min(1)).optional(),
  /** Путь проверки здоровья сервиса к его адресу на стенде; без него ответ сервиса проверяется только по заголовку окружения. */
  health: z.string().regex(/^\//).optional(),
  /**
   * Тест на стенде через вход Keycloak: когда сборка сервиса стоит на стенде serviceStand, ее проверяет и вход на стенде
   * Keycloak stand, потому что Keycloak там ходит в этот сервис. Без этого сервис проверяется только запросами к его API.
   */
  qa: z.strictObject({ keycloak: z.strictObject({ stand: profileId, serviceStand: profileId }) }).optional(),
});

export type RepoProfile = z.infer<typeof repoProfileSchema>;

/**
 * Тестовый стенд. Прод сюда не заводится, а деплой дополнительно проверяет deployBlockReason. Окружение стенда в
 * Bamboo задается одним id, если у контура один проект деплоя, или id в проекте деплоя каждого репозитория, если у
 * сервисов свои проекты деплоя и Stable у каждого со своим id.
 */
export const standProfileSchema = z
  .strictObject({
    id: profileId,
    title: z.string().min(1),
    contour: profileId,
    url: z.url().optional(),
    realm: z.string().optional(),
    /** Адрес сервиса на стенде с {service} вместо id репозитория: по нему проверяется, что отвечает сам сервис стенда. */
    serviceUrl: z.string().min(1).optional(),
    namespace: z.string().min(1),
    bambooEnv: z.string().min(1),
    bambooEnvId: z.number().int().optional(),
    /** Окружение стенда в проекте деплоя репозитория по его id; репозиторий без записи на стенд не деплоится. */
    bambooEnvIds: z.record(profileId, z.number().int()).optional(),
    /** Путь проверки живости стенда от его url, {realm} заменяется realm стенда: по нему видно, что стенд поднялся. */
    health: z.string().regex(/^\//).optional(),
    logs: z.string().min(1),
    deployable: z.boolean(),
    notes: z.array(z.string()).default([]),
  })
  .refine((s) => (s.bambooEnvId === undefined) !== (s.bambooEnvIds === undefined), { message: 'нужен ровно один из bambooEnvId и bambooEnvIds' });

export type StandProfile = z.infer<typeof standProfileSchema>;

/**
 * Переход основного пути доски: из какого статуса в какой. id и имя перехода - подсказка, как его найти среди
 * доступных; без них переход ищется по статусу, в который он ведет (его сообщает REST Jira).
 */
export const boardStepSchema = z.strictObject({
  from: z.string().min(1),
  id: z.coerce.string().optional(),
  name: z.string().min(1).optional(),
  to: z.string().min(1),
});

export type BoardStep = z.infer<typeof boardStepSchema>;

/**
 * Настройки доски Jira. Основной путь задан цепочкой переходов, вехи - целевыми статусами на нем: шаги знают только
 * ключи вех (inProgress, review, testing, merged), а статусы берут отсюда. Веха null - на этой доске шаг задачу не
 * двигает.
 */
export const jiraConfigSchema = z
  .strictObject({
    baseUrl: z.url(),
    /**
     * Логин владельца в Jira: на него назначаются задачи. Это личная настройка: в командном профиле ее нет, она
     * приходит из ~/.task-pilot/profile.yaml; пусто - логин не задан.
     */
    me: z.string().default(''),
    /** MCP-сервер Jira и Confluence (mcp-atlassian) из ~/.claude.json: через него Task Pilot и агенты ходят в Jira. */
    mcp: z.string().min(1).default('atlassian'),
    /** Фильтр экрана "Задачи" без выбранного спринта. */
    myIssuesJql: z.string().min(1),
    /** Доска команды: с нее берутся спринты. */
    board: z.strictObject({ id: z.number().int(), name: z.string().min(1) }).optional(),
    /** Поле спринта в задаче (gh-sprint, customfield_...); без него спринт задачи не читается. */
    sprintField: z.string().min(1).optional(),
    /** Поле эпика задачи (Epic Link): по нему панель мониторинга собирает задачи в эпики; без него эпиков нет. */
    epicField: z.string().min(1).optional(),
    path: z.array(boardStepSchema).min(1),
    /** Статусы после конца основного пути, например Monitoring. */
    after: z.array(z.string()).default([]),
    /** Статусы вне основного пути: Waiting, Closed. */
    offPath: z.array(z.string()).default([]),
    /**
     * Статусы, в которых задача закончена, кроме вехи merged и статусов после нее, например Closed: за такой задачей
     * наблюдатель больше не следит.
     */
    finished: z.array(z.string()).default([]),
    milestones: z.record(z.string(), z.string().nullable()),
  })
  .superRefine((cfg, ctx) => {
    cfg.path.forEach((step, i) => {
      const next = cfg.path[i + 1];
      if (next && next.from !== step.to) {
        ctx.addIssue({ code: 'custom', path: ['path', i + 1, 'from'], message: `путь прерывается: после ${step.to} идет ${next.from}` });
      }
    });
    const statuses = [cfg.path[0]?.from, ...cfg.path.map((p) => p.to), ...cfg.after];
    for (const [name, target] of Object.entries(cfg.milestones)) {
      if (target !== null && !statuses.includes(target)) {
        ctx.addIssue({ code: 'custom', path: ['milestones', name], message: `статус ${target} не лежит на основном пути` });
      }
    }
  });

export type JiraConfig = z.infer<typeof jiraConfigSchema>;

/**
 * Пакет команды: team.yaml в корне папки пакета, рядом профили команды (profiles), дашборды (dashboards) и плагин
 * агентов (plugin). Слой компании пакет называет по имени: это папка company/<id> репозитория Task Pilot, ее профили
 * лежат под профилями команды.
 */
export const teamManifestSchema = z.strictObject({
  id: profileId,
  title: z.string().min(1),
  /** Слой компании: папка company/<id> репозитория Task Pilot; без поля у команды слоя компании нет. */
  company: profileId.optional(),
  /** Тест на стенде: скилл команды в ее плагине и логи, которые агент выгружает, не называя сервис. */
  qa: z
    .strictObject({
      skill: profileId,
      /** Источник логов стендов (logs.yaml) и контейнер, логи которого инструмент qa_kibana_logs дает без service. */
      logs: z.strictObject({ source: z.string().min(1), container: z.string().min(1) }).optional(),
    })
    .optional(),
  /** Страница вики: скилл команды в ее плагине и пространство для новых страниц. */
  wiki: z.strictObject({ skill: profileId, space: z.string().min(1).optional() }).optional(),
});

export type TeamManifest = z.infer<typeof teamManifestSchema>;

/**
 * Личные настройки человека, который запускает Task Pilot, вне репозитория (~/.task-pilot/profile.yaml): то, что у
 * каждого свое и в командные профили не кладется.
 */
export const personalProfileSchema = z.strictObject({
  /** Пакет команды: папка с team.yaml; переменная TASK_PILOT_TEAM важнее. */
  team: z.string().min(1).optional(),
  /** Логин в Jira: на него шаги назначают задачи. */
  me: z.string().min(1).optional(),
  /** JDK 21 для сборок Java, если в профиле репозитория его нет. */
  javaHome: z.string().min(1).optional(),
  /** Репозиторий по умолчанию вместо командного. */
  defaultRepo: profileId.optional(),
  /** Где лежат репозитории на этой машине, если не там, где их ждет командный профиль. */
  repos: z.record(profileId, z.strictObject({ path: z.string().min(1).optional(), worktreesDir: z.string().min(1).optional() })).default({}),
  /** Имена сверх командного списка линтера: их тоже нельзя упоминать в публикуемых текстах. */
  lintNames: z.array(z.string().min(1)).default([]),
  /**
   * Личный стиль публикуемых текстов: линтер сам меняет е с точками на е (yo), длинное тире на дефис (dash) и
   * типографские кавычки на прямые (quotes), а агенты получают это правилом. Без поля оформление не меняется.
   */
  style: z.strictObject({ yo: z.boolean().default(false), dash: z.boolean().default(false), quotes: z.boolean().default(false) }).optional(),
});

export type PersonalProfile = z.infer<typeof personalProfileSchema>;

/** Что линтер текстов считает запрещенным сверх встроенных правил: lint.yaml слоев, списки слоев объединяются. */
export const lintProfileSchema = z.strictObject({
  /** Имена и фамилии сотрудников: в публичных текстах вместо них роль. */
  names: z.array(z.string().min(1)).default([]),
  /** Адреса почты, которые можно упоминать. */
  allowEmails: z.array(z.string().min(1)).default([]),
});

export type LintProfile = z.infer<typeof lintProfileSchema>;

/** Источник логов стендов: Kibana, запросы к которой идут через console proxy. */
export const logSourceSchema = z.strictObject({
  kind: z.literal('kibana'),
  url: z.url(),
  /** Шаблон индекса, например cloud-k8s-*. */
  index: z.string().min(1),
  /** Поле с образом контейнера, агрегируемое (.keyword): в индексах разных сервисов оно разное. */
  imageField: z.string().min(1).default('container.image.name.keyword'),
  /** Поля текста и логгера записи: без них message и loggerName, как у Keycloak; у других сервисов бывает messagetext и logger. */
  messageField: z.string().min(1).optional(),
  loggerField: z.string().min(1).optional(),
  /** Id представления данных этого индекса в Kibana: по нему строятся ссылки Discover для кадров логов. */
  dataView: z.string().min(1).optional(),
  /** Поля Kubernetes в записях: контейнер, namespace (агрегируемое), под (агрегируемое) и время; без них - поля filebeat. */
  containerField: z.string().min(1).optional(),
  namespaceField: z.string().min(1).optional(),
  podField: z.string().min(1).optional(),
  timeField: z.string().min(1).optional(),
});

export type LogSource = z.infer<typeof logSourceSchema>;

/** Поля Kubernetes в логах стендов по умолчанию: так их называет filebeat. */
export const K8S_LOG_FIELDS = { container: 'kubernetes.container.name', namespace: 'kubernetes.namespace.keyword', pod: 'kubernetes.pod.name.keyword', time: '@timestamp' };

/** Поля Kubernetes источника логов стендов: свои, если источник их назвал, иначе filebeat. */
export function k8sFieldsOf(source: LogSource): typeof K8S_LOG_FIELDS {
  return {
    container: source.containerField ?? K8S_LOG_FIELDS.container,
    namespace: source.namespaceField ?? K8S_LOG_FIELDS.namespace,
    pod: source.podField ?? K8S_LOG_FIELDS.pod,
    time: source.timeField ?? K8S_LOG_FIELDS.time,
  };
}

/** Источники логов стендов по id: logs.yaml слоев, на них ссылается поле logs профиля стенда. */
export const logSourcesSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9.-]*$/), logSourceSchema);
