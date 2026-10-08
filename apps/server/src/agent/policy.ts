import type { AgentRequest } from '@task-pilot/step-kit';
import { childEnv } from '../lib/env.ts';

/** Встроенные инструменты, которые разрешаются целиком: они только читают. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** Инструменты конвейера: агенту они доступны всегда. */
export const PIPELINE_TOOLS = ['mcp__pipeline__ask_owner', 'mcp__pipeline__report_progress'];

/** MCP-серверы владельца по видам, чьи пишущие инструменты агентам запрещены всегда: их имена задают профили слоев. */
export interface McpWriteServers {
  /** Серверы Jira и Confluence (mcp-atlassian): mcp профиля доски. */
  atlassian: string[];
  /** Серверы Bitbucket контуров. */
  bitbucket: string[];
  /** Серверы Bamboo контуров. */
  bamboo: string[];
}

/**
 * Пишущие инструменты MCP владельца на серверах servers. Разрешения шагов их не открывают: запрет сильнее разрешения,
 * а публикует только конвейер после подтверждения владельца. Серверы Bitbucket и Bamboo у каждого контура свои, имена
 * берутся из профилей контуров, а не из списка: у команды с другими именами серверов запрет действует так же.
 */
export function mcpWriteTools(servers: McpWriteServers): string[] {
  const of = (list: string[], tools: string[]) => [...new Set(list)].flatMap((server) => tools.map((t) => `mcp__${server}__${t}`));
  return [
    ...of(servers.atlassian, [
      'jira_add_comment',
      'jira_add_issues_to_sprint',
      'jira_add_watcher',
      'jira_add_worklog',
      'jira_assign_issue',
      'jira_batch_create_issues',
      'jira_batch_create_versions',
      'jira_create_customer_request',
      'jira_create_issue',
      'jira_create_issue_link',
      'jira_create_remote_issue_link',
      'jira_create_sprint',
      'jira_create_version',
      'jira_delete_issue',
      'jira_edit_comment',
      'jira_link_to_epic',
      'jira_move_issue',
      'jira_move_issues_to_backlog',
      'jira_remove_issue_link',
      'jira_remove_watcher',
      'jira_transition_issue',
      'jira_update_issue',
      'jira_update_proforma_form_answers',
      'jira_update_sprint',
      'jira_update_version',
      'confluence_add_comment',
      'confluence_add_inline_comment',
      'confluence_add_label',
      'confluence_copy_page',
      'confluence_create_page',
      'confluence_create_page_from_template',
      'confluence_delete_attachment',
      'confluence_delete_page',
      'confluence_move_page',
      'confluence_reply_to_comment',
      'confluence_set_page_restrictions',
      'confluence_update_page',
      'confluence_update_page_section',
      'confluence_upload_attachment',
      'confluence_upload_attachments',
    ]),
    ...of(servers.bitbucket, [
      'add_comment',
      'create_pull_request',
      'decline_pull_request',
      'delete_branch',
      'manage_attachments',
      'manage_comment',
      'merge_pull_request',
      'set_review_status',
      'update_pull_request',
    ]),
    ...of(servers.bamboo, [
      'bamboo_clone_plan',
      'bamboo_create_deployment_project',
      'bamboo_disable_plan',
      'bamboo_enable_plan',
      'bamboo_stop_build',
      'bamboo_trigger_build',
      'bamboo_trigger_deployment',
    ]),
  ];
}

/**
 * Запреты для любого агентного шага: публикует только конвейер, файлы с токенами и служебные файлы
 * инструмента не читаются, сеть напрямую недоступна. Флаги --output, --no-index и --contents
 * превращают "читающие" команды git в запись или чтение любого файла, поэтому запрещены целиком.
 * secretPaths - файлы входа папок аккаунтов Claude с экрана "Интеграции": путь или шаблон, файл или папка целиком.
 * writeServers - MCP-серверы, чьи пишущие инструменты запрещены; по умолчанию только сервер Jira atlassian.
 * Главная защита от кода, который запускает сборка, - песочница (sandboxSettings), а не эти правила.
 */
export function baseDeny(dataDir: string, secretPaths: string[] = [], writeServers: McpWriteServers = { atlassian: ['atlassian'], bitbucket: [], bamboo: [] }): string[] {
  return [
    'Bash(git push)',
    'Bash(git push *)',
    'Bash(git commit)',
    'Bash(git commit *)',
    'Bash(git *--output*)',
    'Bash(git *--no-index*)',
    'Bash(git *--contents*)',
    'Bash(curl *)',
    'Bash(wget *)',
    'Read(~/.claude.json)',
    'Read(~/.claude.json.*)',
    'Read(~/.claude/backups/**)',
    `Read(/${dataDir}/**)`,
    ...secretPaths.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]),
    ...mcpWriteTools(writeServers),
  ];
}

/**
 * Песочница CLI для команд Bash агента: без сети, запись только в рабочую папку, writeDirs, ~/.m2
 * и временные папки, файлы с токенами и служебная папка инструмента не читаются. Она действует и на
 * дочерние процессы: код тестов или плагинов сборки не может ни запушить, ни отправить данные наружу.
 * Если песочница недоступна, CLI не запускает команды вовсе (failIfUnavailable).
 */
export function sandboxSettings(opts: { writeDirs: string[]; dataDir: string; denyRead?: string[] }): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: [] },
      filesystem: {
        allowWrite: [...opts.writeDirs, '~/.m2'],
        denyRead: ['~/.claude.json*', '~/.claude/backups', opts.dataDir, ...(opts.denyRead ?? [])],
      },
    },
  });
}

/** Запуск агента со всем, что движок добавил к запросу шага. */
export interface ClaudeInvocation {
  request: AgentRequest;
  effort?: string;
  sessionId: string;
  /** true - продолжить сессию sessionId, false - начать новую с этим id. */
  resume: boolean;
  mcpConfigFile: string;
  /** Плагин со скиллами агентов Task Pilot для --plugin-dir. */
  pluginDir?: string;
  deny: string[];
  /** Настройки песочницы для --settings. */
  settings: string;
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/** Папки, куда агенту можно писать: рабочая папка (если writeCwd не false) и writeDirs. */
export function writableDirs(r: AgentRequest): string[] {
  return unique([...(r.writeCwd === false ? [] : [r.cwd]), ...(r.writeDirs ?? [])]);
}

/**
 * Аргументы claude -p. Права задаются четырьмя флагами: --tools ограничивает встроенные инструменты,
 * --allowedTools заранее разрешает нужное, --disallowedTools запрещает жестко, а режим dontAsk
 * отклоняет все прочее без вопроса. Писать можно только в рабочую папку и явно указанные папки;
 * команды Bash выполняются в песочнице из --settings.
 */
export function buildClaudeArgs(i: ClaudeInvocation): string[] {
  const r = i.request;
  const writes = r.tools.some((t) => t === 'Edit' || t === 'Write');
  const allow = unique([
    'ToolSearch',
    ...PIPELINE_TOOLS,
    ...r.tools.filter((t) => READ_TOOLS.has(t)),
    ...(writes ? writableDirs(r).map((dir) => `Edit(/${dir}/**)`) : []),
    ...(r.allow ?? []),
  ]);
  const args = [
    '-p',
    r.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--tools',
    unique([...r.tools, 'ToolSearch']).join(','),
    '--mcp-config',
    i.mcpConfigFile,
    '--strict-mcp-config',
    '--settings',
    i.settings,
  ];
  for (const dir of r.writeDirs ?? []) args.push('--add-dir', dir);
  if (i.pluginDir) args.push('--plugin-dir', i.pluginDir);
  if (r.model) args.push('--model', r.model);
  if (i.effort) args.push('--effort', i.effort);
  if (r.maxBudgetUsd) args.push('--max-budget-usd', String(r.maxBudgetUsd));
  if (r.schema) args.push('--json-schema', JSON.stringify(r.schema));
  args.push(i.resume ? '--resume' : '--session-id', i.sessionId);
  // Флаги со списком значений идут последними: такой флаг забирает все аргументы до следующего флага.
  args.push('--allowedTools', ...allow);
  args.push('--disallowedTools', ...unique([...i.deny, ...(r.deny ?? [])]));
  return args;
}

/**
 * Окружение агента: переменные родительской сессии Claude (в том числе адрес ее прокси API)
 * убираются, чтобы агент работал под собственным входом владельца в CLI, как при запуске из терминала,
 * или под аккаунтом с экрана "Интеграции", чьи переменные (CLAUDE_CONFIG_DIR или токен) приходят в extra.
 */
export function agentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  return childEnv(base, extra);
}
