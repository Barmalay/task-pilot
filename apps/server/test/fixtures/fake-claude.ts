/**
 * Подмена CLI claude для тестов раннера. Пишет поток stream-json как настоящий CLI; поведение
 * задает переменная FAKE_MODE: ok, error, crash, noinit (падает до начала сессии), hang, ask (сам вызывает
 * ask_owner у MCP-сервера pipeline из --mcp-config, как это делал бы агент), servers (возвращает имена
 * серверов из конфига), mcp-env (возвращает env серверов владельца из конфига), browser (вызывает qa_browser
 * с действиями из FAKE_BROWSER_ACTIONS и возвращает ответ).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const argOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = args[args.indexOf('-p') + 1];
const sessionId = argOf('--session-id') ?? argOf('--resume') ?? 'none';
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const result = (extra: Record<string, unknown>) =>
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Готово', session_id: sessionId, total_cost_usd: 0.12, duration_ms: 1500, num_turns: 3, permission_denials: [], ...extra });

// Переменные аккаунта Claude записываются значениями: по ним тест видит, под каким аккаунтом запущен агент.
const account = Object.fromEntries(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, env: Object.keys(process.env), account, cwd: process.cwd() }));
// noinit: CLI падает раньше, чем начал сессию, например на неизвестном флаге.
if (process.env.FAKE_MODE === 'noinit') {
  process.stderr.write('error: unknown option');
  process.exit(2);
}
out({ type: 'system', subtype: 'init', session_id: sessionId, model: argOf('--model') ?? 'fake' });

const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'crash') {
  process.stderr.write('boom');
  process.exit(3);
} else if (mode === 'hang') {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 100' } }] } });
  setInterval(() => undefined, 1000);
} else if (mode === 'error') {
  out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, result: '', session_id: sessionId, total_cost_usd: 0.5, duration_ms: 10, num_turns: 2 });
} else if (mode === 'servers') {
  const cfg = JSON.parse(readFileSync(argOf('--mcp-config')!, 'utf8')) as { mcpServers: Record<string, unknown> };
  result({ structured_output: { servers: Object.keys(cfg.mcpServers).sort() } });
} else if (mode === 'mcp-env') {
  const cfg = JSON.parse(readFileSync(argOf('--mcp-config')!, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
  result({ structured_output: Object.fromEntries(Object.entries(cfg.mcpServers).filter(([name]) => name !== 'pipeline').map(([name, s]) => [name, s.env])) });
} else if (mode === 'browser') {
  const cfg = (JSON.parse(readFileSync(argOf('--mcp-config')!, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> })
    .mcpServers.pipeline!;
  const client = new Client({ name: 'fake-claude', version: '0' });
  await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...(process.env as Record<string, string>), ...cfg.env }, stderr: 'ignore' }));
  const r = (await client.callTool({ name: 'qa_browser', arguments: { actions: JSON.parse(process.env.FAKE_BROWSER_ACTIONS ?? '[]') } }, undefined, { timeout: 30_000 })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  await client.close();
  result({ structured_output: { text: r.content[0]!.text, isError: r.isError === true } });
} else if (mode === 'ask') {
  const cfg = (JSON.parse(readFileSync(argOf('--mcp-config')!, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> })
    .mcpServers.pipeline!;
  const client = new Client({ name: 'fake-claude', version: '0' });
  await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...(process.env as Record<string, string>), ...cfg.env }, stderr: 'ignore' }));
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__pipeline__ask_owner', input: { question: 'Какой стенд?' } }] } });
  const r = (await client.callTool({ name: 'ask_owner', arguments: { question: 'Какой стенд?', options: ['stable', 'testing-2'] } }, undefined, { timeout: 30_000 })) as {
    content: { text: string }[];
  };
  await client.callTool({ name: 'report_progress', arguments: { message: 'Получил ответ владельца' } });
  await client.close();
  result({ structured_output: { answer: r.content[0]!.text } });
} else {
  const file = join(process.cwd(), 'src/A.java');
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Читаю код' }, { type: 'tool_use', id: 'toolu_fake_read', name: 'Read', input: { file_path: file } }] } });
  out({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_read', content: '1\tclass A {} // secret-token-value-123' }] },
    tool_use_result: { type: 'text', file: { filePath: file, content: 'class A {}', numLines: 1, startLine: 1, totalLines: 1 } },
  });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:mcp__pipeline__ask_owner' } }] } });
  result({ structured_output: { prompt }, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }] });
}
