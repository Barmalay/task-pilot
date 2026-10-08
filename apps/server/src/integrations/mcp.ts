import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../config.ts';

/** Ошибка вызова инструмента MCP. */
export class McpError extends Error {}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Достает данные из ответа инструмента. mcp-atlassian кладет JSON строкой в structuredContent.result
 * или в текстовый контент, поэтому строка с JSON разбирается до объекта.
 */
export function parseToolResult(result: ToolResult): unknown {
  let raw: unknown = result.structuredContent?.result ?? result.content?.find((c) => c.type === 'text')?.text;
  if (typeof raw === 'string') raw = tryJson(raw);
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { result?: unknown }).result === 'string') {
    return tryJson((raw as { result: string }).result);
  }
  return raw;
}

function toolText(result: ToolResult): string {
  return (result.content ?? []).map((c) => c.text ?? '').join(' ').trim();
}

/** Сколько ждет ответа вызов инструмента. */
const CALL_TIMEOUT_MS = 120_000;

/** Конфигурация MCP-серверов: готовый набор или функция, которая отдает текущий (доступ меняется на экране "Интеграции"). */
export type McpServers = Record<string, McpServerConfig> | (() => Record<string, McpServerConfig>);

interface Connection {
  /** Конфигурация, с которой открыто подключение. */
  signature: string;
  client: Promise<Client>;
}

/**
 * Держит подключения к MCP-серверам из ~/.claude.json и вызывает их инструменты напрямую, без LLM.
 * Сервер запускается при первом обращении и переиспользуется; упавшее подключение открывается заново.
 * Если конфигурация сервера изменилась (другой токен), следующий вызов идет в новое подключение, а старое
 * закрывается, когда его вызовы уже закончились или истекли.
 */
export class McpHub {
  private readonly servers: () => Record<string, McpServerConfig>;
  private readonly clients = new Map<string, Connection>();
  private readonly retired = new Set<Promise<Client>>();

  constructor(servers: McpServers) {
    this.servers = typeof servers === 'function' ? servers : () => servers;
  }

  has(name: string): boolean {
    return name in this.servers();
  }

  private async connect(cfg: McpServerConfig, forget: () => void): Promise<Client> {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...getDefaultEnvironment(), ...cfg.env },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'task-pilot', version: '0.1.0' });
    transport.onclose = forget;
    await client.connect(transport);
    return client;
  }

  private retire(client: Promise<Client>): void {
    this.retired.add(client);
    const close = () => {
      this.retired.delete(client);
      void client.then((c) => c.close()).catch(() => undefined);
    };
    setTimeout(close, CALL_TIMEOUT_MS).unref();
  }

  private client(name: string): Promise<Client> {
    const cfg = this.servers()[name];
    if (!cfg) return Promise.reject(new McpError(`MCP-сервер ${name} не настроен в ~/.claude.json`));
    const signature = JSON.stringify(cfg);
    const current = this.clients.get(name);
    if (current?.signature === signature) return current.client;
    if (current) {
      this.clients.delete(name);
      this.retire(current.client);
    }
    // Забывается только свое подключение: запоздалое закрытие старого не должно выбросить новое.
    let entry: Connection | undefined;
    const forget = () => {
      if (entry && this.clients.get(name) === entry) this.clients.delete(name);
    };
    entry = { signature, client: this.connect(cfg, forget) };
    this.clients.set(name, entry);
    entry.client.catch(forget);
    return entry.client;
  }

  /** Вызывает инструмент и возвращает разобранный результат; ошибку инструмента превращает в исключение. */
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.client(server);
    const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as ToolResult;
    if (result.isError) throw new McpError(`${server}/${tool}: ${toolText(result) || 'ошибка инструмента'}`);
    return parseToolResult(result);
  }

  async close(): Promise<void> {
    const all = [...[...this.clients.values()].map((c) => c.client), ...this.retired];
    this.clients.clear();
    this.retired.clear();
    await Promise.allSettled(all.map(async (p) => (await p).close()));
  }
}
