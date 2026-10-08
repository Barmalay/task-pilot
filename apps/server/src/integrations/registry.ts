import type { McpServerConfig, Profiles } from '../config.ts';

/** Вид интеграции: по нему выбираются переменные доступа и проверка "кто я". */
export type IntegrationKind = 'jira' | 'confluence' | 'bitbucket' | 'bamboo' | 'elasticsearch' | 'kibana' | 'claude';

/** Виды интеграций, доступ к которым идет через env MCP-сервера из ~/.claude.json. */
export type McpKind = 'jira' | 'confluence' | 'bitbucket' | 'bamboo' | 'elasticsearch';

/** Интеграция Task Pilot: внешняя система и то, откуда берется доступ к ней. */
export interface IntegrationDef {
  id: string;
  kind: IntegrationKind;
  title: string;
  /** Адрес системы: токен уходит только на этот хост. null - адрес неизвестен, токен задать нельзя. */
  url: string | null;
  /** MCP-сервер ~/.claude.json, из env которого доступ берется "как обычно". */
  mcp: string | null;
  /** Что в Task Pilot от нее зависит. */
  usedBy: string;
  /** Где взять токен; null - вход не нужен. */
  tokenHelp: string | null;
  /** Почему интеграция сейчас не используется, например контур не подключен. */
  note: string | null;
}

/** Переменные доступа в env MCP-сервера по виду интеграции: адрес, токен и, у Bitbucket, логин. */
export const ACCESS_ENV: Record<McpKind, { url: string; token: string; user?: string }> = {
  jira: { url: 'JIRA_URL', token: 'JIRA_PERSONAL_TOKEN' },
  confluence: { url: 'CONFLUENCE_URL', token: 'CONFLUENCE_PERSONAL_TOKEN' },
  bitbucket: { url: 'BITBUCKET_BASE_URL', token: 'BITBUCKET_TOKEN', user: 'BITBUCKET_USERNAME' },
  bamboo: { url: 'BAMBOO_URL', token: 'BAMBOO_TOKEN' },
  elasticsearch: { url: 'ES_URL', token: 'ES_API_KEY' },
};

/**
 * Закрепленные версии пакетов MCP-серверов: те, с которыми Task Pilot проверен. Без версии npx и uvx берут последнюю
 * опубликованную, и обновление пакета может молча сломать или поменять ответы инструментов.
 */
export const MCP_PACKAGES = {
  atlassian: 'mcp-atlassian==0.23.1',
  bitbucket: '@nexus2520/bitbucket-mcp-server@3.0.0',
  bamboo: 'bamboo-mcp-server@1.2.0',
  elasticsearch: '@elastic/mcp-server-elasticsearch@0.3.1',
} as const;

/** Как запустить MCP-сервер интеграции, если его нет в ~/.claude.json: теми же пакетами, что у владельца. */
export const DEFAULT_MCP: Record<McpKind, McpServerConfig> = {
  jira: { command: 'uvx', args: [MCP_PACKAGES.atlassian], env: { TOOLSETS: 'all' } },
  confluence: { command: 'uvx', args: [MCP_PACKAGES.atlassian], env: { TOOLSETS: 'all' } },
  bitbucket: { command: 'npx', args: ['-y', MCP_PACKAGES.bitbucket], env: {} },
  bamboo: { command: 'npx', args: ['-y', MCP_PACKAGES.bamboo], env: {} },
  elasticsearch: { command: 'npx', args: ['-y', MCP_PACKAGES.elasticsearch], env: { OTEL_SDK_DISABLED: 'true' } },
};

/** Имя пакета без версии: `@scope/name@1.2.3` -> `@scope/name`, `name==1.2.3` -> `name`. */
export function packageName(spec: string): string {
  const eq = spec.indexOf('==');
  if (eq > 0) return spec.slice(0, eq);
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * Пакеты MCP-серверов из ~/.claude.json без закрепленной версии или с плавающей (`@latest`): что поправить и на какую
 * версию. Смотрятся только известные Task Pilot пакеты.
 */
export function unpinnedMcp(servers: Record<string, McpServerConfig>): { server: string; spec: string; pinned: string }[] {
  const known = Object.values(MCP_PACKAGES);
  return Object.entries(servers).flatMap(([server, cfg]) =>
    cfg.args.flatMap((arg) => {
      const pinned = known.find((k) => packageName(k) === packageName(arg));
      if (!pinned) return [];
      const floating = arg === packageName(arg) || arg.endsWith('@latest');
      return floating ? [{ server, spec: arg, pinned }] : [];
    }),
  );
}

export function isMcpKind(kind: IntegrationKind): kind is McpKind {
  return kind in ACCESS_ENV;
}

const trim = (url: string) => url.replace(/\/+$/, '');

/**
 * Интеграции по профилям и ~/.claude.json: Jira и Confluence, Bitbucket и Bamboo каждого контура, у которого
 * они есть, логи прода, Kibana стендов и Claude. Адрес Jira, Bitbucket и Bamboo дают профили, адрес Confluence
 * и кластера логов прода - env их MCP-сервера.
 */
export function integrationDefs(profiles: Profiles, base: Record<string, McpServerConfig>): IntegrationDef[] {
  const note = (c: Profiles['contours'][number]) => (c.connected ? null : (c.note ?? `Контур ${c.title} не подключен`));
  const atlassian = profiles.jira.mcp;
  const confluence = base[atlassian]?.env.CONFLUENCE_URL;
  const source = profiles.monitor?.source;
  const es = source ? base[source.mcp]?.env.ES_URL : undefined;
  // Источники логов с одним адресом Kibana (например, индексы Keycloak и других сервисов) - одна интеграция с id первого из них.
  const kibanas = new Map<string, string>();
  for (const [id, s] of Object.entries(profiles.logs)) if (!kibanas.has(trim(s.url))) kibanas.set(trim(s.url), id);
  return [
    {
      id: 'jira',
      kind: 'jira',
      title: 'Jira',
      url: trim(profiles.jira.baseUrl),
      mcp: atlassian,
      usedBy: 'Доска и карточки задач, переводы по статусам, комментарии и вложения, наблюдатель задач, Jira у агентов',
      tokenHelp: 'Персональный токен: Jira, профиль, Personal Access Tokens',
      note: null,
    },
    {
      id: 'confluence',
      kind: 'confluence',
      title: 'Confluence',
      url: confluence ? trim(confluence) : null,
      mcp: atlassian,
      usedBy: 'Страница вики задачи и чтение вики агентами',
      tokenHelp: 'Персональный токен: Confluence, профиль, Personal Access Tokens',
      note: confluence ? null : `Адреса Confluence нет: у MCP-сервера ${atlassian} в ~/.claude.json нет CONFLUENCE_URL`,
    },
    ...profiles.contours.flatMap((c): IntegrationDef[] =>
      c.mcp.bitbucket
        ? [
            {
              id: `bitbucket-${c.id}`,
              kind: 'bitbucket',
              title: `Bitbucket ${c.title}`,
              url: trim(c.git),
              mcp: c.mcp.bitbucket,
              usedBy: 'PR задачи: создание, замечания ревьюеров, ответы на них и мерж',
              tokenHelp: 'HTTP access token: Bitbucket, Manage account, HTTP access tokens, права Project read и Repository write; им же git делает fetch и push по https',
              note: note(c),
            },
          ]
        : [],
    ),
    ...profiles.contours.flatMap((c): IntegrationDef[] =>
      c.mcp.bamboo
        ? [
            {
              id: `bamboo-${c.id}`,
              kind: 'bamboo',
              title: `Bamboo ${c.title}`,
              url: trim(c.bamboo),
              mcp: c.mcp.bamboo,
              usedBy: 'Сборки веток, релизы и деплой на стенды, экран "Стенды"',
              tokenHelp: 'Personal access token: Bamboo, профиль, Personal access tokens',
              note: note(c),
            },
          ]
        : [],
    ),
    ...(source
      ? [
          {
            id: `logs-${source.id}`,
            kind: 'elasticsearch' as const,
            title: `Логи прода ${source.id}`,
            url: es ? trim(es) : null,
            mcp: source.mcp,
            usedBy: 'Экран "Мониторинг" и шаг "Дашборд задачи", только чтение',
            tokenHelp: 'API-ключ Elasticsearch только на чтение',
            note: es ? null : `Адреса кластера нет: у MCP-сервера ${source.mcp} в ~/.claude.json нет ES_URL`,
          },
        ]
      : []),
    ...[...kibanas].map(
      ([url, id], _i, all): IntegrationDef => ({
        id: `stands-${id}`,
        kind: 'kibana',
        title: all.length > 1 ? `Kibana стендов ${hostOf(url) ?? url}` : 'Kibana стендов',
        url,
        mcp: null,
        usedBy: 'Экран "Стенды" и проверка выкатки после деплоя',
        tokenHelp: null,
        note: null,
      }),
    ),
    {
      id: 'claude',
      kind: 'claude',
      title: 'Claude',
      url: null,
      mcp: null,
      usedBy: 'Агентные шаги: план, код, проверка, тест на стенде, вики, разбор прогона, мастер шагов, дашборды',
      tokenHelp: 'Токен из claude setup-token (подписка) или ключ API из Anthropic Console',
      note: null,
    },
  ];
}

/** Токен, заданный для интеграции в Task Pilot. */
export interface TokenAccess {
  def: IntegrationDef;
  token: string;
  /** Логин владельца токена: его просит MCP-сервер Bitbucket. */
  user: string | null;
}

/**
 * MCP-серверы с доступом из токенов Task Pilot: у сервера интеграции адрес и токен (у Bitbucket и логин) берутся из
 * токена, остальное env - из ~/.claude.json как есть. Jira и Confluence живут в одном сервере atlassian, и их
 * токены ложатся в него оба. Сервера нет в ~/.claude.json - он запускается пакетом из DEFAULT_MCP.
 */
export function effectiveServers(base: Record<string, McpServerConfig>, tokens: TokenAccess[]): Record<string, McpServerConfig> {
  const out = { ...base };
  for (const t of tokens) {
    const { kind, mcp, url } = t.def;
    if (!isMcpKind(kind) || !mcp || !url) continue;
    const vars = ACCESS_ENV[kind];
    const cfg = out[mcp] ?? DEFAULT_MCP[kind];
    out[mcp] = { ...cfg, env: { ...cfg.env, [vars.url]: url, [vars.token]: t.token, ...(vars.user && t.user ? { [vars.user]: t.user } : {}) } };
  }
  return out;
}

/** Хост адреса; null - адрес не разбирается. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Вид токена Claude по его началу: токен claude setup-token или ключ API. */
export type ClaudeTokenKind = 'oauth-token' | 'api-key';

/** Переменная окружения CLI claude для токена каждого вида. */
export const CLAUDE_TOKEN_ENV: Record<ClaudeTokenKind, string> = {
  'oauth-token': 'CLAUDE_CODE_OAUTH_TOKEN',
  'api-key': 'ANTHROPIC_API_KEY',
};

export function claudeTokenKind(token: string): ClaudeTokenKind | null {
  if (token.startsWith('sk-ant-oat')) return 'oauth-token';
  if (token.startsWith('sk-ant-api')) return 'api-key';
  return null;
}

/** Токен из поля ввода: без пробелов по краям; пробелы и переводы строк внутри значат, что вставили не то. */
export function cleanToken(raw: string): string {
  const token = raw.trim();
  if (token.length < 8) throw new Error('Токен слишком короткий');
  if (token.length > 4096) throw new Error('Токен слишком длинный');
  if (/\s/.test(token)) throw new Error('В токене пробелы или переводы строк: вставлен не токен');
  return token;
}

/** Последние символы токена: по ним владелец узнает, какой токен заведен. */
export function tokenHint(token: string): string {
  return `...${token.slice(-4)}`;
}
