import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRequest, Improvements, PilotCheck, PilotPort, RunJournal } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

const KEY = 'TEAM-8';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const AT = '2026-09-23T10:00:00.000Z';
const entry = (stepId: string, step: string) => ({ stepId, step, at: AT });

const JOURNAL: RunJournal = {
  corrections: [
    { ...entry('qa.fix', 'Доработка по тесту'), decision: 'rework', title: 'Коммит доработки', comment: 'Проверяй знак результата' },
    { ...entry('qa.fix', 'Доработка по тесту'), decision: 'retry', title: 'AC 3 кодом не исправить', comment: 'Окружение поправил, прогони AC 3 снова' },
    { ...entry('pilot.retro', 'Разбор прогона'), decision: 'rework', title: 'Разбор', comment: 'Не трогай скиллы' },
  ],
  questions: [{ ...entry('qa.stand', 'Тест на стенде'), question: 'Какой стенд?', answer: 'stable' }],
  failures: [{ ...entry('ci.wait', 'Сборка ветки'), error: 'Сборка упала: тест CalculatorTest' }],
  denials: [{ ...entry('qa.fix', 'Доработка по тесту'), tools: ['Bash(curl https://example.org)'] }],
  loops: [{ ...entry('qa.fix', 'Доработка по тесту'), round: 1, max: 3 }],
};

const EMPTY: RunJournal = { corrections: [], questions: [], failures: [], denials: [], loops: [] };

const QA_FIX = 'Ты выполняешь шаг "Доработка по тесту" по задаче {{key}}.\n\nИсправь код по отчету.\n';
const SKILL = '# Демо-скилл\n\nТестовый номер для входа: +7 999 111-22-33.\n';

type Proposal = Record<string, string | undefined>;

function setup(opts: { journal?: RunJournal; proposals?: Proposal; changes?: { file: string; reason: string }[]; check?: PilotCheck; values?: Record<string, unknown> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'retro-')));
  roots.push(root);
  const pilot = join(root, 'pilot');
  const skills = join(root, 'skills');
  const files: Record<string, string> = {
    'pilot/steps/qa.fix/prompt.md': QA_FIX,
    'pilot/steps/qa.stand/prompt.md': 'Прогони AC на стенде {{stand}}.\n',
    'pilot/steps/code.publish/prompt.md': 'Тексты публикации.\n',
    'pilot/steps/_shared/rules.md': '## Правила конвейера\n',
    'pilot/steps/ci.wait/step.yaml': 'id: ci.wait\n',
    'skills/demo/SKILL.md': SKILL,
    'skills/demo/reference/format.md': '# Формат\n',
    'skills/notes/readme.md': 'Не скилл: нет SKILL.md\n',
    'team/rules.md': '- Keycloak пиши латиницей.\n',
  };
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  const checks: { overlay: Record<string, string | null>; tests: string[] }[] = [];
  const port: PilotPort = {
    root: pilot,
    skillsDir: skills,
    teamRules: join(root, 'team', 'rules.md'),
    journal: async () => opts.journal ?? JOURNAL,
    async check(overlay, tests) {
      checks.push({ overlay, tests });
      return opts.check ?? { ok: true, results: [{ command: 'tsc', ok: true, summary: 'Типы в порядке', output: '' }, { command: 'vitest', ok: true, summary: 'Тесты: пройдено 167', output: '' }] };
    },
  };
  const proposals = opts.proposals ?? {
    'steps/qa.fix/prompt.md': `${QA_FIX}Проверь знак результата арифметики тестом.\n`,
    'skills/demo/SKILL.md': `${SKILL}\nСтенд по умолчанию спрашивай у владельца.\n`,
  };
  const agent = fakeAgent((req: AgentRequest) => {
    for (const [file, text] of Object.entries(proposals)) {
      if (text === undefined) continue;
      mkdirSync(dirname(join(req.writeDirs![0]!, file)), { recursive: true });
      writeFileSync(join(req.writeDirs![0]!, file), text);
    }
    const changes = opts.changes ?? Object.keys(proposals).map((file) => ({ file, reason: 'замечание про знак результата' }));
    return { sessionId: req.resume ?? 's-1', output: { changes, summary: 'Правка промпта доработки' } };
  });
  const repo = testRepo(join(root, 'repo'), join(root, 'wt'));
  const c = testContext({ issueKey: KEY, repo, ports: { pilot: port }, agent: agent.agent, values: { issue: { key: KEY, summary: 'Разность' }, ...opts.values } });
  return { c, agent, checks, pilot, skills, root };
}

/** Как движок: черновик из prepare, затем превью. */
async function draft(t: ReturnType<typeof setup>) {
  t.c.draft = await step.prepare!(t.c);
  return step.preview!(t.c);
}

describe('pilot.retro', () => {
  it('is done when the run has nothing to learn from or was already reviewed after its last correction', async () => {
    expect(await step.done!(setup({ journal: EMPTY }).c)).toEqual({ note: 'В прогоне нет замечаний владельца, ответов на вопросы и сбоев: разбирать нечего' });
    const own: RunJournal = { ...EMPTY, corrections: JOURNAL.corrections.filter((x) => x.stepId === 'pilot.retro') };
    expect(await step.done!(setup({ journal: own }).c)).toMatchObject({ note: expect.stringContaining('разбирать нечего') });
    const reviewed: Improvements = { files: ['steps/qa.fix/prompt.md'], summary: '', tests: null, at: '2026-09-23T11:00:00.000Z' };
    expect(await step.done!(setup({ values: { improvements: reviewed } }).c)).toEqual({ note: 'Прогон уже разобран: правки в steps/qa.fix/prompt.md' });
    expect(await step.done!(setup({ values: { improvements: { ...reviewed, at: '2026-09-23T09:00:00.000Z' } } }).c)).toBeNull();
  });

  it('gives the agent the journal and only the prompts of its steps, the shared rules and the skills, writing only into its own folder', async () => {
    const t = setup();
    await draft(t);
    const req = t.agent.requests[0]!;
    expect(req.prompt).toContain('- Доработка по тесту (qa.fix): вернул на доработку "Коммит доработки", замечание: Проверяй знак результата');
    expect(req.prompt).toContain('- Доработка по тесту (qa.fix): повторил упавший шаг после ошибки "AC 3 кодом не исправить", замечание агенту: Окружение поправил, прогони AC 3 снова');
    expect(req.prompt).toContain('- Тест на стенде (qa.stand): вопрос "Какой стенд?", ответ "stable"');
    expect(req.prompt).toContain('- Сборка ветки (ci.wait): Сборка упала: тест CalculatorTest');
    expect(req.prompt).toContain('- Доработка по тесту (qa.fix): Bash(curl https://example.org)');
    expect(req.prompt).toContain('- Доработка по тесту (qa.fix): круг 1 из 3');
    expect(req.prompt).not.toContain('Не трогай скиллы');
    const listed = [...req.prompt.matchAll(/^- ((?:steps|team|skills)\/\S+): /gm)].map((m) => m[1]);
    // Правила команды - в ее пакете: туда разбор кладет то, что относится только к команде.
    expect(listed).toEqual(['steps/qa.fix/prompt.md', 'steps/qa.stand/prompt.md', 'steps/_shared/rules.md', 'team/rules.md', 'skills/demo/SKILL.md', 'skills/demo/reference/format.md']);
    expect(req.prompt).toContain(`- steps/qa.fix/prompt.md: ${join(t.pilot, 'steps/qa.fix/prompt.md')}`);
    expect(req).toMatchObject({ label: 'разбор прогона', cwd: t.pilot, writeCwd: false, writeDirs: [join(t.root, 'wt/.task-pilot/demo-TEAM-8/retro')] });
    expect(req.tools).not.toContain('Bash');
  });

  it('shows the diff and the check of the step prompts and writes the files after the approval', async () => {
    const t = setup();
    const preview = await draft(t);
    expect(t.checks).toEqual([{ overlay: { 'steps/qa.fix/prompt.md': `${QA_FIX}Проверь знак результата арифметики тестом.\n` }, tests: ['steps'] }]);
    expect(preview.actions[0]).toBe('Записать файлов: 2 (steps/qa.fix/prompt.md, skills/demo/SKILL.md)');
    expect(preview.actions[1]).toContain('правила и скиллы команды лежат в ее пакете');
    expect(preview.texts?.map((x) => x.label)).toEqual([
      'steps/qa.fix/prompt.md: замечание про знак результата',
      'skills/demo/SKILL.md: замечание про знак результата',
      'Проверка типов и тестов шагов с правками',
    ]);
    expect(preview.texts?.[0]?.text).toContain('+ Проверь знак результата арифметики тестом.');
    expect(preview.texts?.[2]?.text).toBe('Типы в порядке\n\nТесты: пройдено 167');
    expect(preview.lint).toEqual([]);

    const out = (await step.run(t.c)) as { improvements: Improvements };
    expect(readFileSync(join(t.pilot, 'steps/qa.fix/prompt.md'), 'utf8')).toContain('Проверь знак результата');
    expect(readFileSync(join(t.skills, 'demo/SKILL.md'), 'utf8')).toContain('Стенд по умолчанию');
    expect(out.improvements).toMatchObject({ files: ['steps/qa.fix/prompt.md', 'skills/demo/SKILL.md'], summary: 'Правка промпта доработки', tests: 'Типы в порядке; Тесты: пройдено 167' });
  });

  it('blocks secrets in the added lines, new placeholders and a failed check, but not what the file already had', async () => {
    const t = setup({
      proposals: {
        'steps/qa.fix/prompt.md': `${QA_FIX}Стенд: {{stand}}. Пиши на owner@example.org.\n`,
        'skills/demo/SKILL.md': `${SKILL}\nЕще правило.\n`,
      },
      check: { ok: false, results: [{ command: 'vitest', ok: false, summary: 'Тесты: пройдено 165, упало 2', output: 'FAIL steps/qa.fix/qa.fix.test.ts' }] },
    });
    const preview = await draft(t);
    expect(preview.lint?.map((i) => [i.rule, i.message])).toEqual([
      ['email', 'steps/qa.fix/prompt.md: в тексте адрес почты'],
      ['template', 'steps/qa.fix/prompt.md: новые подстановки stand - код шага их не передает'],
      ['tests', 'Проверка с правками не прошла: Тесты: пройдено 165, упало 2'],
    ]);
    expect(preview.texts?.at(-1)?.text).toBe('Тесты: пройдено 165, упало 2\nFAIL steps/qa.fix/qa.fix.test.ts');
  });

  it('accepts only files from the list that the agent really rewrote', async () => {
    const t = setup({
      proposals: { 'steps/code.publish/prompt.md': 'Другое.\n', 'skills/demo/SKILL.md': SKILL },
      changes: [
        { file: 'steps/code.publish/prompt.md', reason: '' },
        { file: '../../etc/hosts', reason: '' },
        { file: 'skills/demo/SKILL.md', reason: '' },
        { file: 'skills/demo/reference/format.md', reason: '' },
      ],
    });
    const preview = await draft(t);
    expect(preview.warnings).toEqual([
      'Не принято: steps/code.publish/prompt.md: этот файл разбору править нельзя',
      'Не принято: ../../etc/hosts: этот файл разбору править нельзя',
      'Не принято: skills/demo/SKILL.md: новая версия не отличается от текущей',
      'Не принято: skills/demo/reference/format.md: агент не записал новую версию',
    ]);
    expect(preview.requiresApproval).toBe(false);
    expect(await step.run(t.c)).toMatchObject({ improvements: { files: [], tests: null } });
    expect(t.checks).toEqual([]);
  });

  it('refuses to write over a file that changed after the preparation', async () => {
    const t = setup();
    await draft(t);
    writeFileSync(join(t.pilot, 'steps/qa.fix/prompt.md'), `${QA_FIX}Правка владельца.\n`);
    await expect(step.run(t.c)).rejects.toThrow('Файлы изменились после подготовки правок: steps/qa.fix/prompt.md');
    expect(readFileSync(join(t.skills, 'demo/SKILL.md'), 'utf8')).toBe(SKILL);
  });

  it('reworks the proposals by the owner remark in the same agent session, keeping the earlier versions', async () => {
    const t = setup();
    t.c.draft = await step.prepare!(t.c);
    const staging = t.agent.requests[0]!.writeDirs![0]!;
    t.c.feedback = 'Не трогай скиллы';
    await step.prepare!(t.c);
    const req = t.agent.requests[1]!;
    expect(req.resume).toBe('s-1');
    expect(req.prompt).toContain('Не трогай скиллы');
    expect(req.prompt).toContain(staging);
    expect(existsSync(join(staging, 'skills/demo/SKILL.md'))).toBe(true);
  });
});
