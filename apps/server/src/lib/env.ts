/**
 * Окружение дочернего процесса: переменные родительской сессии Claude (в том числе адрес ее прокси
 * API и сокет сообщений) не передаются, остальное окружение владельца сохраняется.
 */
export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || /^(CLAUDE|ANTHROPIC_|MCP_)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
