import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JiraConfig } from '@task-pilot/step-kit';
import type { McpServerConfig } from '../config.ts';
import type { EventBus } from '../engine/events.ts';
import type { AccountDto, ClaudeLoginDto, IntegrationAccountDto, IntegrationCheckDto, IntegrationDto, IntegrationsDto } from '@task-pilot/api-types';
import type { Redactor } from '../lib/redact.ts';
import type { IntegrationAccountKind, IntegrationAccountRow, Store } from '../store/db.ts';
import { claudeDirSecrets, prepareClaudeDir, removeClaudeDir, type ClaudeCli, type ClaudeLoginProcess } from './claude-cli.ts';
import {
  ACCESS_ENV,
  CLAUDE_TOKEN_ENV,
  claudeTokenKind,
  cleanToken,
  effectiveServers,
  hostOf,
  isMcpKind,
  tokenHint,
  type IntegrationDef,
  type TokenAccess,
} from './registry.ts';
import type { SecretStore } from './secrets.ts';
import type { Identity, WhoAmI } from './whoami.ts';

/** Ошибка запроса к интеграциям с HTTP-статусом для API. */
export class IntegrationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Зависимости сервиса интеграций. */
export interface IntegrationServiceDeps {
  defs: IntegrationDef[];
  /** MCP-серверы из ~/.claude.json: доступ "как обычно". */
  base: Record<string, McpServerConfig>;
  store: Store;
  secrets: SecretStore;
  whoami: WhoAmI;
  /**
   * Проверка доступа "как обычно" у всех интеграций, кроме Claude; по умолчанию - запрос "кто я" с токеном из env
   * MCP-сервера. Демо подменяет ее, чтобы не ходить в настоящие системы.
   */
  checkDefault?: (def: IntegrationDef) => Promise<Identity>;
  claude: ClaudeCli;
  /** Папка, где лежат папки аккаунтов Claude со входом через браузер. */
  claudeAccountsDir: string;
  /** ~/.claude: общее, что агенты видят под любым аккаунтом. */
  claudeHome: string;
  /** Профиль доски: me - логин при доступе к Jira "как обычно", из личных настроек. */
  jira: JiraConfig;
  redact: Redactor;
  /** Появился секрет: его надо маскировать и не пропускать в публикуемые тексты. */
  onSecret: (value: string) => void;
  bus: EventBus;
  /** Идет ли сейчас хоть один агент шага: папку входа Claude, под которой он может работать, удалять нельзя. */
  agentsRunning?: () => boolean;
  now?: () => number;
}

/** Сколько живет итог проверки доступа, прежде чем экран спросит систему снова. */
const CHECK_TTL_MS = 5 * 60_000;
/** Сколько ждать конца входа в Claude через браузер. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface PendingLogin {
  id: string;
  label: string | null;
  dir: string;
  process: ClaudeLoginProcess;
  state: ClaudeLoginDto['state'];
  error: string | null;
  startedAt: string;
  cancelled: boolean;
}

/** Чем проверен токен Claude: у него нет "кто я", только ответ CLI. */
const PROBED = 'проверен запуском claude -p';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Удаляет папку входа Claude без исключений: она убирается в фоне, и сбой не должен ронять сервер. */
function dropClaudeDir(dir: string, root: string): void {
  try {
    removeClaudeDir(dir, root);
  } catch (e) {
    console.warn(`Папка входа Claude ${dir} не удалена: ${message(e)}`);
  }
}
/** Путь для подписи: домашняя папка сокращена до ~. */
const tilde = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);
/** Имя записи токена в хранилище. */
const secretId = (a: Pick<IntegrationAccountRow, 'integration' | 'id'>) => `${a.integration}.${a.id}`;

/**
 * Интеграции Task Pilot: откуда берется доступ к каждой системе и под чьим аккаунтом Task Pilot туда ходит.
 * "Как обычно" доступ берется из env MCP-серверов ~/.claude.json и входа CLI claude, как без этого экрана.
 * Заведенный здесь токен лежит в хранилище секретов (Keychain), а в базе только его подпись; активный токен
 * интеграции подменяет адрес и токен в env ее MCP-сервера (`servers`), у Claude - переменные окружения агентов
 * (`claudeEnv`). Смена действует сразу: консьюмеры берут `servers()` при каждом обращении, агенты - при запуске.
 */
export class IntegrationService {
  private readonly d: IntegrationServiceDeps;
  private readonly tokens = new Map<string, string>();
  private readonly checks = new Map<string, { at: number; check: IntegrationCheckDto }>();
  private readonly inflight = new Map<string, Promise<IntegrationCheckDto>>();
  private readonly logins = new Map<string, PendingLogin>();
  private effective: Record<string, McpServerConfig> | null = null;

  constructor(deps: IntegrationServiceDeps) {
    this.d = deps;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /**
   * Читает токены аккаунтов из хранилища. Активный аккаунт, чей токен не прочитался, выключается: Task Pilot не
   * должен молча ходить под другим доступом, чем выбран, поэтому интеграция возвращается к доступу "как обычно"
   * с объяснением в ленте и на экране.
   */
  async init(): Promise<void> {
    for (const a of this.d.store.integrationAccounts()) {
      if (a.kind === 'login') continue;
      let token: string | null = null;
      let error: string | null = null;
      try {
        token = await this.d.secrets.get(secretId(a));
        if (!token) error = `Токена нет в ${this.d.secrets.where}: заведите его заново`;
      } catch (e) {
        error = `Токен не прочитан из ${this.d.secrets.where}: ${message(e)}`;
      }
      if (token) {
        this.tokens.set(a.id, token);
        this.d.onSecret(token);
        continue;
      }
      this.d.store.checkedIntegrationAccount(a.id, { error });
      if (this.d.store.activeIntegrationAccount(a.integration) === a.id) {
        this.d.store.setActiveIntegrationAccount(a.integration, null);
        const title = this.def(a.integration)?.title ?? a.integration;
        this.d.bus.emitEvent({ type: 'integration.changed', message: `${title}: ${error}. Доступ снова как обычно`, data: { integration: a.integration } });
      }
    }
    this.effective = null;
  }

  private def(id: string): IntegrationDef | undefined {
    return this.d.defs.find((d) => d.id === id);
  }

  private mustDef(id: string): IntegrationDef {
    const def = this.def(id);
    if (!def) throw new IntegrationError(`Нет интеграции ${id}`, 404);
    return def;
  }

  private activeRow(integration: string): IntegrationAccountRow | null {
    const id = this.d.store.activeIntegrationAccount(integration);
    return id ? (this.d.store.integrationAccounts(integration).find((a) => a.id === id) ?? null) : null;
  }

  private mustRow(def: IntegrationDef, accountId: string): IntegrationAccountRow {
    const row = this.d.store.integrationAccounts(def.id).find((a) => a.id === accountId);
    if (!row) throw new IntegrationError(`У интеграции ${def.title} нет аккаунта ${accountId}`, 404);
    return row;
  }

  /** MCP-серверы с доступом активных токенов; объект меняется только вместе с доступом. */
  servers(): Record<string, McpServerConfig> {
    if (!this.effective) {
      const tokens: TokenAccess[] = [];
      for (const def of this.d.defs) {
        const a = this.activeRow(def.id);
        const token = a?.kind === 'token' ? this.tokens.get(a.id) : undefined;
        if (a && token) tokens.push({ def, token, user: a.login });
      }
      this.effective = effectiveServers(this.d.base, tokens);
    }
    return this.effective;
  }

  /**
   * Заголовки git для хостов Bitbucket, у которых активен токен Task Pilot: fetch и push по https идут с ним, а без
   * токена git берет учетные данные из Keychain, как обычно.
   */
  gitHeaders(): { prefix: string; header: string }[] {
    return this.d.defs.flatMap((def) => {
      if (def.kind !== 'bitbucket' || !def.url) return [];
      const a = this.activeRow(def.id);
      const token = a?.kind === 'token' ? this.tokens.get(a.id) : undefined;
      return token ? [{ prefix: `${def.url}/`, header: `Authorization: Bearer ${token}` }] : [];
    });
  }

  /** Профиль доски: при токене Task Pilot задачи назначаются на владельца токена, иначе на me личных настроек. */
  jiraProfile(): JiraConfig {
    const a = this.activeRow('jira');
    return a?.login ? { ...this.d.jira, me: a.login } : this.d.jira;
  }

  private claudeEnvOf(a: IntegrationAccountRow | null): Record<string, string> {
    if (!a) return {};
    if (a.kind === 'login' && a.dir) return { CLAUDE_CONFIG_DIR: a.dir };
    const token = this.tokens.get(a.id);
    return token && (a.kind === 'oauth-token' || a.kind === 'api-key') ? { [CLAUDE_TOKEN_ENV[a.kind]]: token } : {};
  }

  /** Переменные окружения агентов для активного аккаунта Claude; пусто - вход CLI владельца. */
  claudeEnv(): Record<string, string> {
    return this.claudeEnvOf(this.activeRow('claude'));
  }

  /** Файлы входа всех папок аккаунтов Claude: агенту их читать нельзя. */
  claudeSecretPaths(): string[] {
    const dirs = [...this.d.store.integrationAccounts('claude').flatMap((a) => (a.dir ? [a.dir] : [])), ...[...this.logins.values()].map((l) => l.dir)];
    return dirs.flatMap(claudeDirSecrets);
  }

  // ---- Проверки доступа.

  private checkKey(def: IntegrationDef, accountId: string | null): string {
    return `${def.id}/${accountId ?? ''}`;
  }

  private ok(identity: Identity, detail: string | null = null): IntegrationCheckDto {
    return { ok: true, login: identity.login, name: identity.name, detail, error: null, at: new Date(this.now()).toISOString() };
  }

  private failed(error: string): IntegrationCheckDto {
    return { ok: false, login: null, name: null, detail: null, error: this.d.redact.text(error), at: new Date(this.now()).toISOString() };
  }

  private async claudeCheck(env: Record<string, string>): Promise<IntegrationCheckDto> {
    const s = await this.d.claude.status(env);
    if (!s.loggedIn) return this.failed('CLI claude не вошел в аккаунт');
    return this.ok({ login: s.email, name: s.org }, s.plan ? `тариф ${s.plan}` : null);
  }

  /** Доступ "как обычно": env MCP-сервера из ~/.claude.json, а у Claude - вход CLI. */
  private async checkDefault(def: IntegrationDef): Promise<IntegrationCheckDto> {
    if (def.kind === 'claude') return this.claudeCheck({});
    if (this.d.checkDefault) return this.ok(await this.d.checkDefault(def));
    if (def.kind === 'kibana') return def.url ? this.ok(await this.d.whoami('kibana', def.url, null)) : this.failed('Адрес неизвестен');
    if (!isMcpKind(def.kind) || !def.mcp) return this.failed('Доступ не настроен');
    const env = this.d.base[def.mcp]?.env;
    if (!env) return this.failed(`MCP-сервер ${def.mcp} не настроен в ~/.claude.json`);
    const vars = ACCESS_ENV[def.kind];
    const url = env[vars.url];
    const token = env[vars.token];
    if (!url || !token) return this.failed(`У MCP-сервера ${def.mcp} в ~/.claude.json нет ${vars.url} и ${vars.token}`);
    // Токен уходит только на хост системы из профиля, как у порта Bamboo.
    if (def.url && hostOf(url) !== hostOf(def.url)) return this.failed(`MCP-сервер ${def.mcp} смотрит на ${url}, а профиль - на ${def.url}: токен не отправляется`);
    return this.ok(await this.d.whoami(def.kind, url, token));
  }

  private async checkRow(def: IntegrationDef, a: IntegrationAccountRow): Promise<IntegrationCheckDto> {
    if (a.kind === 'login') return a.dir ? this.claudeCheck({ CLAUDE_CONFIG_DIR: a.dir }) : this.failed('Нет папки входа');
    const token = this.tokens.get(a.id);
    if (!token) return this.failed(a.error ?? `Токена нет в ${this.d.secrets.where}`);
    if (a.kind === 'oauth-token' || a.kind === 'api-key') {
      await this.d.claude.probe(this.claudeEnvOf(a));
      return this.ok({ login: null, name: null }, PROBED);
    }
    if (def.kind === 'claude' || def.kind === 'kibana' || !def.url) return this.failed('Токену некуда идти: адрес неизвестен');
    return this.ok(await this.d.whoami(def.kind, def.url, token));
  }

  /**
   * Проверка аккаунта с кэшем на CHECK_TTL_MS; одновременные запросы ждут одну проверку. Токены Claude проверяются
   * запуском claude -p, поэтому сами по себе не перепроверяются: только при заведении и по кнопке "Проверить".
   */
  private async checked(def: IntegrationDef, a: IntegrationAccountRow | null, force: boolean): Promise<IntegrationCheckDto | null> {
    const probed = a?.kind === 'oauth-token' || a?.kind === 'api-key';
    if (probed && !force) return a.checkedAt ? { ok: !a.error, login: null, name: null, detail: a.error ? null : PROBED, error: a.error, at: a.checkedAt } : null;
    const key = this.checkKey(def, a?.id ?? null);
    const cached = this.checks.get(key);
    if (!force && cached && this.now() - cached.at < CHECK_TTL_MS) return cached.check;
    const running = this.inflight.get(key);
    if (running) return running;
    const run = (async () => {
      let check: IntegrationCheckDto;
      try {
        check = a ? await this.checkRow(def, a) : await this.checkDefault(def);
      } catch (e) {
        check = this.failed(message(e));
      }
      this.checks.set(key, { at: this.now(), check });
      if (a) this.d.store.checkedIntegrationAccount(a.id, { login: check.login, name: check.name, error: check.error });
      return check;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  // ---- Экран.

  private defaultAccount(def: IntegrationDef, active: boolean, check: IntegrationCheckDto | null): IntegrationAccountDto {
    if (def.kind === 'kibana') return { id: null, kind: 'none', label: 'Без входа', source: 'Kibana стендов отвечает без авторизации', active: true, check };
    if (def.kind === 'claude') return { id: null, kind: 'default', label: 'Вход CLI claude', source: 'claude auth login в терминале, папка ~/.claude', active, check };
    return { id: null, kind: 'default', label: 'Как обычно, из Claude Code', source: `MCP-сервер ${def.mcp} в ~/.claude.json`, active, check };
  }

  private rowSource(a: IntegrationAccountRow): string {
    if (a.kind === 'login') return `вход через браузер, папка ${a.dir ? tilde(a.dir) : 'неизвестна'}`;
    const what = a.kind === 'oauth-token' ? 'токен claude setup-token' : a.kind === 'api-key' ? 'ключ API' : 'токен';
    return `${what} в ${this.d.secrets.where}${a.hint ? `, ${a.hint}` : ''}`;
  }

  private rowLabel(a: IntegrationAccountRow): string {
    // У Claude логин - почта, а имя - организация: почта точнее говорит, чей это аккаунт.
    const who = a.integration === 'claude' ? (a.login ?? a.name) : (a.name ?? a.login);
    return a.label ?? who ?? (a.kind === 'api-key' ? 'Ключ API' : a.kind === 'oauth-token' ? 'Токен setup-token' : 'Токен');
  }

  private loginDto(l: PendingLogin): ClaudeLoginDto {
    return { id: l.id, label: l.label, state: l.state, url: l.process.url(), error: l.error && this.d.redact.text(l.error), startedAt: l.startedAt };
  }

  private async integration(def: IntegrationDef, force: boolean): Promise<IntegrationDto> {
    const rows = this.d.store.integrationAccounts(def.id);
    const active = this.d.store.activeIntegrationAccount(def.id);
    const [first, ...rest] = await Promise.all([this.checked(def, null, force), ...rows.map((a) => this.checked(def, a, force))]);
    const checks = new Map(rows.map((a, i) => [a.id, rest[i] ?? null]));
    // Проверка могла обновить логин и имя: подписи берутся из базы после нее.
    const fresh = this.d.store.integrationAccounts(def.id);
    return {
      id: def.id,
      kind: def.kind,
      title: def.title,
      url: def.url,
      usedBy: def.usedBy,
      note: def.note,
      tokenHelp: def.tokenHelp,
      canToken: def.tokenHelp !== null && (def.kind === 'claude' || def.url !== null),
      canLogin: def.kind === 'claude',
      accounts: [
        this.defaultAccount(def, active === null, first ?? null),
        ...fresh.map((a) => ({ id: a.id, kind: a.kind, label: this.rowLabel(a), source: this.rowSource(a), active: a.id === active, check: checks.get(a.id) ?? null })),
      ],
      logins: def.kind === 'claude' ? [...this.logins.values()].map((l) => this.loginDto(l)) : [],
    };
  }

  /** Все интеграции с проверкой доступа; проверки кэшируются. */
  async list(): Promise<IntegrationsDto> {
    return { secrets: this.d.secrets.where, integrations: await Promise.all(this.d.defs.map((def) => this.integration(def, false))) };
  }

  /** Проверяет все аккаунты интеграции заново, в том числе токены Claude запуском claude -p. */
  async check(integrationId: string): Promise<IntegrationDto> {
    return this.integration(this.mustDef(integrationId), true);
  }

  /** Активные аккаунты Jira и Claude для шапки. */
  async account(): Promise<AccountDto> {
    const [jira, claude] = await Promise.all([this.integration(this.mustDef('jira'), false), this.integration(this.mustDef('claude'), false)]);
    const activeOf = (i: IntegrationDto) => i.accounts.find((a) => a.active) ?? i.accounts[0]!;
    return { jira: { active: activeOf(jira), me: this.jiraProfile().me }, claude: { active: activeOf(claude) } };
  }

  // ---- Изменения.

  private changed(def: IntegrationDef, text: string): void {
    this.effective = null;
    this.d.bus.emitEvent({ type: 'integration.changed', message: `${def.title}: ${text}`, data: { integration: def.id } });
  }

  private activeText(def: IntegrationDef, a: IntegrationAccountRow | null): string {
    if (!a) return def.kind === 'claude' ? 'агенты работают под входом CLI claude' : 'доступ как обычно, из Claude Code';
    return `активен аккаунт ${this.rowLabel(a)}${a.login && a.login !== this.rowLabel(a) ? ` (${a.login})` : ''}`;
  }

  /**
   * Заводит токен: он проверяется запросом к самой системе (у Claude - запуском claude -p), сохраняется в хранилище
   * секретов и сразу становится активным. Непроверенный токен не сохраняется.
   */
  async addToken(integrationId: string, input: { token: string; label?: string | null }): Promise<IntegrationDto> {
    const def = this.mustDef(integrationId);
    if (!def.tokenHelp) throw new IntegrationError(`${def.title} работает без входа: токен не нужен`);
    let token: string;
    try {
      token = cleanToken(input.token);
    } catch (e) {
      throw new IntegrationError(message(e));
    }
    const hide = (text: string) => text.split(token).join('***');
    let kind: IntegrationAccountKind = 'token';
    let identity: Identity = { login: null, name: null };
    if (def.kind === 'claude') {
      const k = claudeTokenKind(token);
      if (!k) throw new IntegrationError('Это не токен Claude: токен claude setup-token начинается с sk-ant-oat, ключ API - с sk-ant-api');
      kind = k;
      try {
        await this.d.claude.probe({ [CLAUDE_TOKEN_ENV[k]]: token });
      } catch (e) {
        throw new IntegrationError(`Токен не прошел проверку: ${hide(message(e))}`);
      }
    } else {
      if (!def.url || def.kind === 'kibana') throw new IntegrationError(def.note ?? `${def.title}: адрес неизвестен, токену некуда идти`);
      try {
        identity = await this.d.whoami(def.kind, def.url, token);
      } catch (e) {
        throw new IntegrationError(`Токен не прошел проверку: ${hide(message(e))}`);
      }
    }
    const id = randomUUID().slice(0, 8);
    try {
      await this.d.secrets.set(secretId({ integration: def.id, id }), token);
    } catch (e) {
      throw new IntegrationError(`Токен не сохранен в ${this.d.secrets.where}: ${hide(message(e))}`, 500);
    }
    this.tokens.set(id, token);
    this.d.onSecret(token);
    const row = this.d.store.addIntegrationAccount({ id, integration: def.id, kind, label: input.label?.trim() || null, login: identity.login, name: identity.name, hint: tokenHint(token), dir: null });
    this.d.store.setActiveIntegrationAccount(def.id, row.id);
    this.checks.set(this.checkKey(def, row.id), { at: this.now(), check: this.ok(identity, kind === 'token' ? null : PROBED) });
    this.changed(def, `заведен токен, ${this.activeText(def, row)}`);
    return this.integration(def, false);
  }

  /** Делает аккаунт активным; null - доступ "как обычно". */
  async activate(integrationId: string, accountId: string | null): Promise<IntegrationDto> {
    const def = this.mustDef(integrationId);
    if (def.kind === 'kibana') throw new IntegrationError(`${def.title} работает без входа: выбирать нечего`);
    const row = accountId === null ? null : this.mustRow(def, accountId);
    if (row && row.kind !== 'login' && !this.tokens.has(row.id)) throw new IntegrationError(`Токена аккаунта ${this.rowLabel(row)} нет в ${this.d.secrets.where}: заведите его заново`, 409);
    if (this.d.store.activeIntegrationAccount(def.id) !== (row?.id ?? null)) {
      this.d.store.setActiveIntegrationAccount(def.id, row?.id ?? null);
      this.changed(def, this.activeText(def, row));
    }
    return this.integration(def, false);
  }

  /** Удаляет аккаунт: токен из хранилища, у входа Claude - выход и его папку. Активный удаленный - доступ как обычно. */
  async remove(integrationId: string, accountId: string): Promise<IntegrationDto> {
    const def = this.mustDef(integrationId);
    const row = this.mustRow(def, accountId);
    const wasActive = this.d.store.activeIntegrationAccount(def.id) === row.id;
    // Агент, начатый под этим входом, работает с его папкой до конца шага, даже если активный аккаунт уже другой.
    if (row.kind === 'login' && this.d.agentsRunning?.()) {
      throw new IntegrationError('Сейчас работает агент шага, и он может быть под этим аккаунтом Claude: удалите аккаунт, когда шаг закончится', 409);
    }
    if (row.kind === 'login') {
      if (row.dir) {
        // Выход убирает запись входа из Keychain; не вышло - папка все равно удаляется, а с ней и вход.
        await this.d.claude.logout({ CLAUDE_CONFIG_DIR: row.dir }).catch(() => undefined);
        removeClaudeDir(row.dir, this.d.claudeAccountsDir);
      }
    } else {
      try {
        await this.d.secrets.remove(secretId(row));
      } catch (e) {
        throw new IntegrationError(`Токен не удален из ${this.d.secrets.where}: ${message(e)}`, 500);
      }
    }
    // Значение токена остается в маскировщике: оно могло попасть в уже записанный вывод.
    this.tokens.delete(row.id);
    this.checks.delete(this.checkKey(def, row.id));
    this.d.store.removeIntegrationAccount(row.id);
    this.changed(def, `аккаунт ${this.rowLabel(row)} удален${wasActive ? `, ${this.activeText(def, null)}` : ''}`);
    return this.integration(def, false);
  }

  // ---- Вход в Claude через браузер.

  /**
   * Запускает claude auth login в новой папке аккаунта: браузер открывает сам CLI, вход в ~/.claude и сессии
   * владельца не меняются. После входа аккаунт появляется в списке и становится активным.
   */
  async startClaudeLogin(input: { label?: string | null; email?: string | null }): Promise<IntegrationDto> {
    const def = this.mustDef('claude');
    const id = randomUUID().slice(0, 8);
    const dir = join(this.d.claudeAccountsDir, id);
    prepareClaudeDir(dir, this.d.claudeHome);
    const email = input.email?.trim() || null;
    const login: PendingLogin = {
      id,
      label: input.label?.trim() || null,
      dir,
      process: this.d.claude.login({ CLAUDE_CONFIG_DIR: dir }, email),
      state: 'waiting',
      error: null,
      startedAt: new Date(this.now()).toISOString(),
      cancelled: false,
    };
    this.logins.set(id, login);
    const timer = setTimeout(() => {
      login.error = 'Вход не закончен за 10 минут';
      login.process.cancel();
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
    void login.process.done.then(async ({ code, output }) => {
      clearTimeout(timer);
      if (login.cancelled) return;
      const fail = (error: string) => {
        login.state = 'failed';
        login.error = error;
        dropClaudeDir(dir, this.d.claudeAccountsDir);
        this.d.bus.emitEvent({ type: 'integration.changed', message: `${def.title}: вход через браузер не удался: ${this.d.redact.text(error)}`, data: { integration: def.id } });
      };
      if (code !== 0) return fail(login.error ?? `claude auth login завершился с кодом ${code}${output ? `: ${output}` : ''}`);
      login.state = 'checking';
      try {
        const s = await this.d.claude.status({ CLAUDE_CONFIG_DIR: dir });
        if (!s.loggedIn) return fail('CLI claude не вошел в аккаунт');
        const row = this.d.store.addIntegrationAccount({ id, integration: def.id, kind: 'login', label: login.label, login: s.email, name: s.org, hint: null, dir });
        this.logins.delete(id);
        this.d.store.setActiveIntegrationAccount(def.id, row.id);
        this.checks.set(this.checkKey(def, row.id), { at: this.now(), check: this.ok({ login: s.email, name: s.org }, s.plan ? `тариф ${s.plan}` : null) });
        this.changed(def, `вход через браузер, ${this.activeText(def, row)}`);
      } catch (e) {
        fail(message(e));
      }
    });
    this.d.bus.emitEvent({ type: 'integration.changed', message: `${def.title}: открыт вход через браузер`, data: { integration: def.id } });
    return this.integration(def, false);
  }

  private mustLogin(id: string): PendingLogin {
    const login = this.logins.get(id);
    if (!login) throw new IntegrationError('Вход не найден: он уже закончился', 404);
    return login;
  }

  /** Код со страницы входа, если браузер не вернулся в CLI сам. */
  claudeLoginCode(id: string, code: string): void {
    const login = this.mustLogin(id);
    if (login.state !== 'waiting') throw new IntegrationError('Вход уже не ждет кода', 409);
    login.process.sendCode(code);
  }

  /** Отменяет вход или убирает неудавшийся из списка. Папка входа удаляется, когда CLI уже завершился. */
  cancelClaudeLogin(id: string): void {
    const login = this.mustLogin(id);
    login.cancelled = true;
    login.process.cancel();
    this.logins.delete(id);
    void login.process.done.then(() => dropClaudeDir(login.dir, this.d.claudeAccountsDir));
    this.d.bus.emitEvent({ type: 'integration.changed', message: 'Claude: вход через браузер отменен', data: { integration: 'claude' } });
  }

  /** Сервер останавливается: незаконченные входы отменяются. */
  close(): void {
    for (const id of [...this.logins.keys()]) this.cancelClaudeLogin(id);
  }
}
