import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountDto, IntegrationDto, IntegrationsDto } from '@task-pilot/api-types';
import type { IdParams, ServerDeps } from '../support.ts';

const tokenBody = z.strictObject({ token: z.string().min(1).max(4096), label: z.string().max(80).optional() });
const activeBody = z.strictObject({ active: z.string().min(1).max(40).nullable() });
const loginBody = z.strictObject({ label: z.string().max(80).optional(), email: z.email().max(200).optional() });
const codeBody = z.strictObject({ code: z.string().trim().min(1).max(500) });

/** Интеграции и аккаунты: под кем Task Pilot работает с Jira, Claude и остальными системами. */
export function integrationsRoutes(app: FastifyInstance, d: ServerDeps): void {
  app.get('/api/account', async (): Promise<AccountDto> => d.redact.deep(await d.integrations.account()));
  // Интеграции: токены приходят только в теле запроса и в ответы не попадают, ответы еще и маскируются.
  app.get('/api/integrations', async (): Promise<IntegrationsDto> => d.redact.deep(await d.integrations.list()));
  app.post<{ Params: IdParams }>('/api/integrations/:id/check', async (req): Promise<IntegrationDto> => d.redact.deep(await d.integrations.check(req.params.id)));
  app.post<{ Params: IdParams }>('/api/integrations/:id/accounts', async (req): Promise<IntegrationDto> => {
    const body = tokenBody.parse(req.body);
    return d.redact.deep(await d.integrations.addToken(req.params.id, body));
  });
  app.patch<{ Params: IdParams }>('/api/integrations/:id', async (req): Promise<IntegrationDto> =>
    d.redact.deep(await d.integrations.activate(req.params.id, activeBody.parse(req.body).active)),
  );
  app.delete<{ Params: { id: string; account: string } }>('/api/integrations/:id/accounts/:account', async (req): Promise<IntegrationDto> =>
    d.redact.deep(await d.integrations.remove(req.params.id, req.params.account)),
  );
  // Вход в Claude через браузер: CLI открывает браузер сам, код со страницы входа нужен, только если он не вернулся.
  app.post('/api/integrations/claude/logins', async (req): Promise<IntegrationDto> => d.redact.deep(await d.integrations.startClaudeLogin(loginBody.parse(req.body ?? {}))));
  app.post<{ Params: IdParams }>('/api/integrations/claude/logins/:id/code', async (req) => {
    d.integrations.claudeLoginCode(req.params.id, codeBody.parse(req.body).code);
    return { ok: true };
  });
  app.delete<{ Params: IdParams }>('/api/integrations/claude/logins/:id', async (req) => {
    d.integrations.cancelClaudeLogin(req.params.id);
    return { ok: true };
  });
}
