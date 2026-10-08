import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { monitorProfileSchema, type AgentRequest, type AgentResult, type MonitorProfile } from '@task-pilot/step-kit';
import type { ToolTarget } from '../src/agent/service.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { EditService, editPrompt } from '../src/monitor/edits.ts';
import { createMonitorPort } from '../src/monitor/port.ts';
import { Store } from '../src/store/db.ts';

const PROFILE: MonitorProfile = monitorProfileSchema.parse({
  source: { id: 'es-prod', mcp: 'elasticsearch' },
  services: [{ id: 'keycloak', title: 'Keycloak', index: 'kc-*', container: 'gate', fields: { message: 'message', level: 'level', logger: 'l.keyword', version: 'v.keyword', pod: 'p.keyword' } }],
});

const RBA = { id: 'rba', title: 'RBA', task: 'TEAM-2609', service: 'keycloak', panels: [{ id: 'success', title: 'Успешные проверки', type: 'timeseries', match: ['Проверка антифрода RBA'] }] };
const WITH_RED = { ...RBA, panels: [...RBA.panels, { id: 'red', title: 'Красная зона', type: 'stat', match: ['помечена на имитацию'] }] };

/** Агент правок теста: ответ по заданию, запоминает задания и сессии; cost - расход каждого запуска. */
function agentsOf(answer: (req: AgentRequest, n: number) => { source: string; summary: string } | Error, cost = 0.1) {
  const calls: { target: ToolTarget; req: AgentRequest }[] = [];
  return {
    calls,
    forTool: (target: ToolTarget) => ({
      run: async (req: AgentRequest): Promise<AgentResult> => {
        calls.push({ target, req });
        target.onCost(cost);
        const out = answer(req, calls.length);
        if (out instanceof Error) throw out;
        return { sessionId: 'sess-1', text: '', output: out, costUsd: cost, durationMs: 1, turns: 1, denials: [] };
      },
    }),
  };
}

function setup(answer: Parameters<typeof agentsOf>[0] = () => ({ source: stringify(WITH_RED), summary: 'Добавлена панель красной зоны' })) {
  const team = mkdtempSync(join(tmpdir(), 'tp-edits-'));
  mkdirSync(join(team, 'dashboards', 'rba'), { recursive: true });
  const file = join(team, 'dashboards', 'rba', 'dashboard.yaml');
  writeFileSync(file, `# Дашборд RBA\n${stringify(RBA)}`);
  const port = createMonitorPort({ profile: PROFILE, dir: join(team, 'dashboards'), features: join(team, 'features'), attempt: join(team, 'attempt.yaml'), logs: { unavailable: 'нет' } });
  const store = new Store(':memory:');
  const agents = agentsOf(answer);
  const previews: unknown[] = [];
  const edits = new EditService({
    port,
    store,
    agents,
    redact: createRedactor([]),
    monitor: { preview: async (d, period) => (previews.push({ d, period }), { dashboard: d } as never) },
    root: '/pilot',
    teamDir: team,
  });
  return { team, file, port, store, agents, edits, previews };
}

describe('edit of the monitoring on request', () => {
  it('asks the agent with the file, the formats, the services and the request with phones masked, and keeps a checked draft', async () => {
    const t = setup();
    const e = t.edits.request('dashboard:rba', 'Добавь панель красной зоны, как у клиента +7 (916) 123-45-67');
    expect(e.status).toBe('working');
    await t.edits.settled();
    const list = t.edits.list('dashboard:rba');
    expect(list).toMatchObject({ label: 'дашборд "RBA"', file: 'dashboards/rba/dashboard.yaml', edit: { status: 'ready', summary: 'Добавлена панель красной зоны', errors: [] } });
    expect(list.edit!.messages.map((m) => [m.role, m.text])).toEqual([
      ['owner', 'Добавь панель красной зоны, как у клиента +7 9** ***-**-67'],
      ['agent', 'Добавлена панель красной зоны'],
    ]);
    const { target, req } = t.agents.calls[0]!;
    expect(target).toMatchObject({ tool: 'monitor.edit' });
    expect(req).toMatchObject({ cwd: t.team, tools: ['Read', 'Grep', 'Glob'], writeCwd: false });
    expect(req.prompt).toContain('файл dashboards/rba/dashboard.yaml пакета команды');
    expect(req.prompt).toContain('- /pilot/docs/dashboards.md');
    expect(req.prompt).toContain('- keycloak - Keycloak');
    expect(req.prompt).toContain('- id в файле остается rba.');
    expect(req.prompt).toContain('# Дашборд RBA');
    expect(req.prompt).toContain('+7 9** ***-**-67');
    expect(req.prompt).not.toContain('123-45-67');
    // Телефон не лег в базу и открытым текстом.
    expect(JSON.stringify(t.store.getMonitorEdit(e.id))).not.toContain('123-45-67');
    // Расход агента правки входит в общий расход агентов.
    expect(t.store.agentSpendSince('2000-01-01T00:00:00.000Z')).toBeCloseTo(0.1);
  });

  it('gives the agent the errors of a draft once in the same session and marks the edit invalid when they stay', async () => {
    const t = setup(() => ({ source: stringify({ ...RBA, id: 'other' }), summary: 'Переименован' }));
    t.edits.request('dashboard:rba', 'Переименуй дашборд');
    await t.edits.settled();
    const e = t.edits.list('dashboard:rba').edit!;
    expect(e.status).toBe('invalid');
    expect(e.errors).toEqual(['id дашборда менять нельзя: было rba, стало other']);
    expect(t.agents.calls.map((c) => c.req.resume ?? null)).toEqual([null, 'sess-1']);
    expect(t.agents.calls[1]!.req.prompt).toContain('- id дашборда менять нельзя: было rba, стало other');
    // Следующая просьба продолжает ту же правку и получает ошибки прошлого черновика.
    t.edits.request('dashboard:rba', 'Тогда оставь id');
    await t.edits.settled();
    expect(t.agents.calls[2]!.req.prompt).toContain('Прошлый текст не прошел проверку схемой');
    expect(t.edits.list('dashboard:rba').edit!.messages.filter((m) => m.role === 'owner')).toHaveLength(2);
  });

  it('applies a ready edit: the old text becomes a version and the draft is written; a file changed meanwhile stays', async () => {
    const t = setup();
    const before = readFileSync(t.file, 'utf8');
    const e = t.edits.request('dashboard:rba', 'Добавь панель красной зоны');
    await t.edits.settled();
    const after = await t.edits.apply(e.id);
    expect(readFileSync(t.file, 'utf8')).toBe(stringify(WITH_RED));
    expect(after.edit).toBeNull();
    expect(after.versions.map((v) => [v.source, v.note])).toEqual([[before, 'до правки: Добавлена панель красной зоны']]);
    expect(t.port.dashboards().dashboards[0]!.panels.map((p) => p.id)).toEqual(['success', 'red']);

    const next = t.edits.request('dashboard:rba', 'Убери панель красной зоны');
    await t.edits.settled();
    writeFileSync(t.file, `# поправлено руками\n${stringify(WITH_RED)}`);
    await expect(t.edits.apply(next.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Файл изменился') });
  });

  it('returns a version: the current text becomes a version too and the open edit is discarded', async () => {
    const t = setup();
    const before = readFileSync(t.file, 'utf8');
    const e = t.edits.request('dashboard:rba', 'Добавь панель');
    await t.edits.settled();
    const applied = await t.edits.apply(e.id);
    t.edits.request('dashboard:rba', 'И еще одну');
    await t.edits.settled();
    const back = await t.edits.revert(applied.versions[0]!.id);
    expect(readFileSync(t.file, 'utf8')).toBe(before);
    expect(back.edit).toBeNull();
    expect(back.versions.map((v) => v.note)).toEqual(['до возврата версии', 'до правки: Добавлена панель красной зоны']);
  });

  it('refuses a second request while the agent works, an empty request, an unknown target and a missing file', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup();
    const slow = new EditService({
      port: t.port,
      store: t.store,
      agents: {
        forTool: () => ({
          run: async () => {
            await gate;
            return { sessionId: 's', text: '', output: { source: stringify(WITH_RED), summary: 'ok' }, costUsd: 0, durationMs: 1, turns: 1, denials: [] };
          },
        }),
      },
      redact: createRedactor([]),
      monitor: { preview: async () => ({}) as never },
      root: '/pilot',
      teamDir: t.team,
    });
    slow.request('dashboard:rba', 'Добавь панель');
    expect(() => slow.request('dashboard:rba', 'И еще')).toThrow('Агент еще готовит прошлую правку');
    release();
    await slow.settled();
    expect(() => t.edits.request('dashboard:rba', '   ')).toThrow('Напишите, что поменять');
    expect(() => t.edits.request('panel:x', 'a')).toThrow('Цель правки');
    expect(() => t.edits.request('feature:nope', 'a')).toThrow('Файла features/nope.yaml в пакете команды нет');
  });

  it('closes the edit with the error of the agent and previews a draft of a dashboard with its panel data', async () => {
    const failing = setup(() => new Error('лимит расхода исчерпан'));
    failing.edits.request('dashboard:rba', 'Добавь панель');
    await failing.edits.settled();
    expect(failing.edits.list('dashboard:rba').edit).toMatchObject({ status: 'failed', messages: [{ role: 'owner' }, { role: 'agent', text: 'Агент не подготовил правку: лимит расхода исчерпан' }] });

    const t = setup();
    const e = t.edits.request('dashboard:rba', 'Добавь панель');
    await t.edits.settled();
    expect(await t.edits.preview(e.id, { period: '24h' })).toMatchObject({ kind: 'dashboard', data: { dashboard: { id: 'rba' } } });
    expect(t.previews).toMatchObject([{ period: '24h', d: { panels: [{ id: 'success' }, { id: 'red' }] } }]);
  });

  it('builds the task of the agent for a feature and the path without an id rule for the path', () => {
    const prompt = editPrompt({ target: { kind: 'attempt' }, label: 'путь попытки', file: 'attempt.yaml', source: 'title: x\n', messages: [{ role: 'owner', text: 'скрой строки трекера' }], errors: [], services: [{ id: 'keycloak', title: 'Keycloak' }], docs: ['/pilot/docs/monitor.md'] });
    expect(prompt).toContain('профиль пути одной попытки входа');
    expect(prompt).not.toContain('id в файле остается');
    expect(prompt).toContain('Владелец: скрой строки трекера');
  });
});
