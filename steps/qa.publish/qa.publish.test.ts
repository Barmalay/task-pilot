import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryJiraFiles } from '../../apps/server/src/demo/jira-files.ts';
import type { AcCheck, BrowserPort, Issue, JiraConfig, JiraPort, Preview, QaComment, QaReport } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, TEST_JIRA, TEST_TEAM, testContext, testRepo } from '../_test/context.ts';
import step, { acLabel, commentBody, escapeWiki, references, thumbnails } from './index.ts';

const KEY = 'TEAM-9';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Доска до In Testing: у тестовой доски шагов нет вехи testing. */
const JIRA: JiraConfig = {
  ...TEST_JIRA,
  path: [...TEST_JIRA.path, { from: 'To Testing', id: '751', name: 'Взять в тестирование', to: 'In Testing' }],
  milestones: { ...TEST_JIRA.milestones, testing: 'In Testing' },
};

const AC = ['Капча вместо SMS при фроде', 'SMS не уходит до капчи'];

const check = (ac: string, result: AcCheck['result'], files: string[]): AcCheck => ({ ac, scenario: `сценарий ${ac}`, action: 'ввод номера', expected: 'страница капчи', result, note: `факт ${ac}`, files });

function jira(status: string, description = `Критерии приемки:\n1. ${AC[0]}\n2. ${AC[1]}`, labels: string[] = []) {
  const files = memoryJiraFiles('https://jira.example.org');
  const state = { status, moves: [] as string[] };
  const port: JiraPort = {
    async search() {
      return [];
    },
    async getIssue(key): Promise<Issue> {
      return { key, summary: 'Капча перед SMS', status: state.status, url: `https://jira.example.org/browse/${key}`, labels, components: [], sprint: null, assignee: null, description };
    },
    async getTransitions() {
      return JIRA.path.filter((p) => p.from === state.status).map((p) => ({ id: p.id ?? p.to, name: p.name ?? p.to, to: p.to }));
    },
    async transition(_key, id) {
      const t = JIRA.path.find((p) => p.id === id && p.from === state.status);
      if (!t) throw new Error(`нет перехода ${id}`);
      state.moves.push(id);
      state.status = t.to;
    },
    async assign() {},
    async sprints() {
      return [];
    },
    ...files.port,
  };
  return { port, state, files };
}

const browser: BrowserPort = {
  port: 9343,
  ensure: async () => ({ started: false }),
  act: async () => '',
  kibanaLogs: async () => '',
};

function setup(opts: { status?: string; results?: AcCheck[]; shots?: string[]; report?: string | null; values?: Record<string, unknown>; description?: string; labels?: string[]; agentBody?: string; params?: Record<string, unknown>; formatSample?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-pilot-publish-')));
  roots.push(root);
  // Скилл теста на стенде команды, с образцом итогов в references или без него.
  const skill = join(root, 'skills', 'stand-qa');
  if (opts.formatSample) {
    mkdirSync(join(skill, 'references'), { recursive: true });
    writeFileSync(join(skill, 'references', 'jira-format.md'), '# Образец итогов\n');
  }
  const repoPath = join(root, 'repo');
  const artifacts = join(repoPath, '.claude', 'artifacts', KEY, 'qa');
  const docs = join(repoPath, '.claude', KEY);
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(docs, { recursive: true });
  for (const f of opts.shots ?? ['01-captcha.png', 'kibana-logs-01.png']) writeFileSync(join(artifacts, f), `png ${f}`);
  if (opts.report !== null) writeFileSync(join(docs, 'qa-report.md'), opts.report ?? '# Отчет\n\nИтог: все проверено.\n');
  const qaReport: QaReport = {
    at: '2026-09-23T11:00:00.000Z',
    stand: 'testing-5',
    build: '1.0.4-246',
    summary: 'Капча показывается при признаках фрода.',
    results: opts.results ?? [check('1', 'пройден', ['01-captcha.png']), check('2', 'пройден', ['kibana-logs-01.png'])],
    remarks: ['опечатка на странице входа'],
    guide: join(docs, 'qa-guide.md'),
    report: join(docs, 'qa-report.md'),
    artifacts,
    missing: [],
  };
  const j = jira(opts.status ?? 'To Testing', opts.description, opts.labels);
  const agent = fakeAgent(() => ({ output: { body: opts.agentBody ?? '' } }));
  const context = (draft?: unknown, feedback: string | null = null) =>
    testContext({ issueKey: KEY, repo: testRepo(repoPath, join(root, 'wt')), ports: { jira: j.port, browser }, jira: JIRA, params: opts.params, values: { qaReport, ac: AC, ...opts.values }, agent: agent.agent, draft, feedback, lint: { style: { yo: true, dash: true, quotes: true } }, team: { ...TEST_TEAM, qaSkill: skill } });
  return { root, artifacts, jira: j, agent, context, qaReport, skill };
}

/** Проход шага так, как его ведет движок: prepare, preview и после подтверждения run. */
async function publish(t: ReturnType<typeof setup>) {
  const draft = await step.prepare!(t.context());
  const gate = t.context(draft);
  const preview = await step.preview!(gate);
  const outputs = (await step.run(gate)) as { qaComment: QaComment; status: string };
  return { draft: draft as { body: string }, preview, outputs, gate };
}

describe('qa.publish', () => {
  it('uploads the evidence, publishes the AC table with thumbnails and moves the task to In Testing after one approval', async () => {
    const t = setup();
    const { draft, preview, outputs, gate } = await publish(t);
    expect(draft.body).toContain('h3. Итоги проверки на стенде testing-5 (23.09.2026)');
    expect(draft.body).toContain('||AC||Сценарий||Действие||Ожидаемый результат||Итог||Факт||');
    expect(draft.body).toContain('|1|сценарий 1|ввод номера|страница капчи|пройден|!01-captcha.png|thumbnail!|');
    expect(draft.body).toContain('Сводный отчет во вложении [^TEAM-9-qa-report.md]');
    expect(draft.body).toContain('h4. Замечания не по задаче\n* опечатка на странице входа');

    expect(preview.title).toBe('Итоги в Jira: TEAM-9');
    expect(preview.actions).toEqual([
      'Загрузить во вложения TEAM-9: 01-captcha.png, kibana-logs-01.png, TEAM-9-qa-report.md',
      'Добавить комментарий с итогами в TEAM-9',
      'Jira: To Testing → In Testing, переход "Взять в тестирование"',
    ]);
    // Комментарий в Jira - в ее разметке, отчет-вложение .md - markdown: подтверждение показывает каждый в своем виде.
    expect(preview.texts!.map((x) => [x.id, x.publish, x.format ?? null])).toEqual([
      ['comment', true, 'jira'],
      ['report', true, 'markdown'],
    ]);

    expect([...t.jira.files.attachments.values()].map((a) => a.filename).sort()).toEqual(['01-captcha.png', 'TEAM-9-qa-report.md', 'kibana-logs-01.png']);
    expect(outputs.qaComment).toMatchObject({ key: KEY, rendered: { images: 2, unresolved: 0 } });
    expect(outputs.status).toBe('In Testing');
    expect(t.jira.state.moves).toEqual(['751']);
    expect(gate.logs.find((l) => l.startsWith('Комментарий опубликован'))).toContain('миниатюр 2');
  });

  it('publishes the results but leaves the task in its status when the move is switched off in the step settings', async () => {
    const t = setup({ params: { moveTo: 'none' } });
    const { preview, outputs } = await publish(t);
    expect(preview.actions.at(-1)).toBe('Jira: задача остается в статусе To Testing, перевод по доске выключен в настройках шага');
    expect(preview.actions.some((a) => a.includes('In Testing'))).toBe(false);
    expect(outputs.status).toBe('To Testing');
    expect(t.jira.state.moves).toEqual([]);
  });

  it('skips a file Jira already has and replaces a changed one instead of piling up duplicates', async () => {
    const t = setup();
    const old = join(t.root, 'old');
    mkdirSync(old);
    writeFileSync(join(old, '01-captcha.png'), 'png 01-captcha.png');
    writeFileSync(join(old, 'kibana-logs-01.png'), 'другой кадр, старой длины');
    const same = await t.jira.port.attach(KEY, join(old, '01-captcha.png'));
    const stale = await t.jira.port.attach(KEY, join(old, 'kibana-logs-01.png'));
    const { preview } = await publish(t);
    expect(preview.actions.slice(0, 2)).toEqual(['Загрузить во вложения TEAM-9: TEAM-9-qa-report.md', 'Заменить вложения с тем же именем и другим содержимым: kibana-logs-01.png']);
    expect(preview.summary).toContain('уже во вложениях и не загружаются повторно: 01-captcha.png');
    const now = [...t.jira.files.attachments.values()];
    expect(now.filter((a) => a.filename === 'kibana-logs-01.png')).toHaveLength(1);
    expect(now.some((a) => a.id === stale.id)).toBe(false);
    expect(now.some((a) => a.id === same.id)).toBe(true);
  });

  it('updates the comment it published earlier in this run', async () => {
    const t = setup({ status: 'In Testing' });
    const first = await publish(t);
    // Вторая публикация в том же прогоне: в контексте уже есть комментарий, вложения те же.
    const ctx = testContext({ issueKey: KEY, repo: testRepo(join(t.root, 'repo'), join(t.root, 'wt')), ports: { jira: t.jira.port, browser }, jira: JIRA, values: { qaReport: t.qaReport, ac: AC, qaComment: first.outputs.qaComment }, draft: first.draft });
    const preview = await step.preview!(ctx);
    expect(preview.actions).toEqual([`Обновить комментарий с итогами: ${first.outputs.qaComment.url}`]);
    const out = (await step.run(ctx)) as { qaComment: QaComment };
    expect(out.qaComment.id).toBe(first.outputs.qaComment.id);
    expect(t.jira.files.comments.size).toBe(1);
  });

  it('refuses to publish without the evidence files and a text that points at files that will not be attached', async () => {
    const lost = setup({ results: [check('1', 'пройден', ['01-captcha.png', '09-lost.png'])] });
    const draft = await step.prepare!(lost.context());
    await expect(step.preview!(lost.context(draft))).rejects.toThrow('Нет файлов доказательств из отчета: 09-lost.png');
    const t = setup();
    await expect(step.preview!(t.context({ body: '|1|!03-other.png|thumbnail!|', sessionId: null, fixed: [] }))).rejects.toThrow('Текст ссылается на файлы, которых не будет во вложениях: 03-other.png');
  });

  it('reworks the text with the agent on the owner remark and runs it through the linter', async () => {
    const t = setup({ agentBody: 'h3. Итоги ещё раз\n\n|1|!01-captcha.png|thumbnail!|', formatSample: true });
    const draft = await step.prepare!(t.context());
    const again = (await step.prepare!(t.context(draft, 'добавь, что проверяли на мобильной версии'))) as { body: string; fixed: { rule: string }[] };
    expect(t.agent.requests[0]!.prompt).toContain('добавь, что проверяли на мобильной версии');
    expect(t.agent.requests[0]!.prompt).toContain('h3. Итоги проверки на стенде testing-5');
    expect(t.agent.requests[0]!.prompt).toContain(`Образец итогов команды: ${join(t.skill, 'references', 'jira-format.md')}.`);
    expect(again.body).toBe('h3. Итоги еще раз\n\n|1|!01-captcha.png|thumbnail!|');
    expect(again.fixed.length).toBeGreaterThan(0);
  });

  it('reworks the text by the current one and the prompt rules when the QA skill of the team has no sample of results', async () => {
    const t = setup({ agentBody: 'h3. Итоги\n\n|1|!01-captcha.png|thumbnail!|' });
    const draft = await step.prepare!(t.context());
    await step.prepare!(t.context(draft, 'короче'));
    expect(t.agent.requests[0]!.prompt).toContain('h3. Итоги проверки на стенде testing-5');
    expect(t.agent.requests[0]!.prompt).not.toContain('Образец итогов команды');
    expect(t.agent.requests[0]!.prompt).not.toContain('jira-format.md');
  });

  it('warns that the acceptance criteria changed in Jira after the run was opened', async () => {
    const t = setup({ description: `Критерии приемки:\n1. ${AC[0]}\n2. Новый критерий` });
    const draft = await step.prepare!(t.context());
    const preview: Preview = await step.preview!(t.context(draft));
    expect(preview.warnings).toContain('Критерии приемки в описании задачи изменились после открытия прогона: сверьте номера строк таблицы с актуальными AC');
  });

  it('does not warn about changed criteria for a task with the skip_ac label', async () => {
    const t = setup({ labels: ['dev_test', 'skip_ac'], description: 'Описание без раздела критериев', values: { ac: [] } });
    const draft = await step.prepare!(t.context());
    const preview: Preview = await step.preview!(t.context(draft));
    expect(preview.warnings?.some((w) => w.includes('Критерии приемки'))).toBe(false);
  });

  it('is done when the results of this run are already in Jira and the task reached In Testing', async () => {
    const comment: QaComment = { id: '1', url: 'https://jira.example.org/browse/TEAM-9?focusedCommentId=1#comment-1', key: KEY, rendered: { images: 2, rows: 3, unresolved: 0 }, at: '2026-09-23T12:00:00.000Z' };
    expect(await step.done!(setup({ status: 'In Testing', values: { qaComment: comment } }).context())).toEqual({ note: `Итоги этого прогона уже в Jira: ${comment.url}` });
    expect(await step.done!(setup({ status: 'To Testing', values: { qaComment: comment } }).context())).toBeNull();
    expect(await step.done!(setup({ status: 'In Testing', values: { qaComment: { ...comment, at: '2026-09-23T10:00:00.000Z' } } }).context())).toBeNull();
  });
});

describe('wiki markup of the results', () => {
  it('keeps table cells in one piece and escapes markup characters', () => {
    expect(escapeWiki('state=a|b\nвторая строка {code} [ссылка] !x! *жирный* _курсив_')).toBe('state=a/b вторая строка \\{code\\} \\[ссылка\\] \\!x\\! \\*жирный\\* \\_курсив\\_');
  });

  it('puts the reason of an unchecked AC into the result column and leaves an empty fact cell as a space', () => {
    const body = commentBody({ stand: 'testing-5', date: '23.09.2026', summary: 'Итог', build: null, results: [{ ...check('18', 'не проверен', []), note: 'на общем стенде не воспроизвести' }], remarks: [], reportName: null });
    expect(body).toContain('|18|сценарий 18|ввод номера|страница капчи (на общем стенде не воспроизвести)|не проверен| |');
    expect(body).not.toContain('h4.');
    expect(body).not.toContain('[^');
  });

  it('ends the summary with a period and mentions Kibana frames only when the table has them', () => {
    const base = { stand: 'testing-5', date: '23.09.2026', build: '1.0.4-246', remarks: [], reportName: null };
    const plain = commentBody({ ...base, summary: 'Капча работает', results: [check('1', 'пройден', ['01-captcha.png'])] });
    expect(plain).toContain('\nКапча работает. Сборка с образом 1.0.4-246.\n');
    expect(plain).not.toContain('Kibana');
    const logs = commentBody({ ...base, summary: 'Капча работает!', results: [check('1', 'пройден', ['01-captcha.png', 'kibana-logs-01.png'])] });
    // Восклицательный знак в wiki-разметке - картинка, поэтому в тексте он экранирован.
    expect(logs).toContain('\nКапча работает\\! Сборка с образом 1.0.4-246. Логи в колонке "Факт" - кадры Kibana стенда.\n');
  });

  it('finds the attachments the text refers to', () => {
    const body = '|1|!a.png|thumbnail! !b.png|thumbnail!|\nотчет [^TEAM-9-qa-report.md]';
    expect(thumbnails(body)).toEqual(['a.png', 'b.png']);
    expect(references(body)).toEqual(['a.png', 'b.png', 'TEAM-9-qa-report.md']);
  });

  it('puts the wording of the criteria from the plan into the AC column when the task description has none', async () => {
    const plan = { file: '/repo/.claude/TEAM-9/plan.md', hash: 'h', summary: 's', questions: [], ac: ['Капча `captcha.ftl` вместо SMS при фроде', 'SMS не уходит до капчи'] };
    const t = setup({ description: 'Показывать капчу, критериев нет', values: { ac: null, plan } });
    const { draft, preview } = await publish(t);
    expect(draft.body).toContain('|1. Капча captcha.ftl вместо SMS при фроде|сценарий 1|ввод номера|');
    expect(draft.body).toContain('|2. SMS не уходит до капчи|сценарий 2|');
    expect(preview.warnings?.some((w) => w.includes('Критерии приемки'))).toBe(false);
  });

  it('labels the AC cell by the number of a criterion from the plan and leaves anything else as it is', () => {
    const plan = ['Первый', 'Второй `код`'];
    expect(acLabel('1', plan)).toBe('1. Первый');
    expect(acLabel('AC 2', plan)).toBe('2. Второй код');
    expect(acLabel('2.', plan)).toBe('2. Второй код');
    expect(acLabel('3', plan)).toBe('3');
    expect(acLabel('1, 2', plan)).toBe('1, 2');
    expect(acLabel('1', null)).toBe('1');
  });
});
