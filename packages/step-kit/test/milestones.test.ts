import { describe, expect, it } from 'vitest';
import { boardStatuses, findTransition, normalizeName, planMilestone, walkTransitions } from '../src/milestones.ts';
import type { JiraPort } from '../src/types.ts';
import { jiraConfigSchema } from '../src/profiles.ts';

const board = {
  path: [
    { from: 'Open', id: '4', name: 'Start Progress', to: 'In Progress' },
    { from: 'In Progress', id: '971', name: 'Готово к ревью', to: 'Ready to Review' },
    { from: 'Ready to Review', id: '1091', name: 'Можно тестировать', to: 'To Testing' },
    { from: 'To Testing', id: '751', name: 'Взять в тестирование', to: 'In Testing' },
    { from: 'In Testing', id: '721', name: 'Все хорошо!', to: 'Resolved' },
    { from: 'Resolved', id: '1011', name: 'Смержено', to: 'MERGED' },
  ],
  after: ['Monitoring'],
};

describe('boardStatuses', () => {
  it('lists statuses of the main path in order including statuses after its end', () => {
    expect(boardStatuses(board)).toEqual(['Open', 'In Progress', 'Ready to Review', 'To Testing', 'In Testing', 'Resolved', 'MERGED', 'Monitoring']);
  });
});

describe('planMilestone', () => {
  it('plans a single transition from Open to In Progress', () => {
    const plan = planMilestone('Open', 'In Progress', board);
    expect(plan).toEqual({ kind: 'transitions', steps: [board.path[0]] });
  });

  it('plans the whole chain from Ready to Review to MERGED', () => {
    const plan = planMilestone('Ready to Review', 'MERGED', board);
    expect(plan.kind).toBe('transitions');
    if (plan.kind === 'transitions') expect(plan.steps.map((s) => s.id)).toEqual(['1091', '751', '721', '1011']);
  });

  it('treats a milestone as reached when the issue is already on it', () => {
    expect(planMilestone('In Progress', 'In Progress', board)).toEqual({ kind: 'done', status: 'In Progress' });
  });

  it('never moves an issue backwards when it is already past the milestone', () => {
    expect(planMilestone('Ready to Review', 'In Progress', board).kind).toBe('done');
  });

  it('blocks when the issue status is outside the main path', () => {
    const plan = planMilestone('Waiting', 'In Progress', board);
    expect(plan.kind).toBe('blocked');
  });

  it('blocks when the target status is unknown', () => {
    expect(planMilestone('Open', 'Deployed', board).kind).toBe('blocked');
  });

  it('matches statuses regardless of case and extra spaces', () => {
    expect(planMilestone('  open ', 'in progress', board).kind).toBe('transitions');
  });
});

describe('normalizeName', () => {
  it('ignores case, the dotted e letter, guillemets and repeated spaces', () => {
    expect(normalizeName('Всё  хорошо!')).toBe(normalizeName('все хорошо!'));
    expect(normalizeName('Назад в «Готово к тестированию»')).toBe('назад в готово к тестированию');
  });
});

describe('findTransition', () => {
  const available = [
    { id: '1001', name: 'Closed' },
    { id: '1011', name: 'Смёржено' },
  ];
  const rest = [
    { id: '31', name: 'В тестирование', to: 'Testing' },
    { id: '41', name: 'Готово', to: 'Done' },
  ];

  it('prefers the transition id', () => {
    expect(findTransition(available, { id: '1011', name: 'что угодно', to: 'MERGED' })?.id).toBe('1011');
  });

  it('falls back to the normalized name when the id changed', () => {
    expect(findTransition(available, { id: '9999', name: 'Смержено', to: 'MERGED' })?.id).toBe('1011');
  });

  it('finds the transition by the status it leads to when the board names neither its id nor its name', () => {
    expect(findTransition(rest, { to: 'done' })?.id).toBe('41');
    expect(findTransition(rest, { id: '9999', name: 'Нет такого', to: 'Testing' })?.id).toBe('31');
    // Без статуса в ответе (mcp-atlassian) перехода по цели не найти.
    expect(findTransition(available, { to: 'MERGED' })).toBeUndefined();
  });

  it('returns undefined when the transition is not available', () => {
    expect(findTransition(available, { id: '4', name: 'Start Progress', to: 'In Progress' })).toBeUndefined();
  });
});

describe('walkTransitions', () => {
  it('walks a path that names only the statuses, finding each transition by the status it leads to', async () => {
    const flow: Record<string, { id: string; name: string; to: string }> = { Open: { id: '11', name: 'Взять', to: 'Doing' }, Doing: { id: '12', name: 'Готово', to: 'Done' } };
    let status = 'Open';
    const jira = {
      getTransitions: async () => (flow[status] ? [flow[status]] : []),
      transition: async (_key: string, id: string) => {
        status = Object.values(flow).find((t) => t.id === id)!.to;
      },
      getIssue: async () => ({ status }),
    } as unknown as JiraPort;
    const log: string[] = [];
    const path = [{ from: 'Open', to: 'Doing' }, { from: 'Doing', to: 'Done' }];
    expect(await walkTransitions(jira, 'TEAM-1', 'Open', path, (m) => log.push(m))).toBe('Done');
    expect(log).toEqual(['Open → Doing', 'Doing → Done']);
    await expect(walkTransitions(jira, 'TEAM-1', 'Done', [{ from: 'Done', to: 'Archived' }], () => {})).rejects.toThrow('Переход в Archived недоступен из статуса Done');
  });
});

describe('jiraConfigSchema', () => {
  const base = { baseUrl: 'https://jira.example.org', me: 'owner', myIssuesJql: 'assignee = currentUser()', path: board.path, after: board.after };

  it('accepts a contiguous path with milestones on it', () => {
    const r = jiraConfigSchema.safeParse({ ...base, milestones: { inProgress: 'In Progress', merged: 'MERGED' } });
    expect(r.success).toBe(true);
  });

  it('rejects a path with a gap', () => {
    const broken = [board.path[0], board.path[2]];
    expect(jiraConfigSchema.safeParse({ ...base, path: broken, milestones: {} }).success).toBe(false);
  });

  it('rejects a milestone that is not on the path', () => {
    expect(jiraConfigSchema.safeParse({ ...base, milestones: { deployed: 'Deployed' } }).success).toBe(false);
  });

  it('accepts an empty milestone: on such a board the step does not move the task', () => {
    const r = jiraConfigSchema.safeParse({ ...base, milestones: { inProgress: 'In Progress', testing: null } });
    expect(r.success && r.data.milestones.testing).toBeNull();
  });

  it('takes transitions without an id and a name, and boards without sprint and epic fields', () => {
    const r = jiraConfigSchema.parse({ ...base, path: [{ from: 'Open', to: 'In Progress' }], milestones: {} });
    expect(r.path).toEqual([{ from: 'Open', to: 'In Progress' }]);
    expect(r.sprintField).toBeUndefined();
    expect(r.epicField).toBeUndefined();
    expect(r.finished).toEqual([]);
  });

  it('coerces numeric transition ids from YAML to strings', () => {
    const r = jiraConfigSchema.parse({ ...base, path: [{ from: 'Open', id: 4, name: 'Start Progress', to: 'In Progress' }], milestones: {} });
    expect(r.path[0]?.id).toBe('4');
  });
});
