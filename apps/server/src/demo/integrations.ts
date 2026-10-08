import type { IntegrationParts } from '../app.ts';
import type { ClaudeCli, ClaudeLoginProcess } from '../integrations/claude-cli.ts';
import { memorySecrets } from '../integrations/secrets.ts';
import { AccessDenied, type WhoAmI } from '../integrations/whoami.ts';

/** Токен демо, который системы "не принимают": на нем видно, как экран показывает отказ. */
const REJECTED = /bad|wrong|неверн/i;

/** "Кто я" в демо: токен никуда не уходит, владелец токена - демо-аккаунт по его последним символам. */
const demoWhoAmI: WhoAmI = async (kind, _url, token) => {
  if (kind === 'kibana') return { login: null, name: null };
  if (!token || REJECTED.test(token)) throw new AccessDenied('Демо: токен не принят, ответ 401');
  const tail = token.slice(-4).toLowerCase();
  return { login: `demo-${tail}`, name: `Демо-аккаунт ${tail}` };
};

/**
 * CLI claude демо со сценарным агентом: вход владельца и проверка токена без настоящего CLI. Вход через браузер
 * ничего не открывает и заканчивается, когда на экране вставлен любой код.
 */
export function demoClaude(email: string): ClaudeCli {
  // Папка аккаунта и почта, под которой в нее "вошли".
  const logged = new Map<string, string>();
  return {
    async status(env) {
      const dir = env.CLAUDE_CONFIG_DIR;
      const who = dir ? logged.get(dir) : email;
      if (!who) return { loggedIn: false, method: 'none', email: null, org: null, plan: null };
      return { loggedIn: true, method: 'claude.ai', email: who, org: 'Демо', plan: 'team' };
    },
    login(env): ClaudeLoginProcess {
      let finish: (r: { code: number | null; output: string }) => void = () => {};
      const done = new Promise<{ code: number | null; output: string }>((resolve) => (finish = resolve));
      return {
        url: () => 'https://claude.ai/demo-login',
        sendCode: () => {
          if (env.CLAUDE_CONFIG_DIR) logged.set(env.CLAUDE_CONFIG_DIR, `claude-${logged.size + 1}@demo.invalid`);
          finish({ code: 0, output: 'Login successful.' });
        },
        cancel: () => finish({ code: null, output: 'отменено' }),
        done,
      };
    },
    async logout(env) {
      if (env.CLAUDE_CONFIG_DIR) logged.delete(env.CLAUDE_CONFIG_DIR);
    },
    async probe(env) {
      const token = env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '';
      if (REJECTED.test(token)) throw new Error('CLI claude не ответил с этим доступом: Invalid API key');
    },
  };
}

/**
 * Интеграции демо: токены в памяти, "кто я" и доступ "как обычно" подменные, в настоящие системы запросов нет.
 * Claude в демо с живым агентом настоящий: агенты работают под входом CLI владельца.
 */
export function demoIntegrations(me: string, scripted: boolean, email: string): IntegrationParts {
  return {
    secrets: memorySecrets('памяти демо'),
    whoami: demoWhoAmI,
    checkDefault: async (def) => (def.kind === 'kibana' ? { login: null, name: null } : { login: me, name: 'Владелец (демо)' }),
    ...(scripted ? { claude: demoClaude(email) } : {}),
  };
}
