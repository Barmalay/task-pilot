import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRequest, Issue, Ports, WikiPage, WikiPublished } from '../../packages/step-kit/src/index.ts';
import { memoryWiki } from '../../apps/server/src/demo/wiki.ts';
import { fakeAgent, TEST_TEAM, testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

const KEY = 'TEAM-8';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ISSUE = { key: KEY, summary: 'Обмен паспортного токена', status: 'MERGED', url: 'https://jira.example.org/browse/TEAM-8', labels: [], components: [], sprint: null, assignee: null, description: '' } as Issue;

const PAGE = ['# Обмен паспортного токена', '', 'Шаг `passport-token` проверяет подпись.', '', '## Ошибки', '', 'Ответ 401 без токена.'].join('\n');

interface Answer {
  text?: string;
  pageId?: string | null;
  title?: string;
  space?: string;
  parentId?: string | null;
}

function setup(opts: { answer?: Answer; pages?: WikiPage[]; values?: Record<string, unknown>; names?: string[]; params?: Record<string, unknown>; team?: typeof TEST_TEAM } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wiki-update-')));
  roots.push(root);
  const wiki = memoryWiki();
  for (const p of opts.pages ?? []) wiki.pages.set(p.id, { ...p });
  const updates: string[] = [];
  const updatePage = wiki.updatePage.bind(wiki);
  wiki.updatePage = async (input) => {
    updates.push(input.comment);
    return updatePage(input);
  };
  const repo = testRepo(join(root, 'repo'), join(root, 'wt'));
  let c: ReturnType<typeof testContext>;
  const answer = { text: PAGE, pageId: null, title: 'Обмен паспортного токена', space: 'TEAM', parentId: null, ...opts.answer };
  const agent = fakeAgent((req: AgentRequest) => {
    if (answer.text !== undefined) writeFileSync(join(c.paths.agentDocs, 'wiki.md'), answer.text);
    return { sessionId: req.resume ?? 's-1', output: { pageId: answer.pageId, title: answer.title, space: answer.space, parentId: answer.parentId, summary: 'Описан обмен токена' } };
  });
  const pilot = { root: '/pilot', skillsDir: '/pilot/plugin/skills' } as Ports['pilot'];
  c = testContext({ issueKey: KEY, repo, ports: { wiki, pilot }, agent: agent.agent, params: opts.params ?? { space: 'TEAM' }, values: { issue: ISSUE, ...opts.values }, lint: { names: opts.names ?? [], style: { yo: true, dash: true, quotes: true } }, ...(opts.team ? { team: opts.team } : {}) });
  return { c, agent, wiki, updates, root };
}

/** Как движок: черновик из prepare, затем превью и выполнение в новом контексте с тем же черновиком. */
async function draft(t: ReturnType<typeof setup>) {
  t.c.draft = await step.prepare!(t.c);
  t.c.scratch.clear();
  return step.preview!(t.c);
}

const page = (over: Partial<WikiPage> = {}): WikiPage => ({
  id: '640001',
  title: 'Обмен паспортного токена',
  space: 'TEAM',
  version: 3,
  url: 'https://wiki.example.org/pages/viewpage.action?pageId=640001',
  markdown: ['# Обмен паспортного токена', '', 'Шаг проверяет подпись.', '', '## Ошибки', '', 'Ответ 401 без токена.'].join('\n'),
  ...over,
});

describe('wiki.update', () => {
  it('takes the wiki skill and, when the setting is empty, the space of the team from its team.yaml', async () => {
    const t = setup({ params: { space: '' }, team: { ...TEST_TEAM, wikiSkill: '/team/plugin/skills/wiki-pages', wikiSpace: 'TEAM' } });
    await draft(t);
    const req = t.agent.requests[0]!;
    expect(req.prompt).toContain('/team/plugin/skills/wiki-pages/SKILL.md');
    expect(req.prompt).toContain('в пространстве TEAM');
  });

  it('refuses to prepare a page without a space in the setting and in team.yaml or without a wiki skill of the team', async () => {
    await expect(step.prepare!(setup({ params: {} }).c)).rejects.toThrow('Пространство вики для новой страницы не задано');
    await expect(step.prepare!(setup({ team: { ...TEST_TEAM, wikiSkill: null } }).c)).rejects.toThrow('нет скилла страницы вики: задайте wiki.skill в team.yaml');
  });

  it('asks the agent for the page by the wiki-analysis skill with read-only access and writes only into the docs', async () => {
    const t = setup();
    await draft(t);
    const req = t.agent.requests[0]!;
    expect(req.prompt).toContain('/pilot/plugin/skills/wiki-analysis/SKILL.md');
    expect(req.prompt).toContain(`в пространстве TEAM`);
    expect(req.prompt).toContain(join(t.c.paths.agentDocs, 'wiki.md'));
    expect(req).toMatchObject({ label: 'страница вики', writeCwd: false, writeDirs: [t.c.paths.agentDocs], mcp: ['atlassian'] });
    expect(req.allow).toEqual(expect.arrayContaining(['mcp__atlassian__confluence_search', 'mcp__atlassian__confluence_get_page']));
    expect(req.allow?.some((a) => /create|update/.test(a))).toBe(false);
    expect(readFileSync(join(t.c.paths.docs, 'wiki.md'), 'utf8')).toBe(PAGE);
  });

  it('creates a new page after the approval and is done while the text stays the same', async () => {
    const t = setup();
    const preview = await draft(t);
    expect(preview.actions).toEqual(['Создать страницу "Обмен паспортного токена" в пространстве TEAM в корне']);
    expect(preview.texts?.map((x) => [x.id, x.publish, x.stepLinted, x.format])).toEqual([['page', true, true, 'markdown']]);
    const out = (await step.run(t.c)) as { wikiPage: WikiPublished };
    expect(out.wikiPage).toMatchObject({ id: '7001', title: 'Обмен паспортного токена' });
    expect(t.wiki.pages.get('7001')).toMatchObject({ space: 'TEAM', markdown: PAGE, version: 1 });
    const again = setup({ values: { wikiPage: out.wikiPage } });
    mkdirSync(again.c.paths.docs, { recursive: true });
    writeFileSync(join(again.c.paths.docs, 'wiki.md'), PAGE);
    expect(await step.done!(again.c)).toEqual({ note: `Страница уже опубликована: ${out.wikiPage.url}` });
    writeFileSync(join(again.c.paths.docs, 'wiki.md'), `${PAGE}\n\nНовый раздел.`);
    expect(await step.done!(again.c)).toBeNull();
  });

  it('updates the page the agent chose, shows the diff with the current version and puts the version into the approval', async () => {
    const t = setup({ answer: { pageId: '640001' }, pages: [page()] });
    const preview = await draft(t);
    expect(preview.actions).toEqual(['Обновить страницу "Обмен паспортного токена" (https://wiki.example.org/pages/viewpage.action?pageId=640001): версия 3 → 4']);
    expect(preview.texts?.find((x) => x.id === 'diff')).toMatchObject({ publish: false, text: expect.stringContaining('- Шаг проверяет подпись.\n+ Шаг `passport-token` проверяет подпись.') });
    expect(preview.warnings?.[0]).toContain('перезаписывает тело страницы целиком');
    expect(preview.payload).toMatchObject({ pageId: '640001', version: 3 });

    // Кто-то правит страницу после показа: новая версия меняет содержимое подтверждения, и старое сгорает.
    t.wiki.pages.set('640001', { ...page(), version: 4, markdown: `${page().markdown}\n\nЧужая правка.` });
    t.c.scratch.clear();
    const fresh = await step.preview!(t.c);
    expect(fresh.payload).toMatchObject({ version: 4 });
    expect(fresh.texts?.find((x) => x.id === 'diff')?.text).toContain('- Чужая правка.');

    await step.run(t.c);
    expect(t.wiki.pages.get('640001')).toMatchObject({ version: 5, markdown: PAGE });
    expect(t.updates).toEqual(['TEAM-8: Описан обмен токена']);
  });

  it('updates a page with the same title instead of creating a duplicate, and shows a rename', async () => {
    const same = setup({ pages: [page()] });
    expect((await draft(same)).actions[0]).toMatch(/^Обновить страницу "Обмен паспортного токена"/);
    const renamed = setup({ answer: { pageId: '640001', title: 'Обмен паспортного JWT' }, pages: [page()] });
    expect((await draft(renamed)).actions[0]).toMatch(/версия 3 → 4, новый заголовок "Обмен паспортного JWT"$/);
  });

  it('fixes the prose by the text rules but keeps literal quotes in backticks', async () => {
    const t = setup({ answer: { text: 'Пользователь увидит ошибку — «Введён неверный код», текст в коде: `«Введён неверный код»`.' } });
    const preview = await draft(t);
    expect(preview.texts?.[0]?.text).toBe('Пользователь увидит ошибку - "Введен неверный код", текст в коде: `«Введён неверный код»`.');
    expect(preview.lint?.map((i) => i.message)).toEqual(expect.arrayContaining(['Страница: буква е с точками заменена на е']));
  });

  it('keeps the lines of the current page it did not change as they are and checks only new and changed lines', async () => {
    const quote = 'Текст ошибки: «Введён неверный код», ответственный - Петров.';
    const current = page({ markdown: ['# Обмен паспортного токена', '', quote, '', 'Старый абзац.'].join('\n') });
    const clean = setup({ answer: { pageId: '640001', text: ['# Обмен паспортного токена', '', quote, '', 'Новый абзац — о метриках.'].join('\n') }, pages: [current], names: ['Петров'] });
    const preview = await draft(clean);
    expect(preview.texts?.[0]?.text).toBe(['# Обмен паспортного токена', '', quote, '', 'Новый абзац - о метриках.'].join('\n'));
    expect(preview.lint?.map((i) => [i.severity, i.message])).toEqual([['fixed', 'Страница: длинное тире заменено дефисом']]);

    const named = setup({ answer: { pageId: '640001', text: ['# Обмен паспортного токена', '', quote, '', 'Согласовано с Петровым.'].join('\n') }, pages: [current], names: ['Петров'] });
    expect((await draft(named)).lint).toEqual([expect.objectContaining({ rule: 'name', severity: 'block' })]);
  });

  it('reworks the page by the owner remark in the same agent session', async () => {
    const t = setup();
    t.c.draft = await step.prepare!(t.c);
    t.c.feedback = 'Добавь раздел про метрики';
    await step.prepare!(t.c);
    const req = t.agent.requests[1]!;
    expect(req.resume).toBe('s-1');
    expect(req.prompt).toContain('Добавь раздел про метрики');
    expect(req.prompt).toContain(join(t.c.paths.agentDocs, 'wiki.md'));
  });

  it('fails when the agent wrote no page or gave it no title', async () => {
    await expect(step.prepare!(setup({ answer: { text: undefined } }).c)).rejects.toThrow('Агент не записал страницу');
    await expect(step.prepare!(setup({ answer: { title: ' ' } }).c)).rejects.toThrow('Агент не назвал страницу');
  });
});
