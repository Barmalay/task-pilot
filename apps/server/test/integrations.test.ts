import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryJiraFiles } from '../src/demo/jira-files.ts';
import { createJiraMcp, currentSprint, jiraRestOf, parseSprints, renderStats, toIssue, toIssueRef } from '../src/integrations/jira-mcp.ts';
import { parseToolResult } from '../src/integrations/mcp.ts';
import { buildTasksJql } from '../src/tasks.ts';

const OPTIONS = { baseUrl: 'https://jira.example.com', sprintField: 'customfield_10330' };

/** Ответ jira_get_issue в том виде, в каком его отдает mcp-atlassian (сокращено). */
const RAW_ISSUE = {
  key: 'TEAM-2860',
  summary: 'Добавить метрику',
  browse_url: 'https://jira.example.com/browse/TEAM-2860',
  description: '**Что:** метрика\r\n\r\n**Зачем:** мониторинг',
  status: { name: 'Open', category: 'To Do' },
  issue_type: { name: 'Задача' },
  assignee: { display_name: 'Владелец', name: 'owner' },
  labels: ['backend', 'skip_ac'],
  components: ['api'],
  customfield_10330: {
    value: [
      'com.atlassian.greenhopper.service.sprint.Sprint@1[id=4700,rapidViewId=1061,state=CLOSED,name=Sprint 07.09.26 - 20.09.26,startDate=2026-09-07T00:00:00.000+03:00]',
      'com.atlassian.greenhopper.service.sprint.Sprint@2[id=4911,rapidViewId=1061,state=ACTIVE,name=Sprint 21.09.26 - 04.10.26,startDate=2026-09-21T00:00:00.000+03:00,goal=,synced=false]',
    ],
  },
  updated: '2026-09-22 11:48:21 MSK',
};

describe('parseToolResult', () => {
  it('unwraps JSON stored as a string in structuredContent.result', () => {
    expect(parseToolResult({ structuredContent: { result: '[{"id": 4, "name": "Start Progress"}]' } })).toEqual([{ id: 4, name: 'Start Progress' }]);
  });

  it('falls back to the text content and unwraps a nested result string', () => {
    expect(parseToolResult({ content: [{ type: 'text', text: '{"result": "{\\"total\\": 1}"}' }] })).toEqual({ total: 1 });
  });

  it('returns plain text when the content is not JSON', () => {
    expect(parseToolResult({ content: [{ type: 'text', text: 'ok' }] })).toBe('ok');
  });
});

describe('sprints', () => {
  it('parses gh-sprint strings from Jira Server', () => {
    expect(parseSprints(RAW_ISSUE.customfield_10330)).toEqual([
      { id: 4700, name: 'Sprint 07.09.26 - 20.09.26', state: 'closed' },
      { id: 4911, name: 'Sprint 21.09.26 - 04.10.26', state: 'active' },
    ]);
  });

  it('takes the active sprint as current and understands sprint objects', () => {
    expect(currentSprint(parseSprints(RAW_ISSUE.customfield_10330))?.id).toBe(4911);
    expect(parseSprints([{ id: '12', name: 'Грумминг', state: 'FUTURE' }])).toEqual([{ id: 12, name: 'Грумминг', state: 'future' }]);
    expect(currentSprint(parseSprints(null))).toBeNull();
  });
});

describe('buildTasksJql', () => {
  it('uses the profile filter without a sprint', () => {
    expect(buildTasksJql({ kind: 'mine' }, 'assignee = currentUser()')).toBe('assignee = currentUser()');
  });

  it('filters a sprint by owner and hides done issues on request', () => {
    expect(buildTasksJql({ kind: 'sprint', sprintId: 4911, mine: true, hideDone: true }, 'x')).toBe(
      'sprint = 4911 AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    );
    expect(buildTasksJql({ kind: 'sprint', sprintId: 4911, mine: false, hideDone: false }, 'x')).toBe('sprint = 4911 ORDER BY updated DESC');
  });

  it('refuses a sprint id that is not a positive integer', () => {
    expect(() => buildTasksJql({ kind: 'sprint', sprintId: Number.NaN, mine: true, hideDone: true }, 'x')).toThrow('спринт');
  });
});

describe('Jira over MCP', () => {
  it('maps the mcp-atlassian issue format with labels, components and the current sprint', () => {
    expect(toIssue(RAW_ISSUE, OPTIONS)).toEqual({
      key: 'TEAM-2860',
      summary: 'Добавить метрику',
      status: 'Open',
      type: 'Задача',
      updated: '2026-09-22 11:48:21 MSK',
      url: 'https://jira.example.com/browse/TEAM-2860',
      labels: ['backend', 'skip_ac'],
      components: ['api'],
      sprint: { id: 4911, name: 'Sprint 21.09.26 - 04.10.26', state: 'active' },
      assignee: { name: 'owner', displayName: 'Владелец' },
      description: '**Что:** метрика\n\n**Зачем:** мониторинг',
    });
  });

  it('calls the right tools with the right arguments', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const jira = createJiraMcp(async (tool, args) => {
      calls.push([tool, args]);
      if (tool === 'jira_get_transitions') return [{ id: 4, name: 'Start Progress' }];
      if (tool === 'jira_get_issue') return RAW_ISSUE;
      if (tool === 'jira_search') return { issues: [RAW_ISSUE] };
      if (tool === 'jira_get_sprints_from_board') return [{ id: '4911', name: 'Спринт', state: 'active' }];
      return {};
    }, OPTIONS);
    expect(await jira.getTransitions('TEAM-2860')).toEqual([{ id: '4', name: 'Start Progress' }]);
    expect((await jira.search('assignee = currentUser()', 5))[0]).toMatchObject({ status: 'Open', components: ['api'], assignee: { name: 'owner', displayName: 'Владелец' } });
    await jira.transition('TEAM-2860', '4');
    await jira.assign('TEAM-2860', 'owner');
    expect(await jira.sprints(1061, 'active')).toEqual([{ id: 4911, name: 'Спринт', state: 'active' }]);
    expect(calls.map(([tool]) => tool)).toEqual(['jira_get_transitions', 'jira_search', 'jira_transition_issue', 'jira_assign_issue', 'jira_get_sprints_from_board']);
    expect(String(calls[1]?.[1].fields).split(',')).toEqual(expect.arrayContaining(['assignee', 'customfield_10330']));
    expect(calls[2]?.[1]).toEqual({ issue_key: 'TEAM-2860', transition_id: '4' });
    expect(calls[4]?.[1]).toEqual({ board_id: '1061', state: 'active', limit: 20 });
  });

  it('keeps only the id, author and time of the comments and reads them with the task', async () => {
    const raw = { ...RAW_ISSUE, comments: [{ id: 3543313, body: 'Итоги прогона', author: { name: 'a.owner', display_name: 'Владелец' }, created: '2026-09-21T18:17:39.200+0300' }] };
    expect(toIssue(raw, OPTIONS).comments).toEqual([{ id: '3543313', author: 'a.owner', created: '2026-09-21T18:17:39.200+0300' }]);
    expect(toIssue(RAW_ISSUE, OPTIONS)).not.toHaveProperty('comments');
    const calls: Record<string, unknown>[] = [];
    const jira = createJiraMcp(async (_tool, args) => {
      calls.push(args);
      return raw;
    }, OPTIONS);
    await jira.getIssue('TEAM-2860');
    expect(calls[0]).toMatchObject({ comment_limit: 100, update_history: false });
    expect(String(calls[0]?.fields).split(',')).toEqual(expect.arrayContaining(['description', 'comment']));
  });

  it('reads no sprint and asks for no sprint field when the board names none', async () => {
    const calls: Record<string, unknown>[] = [];
    const jira = createJiraMcp(async (_tool, args) => (calls.push(args), { issues: [RAW_ISSUE] }), { baseUrl: 'https://jira.example.org' });
    const [card] = await jira.search('project = TEAM', 5);
    expect(card?.sprint).toBeNull();
    expect(String(calls[0]?.fields)).toBe('summary,status,issuetype,updated,labels,components,assignee');
  });

  it('gives a task card without an assignee a null assignee', () => {
    expect(toIssueRef({ ...RAW_ISSUE, assignee: null }, OPTIONS).assignee).toBeNull();
  });

  it('fails clearly when the issue does not exist', async () => {
    const jira = createJiraMcp(async () => ({}), OPTIONS);
    await expect(jira.getIssue('TEAM-1')).rejects.toThrow('не найдена');
  });
});

describe('Jira transitions over REST', () => {
  const REST = { url: 'https://jira.example.com', token: 'pat-token-value' };
  afterEach(() => vi.restoreAllMocks());

  it('takes REST settings from the atlassian MCP server and needs both the address and the personal token', () => {
    expect(jiraRestOf({ env: { JIRA_URL: 'https://jira.example.com/', JIRA_PERSONAL_TOKEN: 't' } })).toEqual({ url: 'https://jira.example.com', token: 't' });
    expect(jiraRestOf({ env: { JIRA_URL: 'https://jira.example.com' } })).toBeNull();
    expect(jiraRestOf(undefined)).toBeNull();
  });

  it('reads the transitions with their target statuses from REST without calling mcp-atlassian', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ transitions: [{ id: '991', name: 'Хочу починить', to: { name: 'In Progress' } }, { id: '1001', name: 'Closed', to: {} }] }),
    );
    const calls: string[] = [];
    const jira = createJiraMcp(async (tool) => (calls.push(tool), []), { ...OPTIONS, rest: REST });
    expect(await jira.getTransitions('TEAM-2799')).toEqual([
      { id: '991', name: 'Хочу починить', to: 'In Progress' },
      { id: '1001', name: 'Closed' },
    ]);
    expect(calls).toEqual([]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://jira.example.com/rest/api/2/issue/TEAM-2799/transitions');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer pat-token-value');
  });

  it('reads REST with the token that is current at the call: the Jira token can change on the integrations screen', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ transitions: [] }));
    let rest: { url: string; token: string } | null = REST;
    const jira = createJiraMcp(async () => [], { ...OPTIONS, rest: () => rest });
    await jira.getTransitions('TEAM-1');
    rest = { url: 'https://jira.example.com', token: 'tech-token-value' };
    await jira.getTransitions('TEAM-1');
    expect(fetch.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization)).toEqual(['Bearer pat-token-value', 'Bearer tech-token-value']);
    rest = null;
    await expect(jira.attachments('TEAM-1')).rejects.toThrow('нужен REST Jira');
  });

  it('falls back to mcp-atlassian when REST fails and warns about it once', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const jira = createJiraMcp(async () => [{ id: 4, name: 'Start Progress' }], { ...OPTIONS, rest: REST });
    expect(await jira.getTransitions('TEAM-2860')).toEqual([{ id: '4', name: 'Start Progress' }]);
    await jira.getTransitions('TEAM-2860');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('REST Jira ответил 401');
  });
});

describe('Jira attachments and comments over REST', () => {
  const REST = { url: 'https://jira.example.com', token: 'pat-token-value' };
  const jira = () => createJiraMcp(async () => {
    throw new Error('mcp-atlassian здесь не нужен');
  }, { ...OPTIONS, rest: REST });
  afterEach(() => vi.restoreAllMocks());

  it('lists the attachments of a task', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ fields: { attachment: [{ id: '501', filename: '01-login.png', size: 1234, created: '2026-09-23T10:00:00.000+0300' }] } }));
    expect(await jira().attachments('TEAM-7')).toEqual([{ id: '501', filename: '01-login.png', size: 1234, created: '2026-09-23T10:00:00.000+0300' }]);
    expect(fetch.mock.calls[0]![0]).toBe('https://jira.example.com/rest/api/2/issue/TEAM-7?fields=attachment');
  });

  it('uploads a file as multipart with the header Jira Server needs and deletes an attachment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pilot-attach-'));
    const file = join(dir, '02-captcha.png');
    writeFileSync(file, 'png');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json([{ id: '502', filename: '02-captcha.png', size: 3, created: 'x' }])).mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await jira().attach('TEAM-7', file)).toMatchObject({ id: '502', filename: '02-captcha.png', size: 3 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://jira.example.com/rest/api/2/issue/TEAM-7/attachments');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer pat-token-value', 'X-Atlassian-Token': 'no-check' });
    expect((init?.body as FormData).get('file')).toMatchObject({ name: '02-captcha.png', size: 3 });
    await jira().deleteAttachment('502');
    expect(fetch.mock.calls[1]![0]).toBe('https://jira.example.com/rest/api/2/attachment/502');
    expect(fetch.mock.calls[1]![1]?.method).toBe('DELETE');
  });

  it('posts a wiki comment as is, then reads back how Jira rendered it', async () => {
    const html = '<table><tr><th>AC</th></tr><tr><td><img src="a"/></td></tr><tr><td>!b.png|thumbnail!</td></tr></table>';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ id: '9001' })).mockResolvedValueOnce(Response.json({ id: '9001', renderedBody: html }));
    const body = '||AC||Факт||\n|1|!01_login.png|thumbnail!|';
    expect(await jira().comment('TEAM-7', body)).toEqual({ id: '9001', url: 'https://jira.example.com/browse/TEAM-7?focusedCommentId=9001#comment-9001', rendered: { images: 1, rows: 3, unresolved: 1 } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://jira.example.com/rest/api/2/issue/TEAM-7/comment');
    expect(init?.method).toBe('POST');
    // Подчеркивания и миниатюры уходят как есть: в REST нет конвертера Markdown, который их ломает.
    expect(JSON.parse(String(init?.body))).toEqual({ body });
    expect(fetch.mock.calls[1]![0]).toBe('https://jira.example.com/rest/api/2/issue/TEAM-7/comment/9001?expand=renderedBody');
  });

  it('updates an existing comment instead of adding another one', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ id: '9001' })).mockResolvedValueOnce(Response.json({ renderedBody: '' }));
    await jira().comment('TEAM-7', 'текст', '9001');
    expect(fetch.mock.calls[0]![0]).toBe('https://jira.example.com/rest/api/2/issue/TEAM-7/comment/9001');
    expect(fetch.mock.calls[0]![1]?.method).toBe('PUT');
  });

  it('reports a REST error with its status and asks for REST settings when there are none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"errorMessages":["нет прав"]}', { status: 403 }));
    await expect(jira().attachments('TEAM-7')).rejects.toThrow('REST Jira GET /issue/TEAM-7: 403');
    const noRest = createJiraMcp(async () => null, OPTIONS);
    await expect(noRest.comment('TEAM-7', 'x')).rejects.toThrow('нужен REST Jira');
  });

  it('counts images, table rows and unresolved markup in the rendered comment', () => {
    expect(renderStats('<tr><td><img/><img/></td></tr> [^report.md] !x.png|thumbnail!')).toEqual({ images: 2, rows: 1, unresolved: 2 });
  });
});

describe('Jira attachments and comments in memory', () => {
  it('renders only thumbnails of files attached to the task and keeps the same comment on update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pilot-attach-'));
    writeFileSync(join(dir, 'a.png'), 'png');
    const files = memoryJiraFiles();
    await files.port.attach('TEAM-7', join(dir, 'a.png'));
    const first = await files.port.comment('TEAM-7', '|1|!a.png|thumbnail! !b.png|thumbnail!|');
    expect(first.rendered).toEqual({ images: 1, rows: 1, unresolved: 1 });
    const again = await files.port.comment('TEAM-7', '|1|!a.png|thumbnail!|', first.id);
    expect(again.id).toBe(first.id);
    expect(files.comments.size).toBe(1);
  });
});
