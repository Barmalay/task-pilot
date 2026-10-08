import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRequest, GitPort, NewStep, PilotCheck, PilotPort } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const GREEN: PilotCheck = {
  ok: true,
  results: [
    { command: 'tsc', ok: true, summary: 'Типы в порядке', output: '' },
    { command: 'vitest', ok: true, summary: 'Тесты: пройдено 9', output: '' },
  ],
};

const FILES = {
  'steps/demo.hello/step.yaml': 'id: demo.hello\ntitle: Привет\nhint: здоровается\nphase: meta\nkind: code\nprovides: [greeting]\n',
  'steps/demo.hello/index.ts': "export default { async run() { return { greeting: 'привет' }; } };\n",
  'steps/demo.hello/demo.hello.test.ts': "import { it } from 'vitest';\nit('greets', () => {});\n",
};

function setup(opts: { files?: Record<string, string>; stepId?: string; check?: PilotCheck; values?: Record<string, unknown> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'new-step-')));
  roots.push(root);
  const pilot = join(root, 'pilot');
  mkdirSync(join(pilot, 'steps', 'jira.start'), { recursive: true });
  writeFileSync(join(pilot, 'steps', 'jira.start', 'step.yaml'), 'id: jira.start\ntitle: Взять в работу\nhint: x\nphase: task\nkind: code\n');
  writeFileSync(join(pilot, 'steps', '_planned.yaml'), '[]\n');
  const checks: { overlay: Record<string, string | null>; tests: string[] }[] = [];
  const port: PilotPort = {
    root: pilot,
    skillsDir: join(root, 'skills'),
    journal: async () => ({ corrections: [], questions: [], failures: [], denials: [], loops: [] }),
    async check(overlay, tests) {
      checks.push({ overlay, tests });
      return opts.check ?? GREEN;
    },
  };
  const git: string[][] = [];
  const gitPort: GitPort = {
    async run(_cwd, args) {
      git.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
    tryRun: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
  const files = opts.files ?? FILES;
  const agent = fakeAgent((req: AgentRequest) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(req.writeDirs![0]!, path)), { recursive: true });
      writeFileSync(join(req.writeDirs![0]!, path), text);
    }
    return { sessionId: req.resume ?? 's-1', output: { stepId: opts.stepId ?? 'demo.hello', title: 'Привет', files: Object.keys(files), summary: 'Здоровается' } };
  });
  const repo = testRepo(join(root, 'repo'), join(root, 'wt'));
  const c = testContext({ issueKey: 'PILOT-1', repo, ports: { pilot: port, git: gitPort }, agent: agent.agent, values: { stepRequest: { description: 'Шаг, который здоровается' }, ...opts.values } });
  return { c, agent, checks, git, pilot };
}

async function draft(t: ReturnType<typeof setup>) {
  t.c.draft = await step.prepare!(t.c);
  return step.preview!(t.c);
}

describe('pilot.new-step', () => {
  it('asks the agent for a step by the description, with the list of steps, writing only into its own folder', async () => {
    const t = setup();
    await draft(t);
    const req = t.agent.requests[0]!;
    expect(req.prompt).toContain('<описание>\nШаг, который здоровается\n</описание>');
    expect(req.prompt).toContain('- jira.start: Взять в работу (code)');
    expect(req).toMatchObject({ label: 'новый шаг', cwd: t.pilot, writeCwd: false });
    expect(req.prompt).toContain(`${req.writeDirs![0]}/steps/<id>/`);
    expect(req.tools).not.toContain('Bash');
  });

  it('shows every file with the check of types, the step test and the catalog, then puts the folder into the catalog and git', async () => {
    const t = setup();
    const preview = await draft(t);
    expect(t.checks).toEqual([{ overlay: FILES, tests: ['steps/demo.hello', 'apps/server/test/catalog.test.ts'] }]);
    expect(preview.title).toBe('Новый шаг "Привет" (demo.hello)');
    expect(preview.texts?.map((x) => x.label)).toEqual([
      'steps/demo.hello/demo.hello.test.ts',
      'steps/demo.hello/index.ts',
      'steps/demo.hello/step.yaml',
      'Проверка типов, теста шага и каталога на копии Task Pilot',
    ]);
    expect(preview.texts?.at(-1)?.text).toBe('Типы в порядке\n\nТесты: пройдено 9');
    expect(preview.lint).toEqual([]);

    const out = (await step.run(t.c)) as { newStep: NewStep };
    expect(readFileSync(join(t.pilot, 'steps/demo.hello/index.ts'), 'utf8')).toBe(FILES['steps/demo.hello/index.ts']);
    expect(t.git).toEqual([['add', '--', 'steps/demo.hello']]);
    expect(out.newStep).toMatchObject({ id: 'demo.hello', title: 'Привет', files: expect.arrayContaining(Object.keys(FILES)) });
    expect(await step.done!(setup({ values: { newStep: out.newStep } }).c)).toEqual({ note: 'Шаг demo.hello уже в каталоге' });
  });

  it('blocks the approval when the check fails or a file holds a phone or a token', async () => {
    const red: PilotCheck = { ok: false, results: [{ command: 'vitest', ok: false, summary: 'Тесты: пройдено 1, упало 1', output: 'FAIL steps/demo.hello' }] };
    const t = setup({ check: red, files: { ...FILES, 'steps/demo.hello/prompt.md': 'Позвони на +7 916 123-45-67\n' } });
    const preview = await draft(t);
    expect(preview.lint?.map((i) => [i.rule, i.message])).toEqual([
      ['phone', 'steps/demo.hello/prompt.md: в тексте номер телефона'],
      ['tests', 'Проверка шага не прошла: Тесты: пройдено 1, упало 1'],
    ]);
  });

  it('refuses a bad or taken id, a folder without a test and files that are not code, prompts or manifests', async () => {
    await expect(step.prepare!(setup({ stepId: 'Hello' }).c)).rejects.toThrow('Агент дал шагу id "Hello"');
    await expect(step.prepare!(setup({ stepId: 'jira.start' }).c)).rejects.toThrow('Шаг jira.start уже есть в каталоге');
    await expect(step.prepare!(setup({ stepId: 'demo.other' }).c)).rejects.toThrow('Агент не записал папку шага demo.other');
    const noTest = { ...FILES } as Record<string, string>;
    delete noTest['steps/demo.hello/demo.hello.test.ts'];
    await expect(step.prepare!(setup({ files: noTest }).c)).rejects.toThrow('В папке шага нет: тест *.test.ts');
    await expect(step.prepare!(setup({ files: { ...FILES, 'steps/demo.hello/run.sh': 'curl x' } }).c)).rejects.toThrow('В папке шага лишние файлы: steps/demo.hello/run.sh');
  });

  it('reworks the step in the same agent session and tells the agent what failed in the check', async () => {
    const red: PilotCheck = { ok: false, results: [{ command: 'tsc', ok: false, summary: 'Ошибок типов: 1', output: 'index.ts(1,1): error TS2322' }] };
    const t = setup({ check: red });
    t.c.draft = await step.prepare!(t.c);
    t.c.feedback = 'Почини типы';
    await step.prepare!(t.c);
    const req = t.agent.requests[1]!;
    expect(req.resume).toBe('s-1');
    expect(req.prompt).toContain('Почини типы');
    expect(req.prompt).toContain('Ошибок типов: 1\nindex.ts(1,1): error TS2322');
  });

  it('only adds the folder to git on a retry after git failed, since the files are already written', async () => {
    const t = setup();
    await draft(t);
    const working = t.c.ports.git.run;
    t.c.ports.git.run = async () => {
      throw new Error('fatal: not a git repository');
    };
    await expect(step.run(t.c)).rejects.toThrow('not a git repository');
    t.c.ports.git.run = working;
    await step.run(t.c);
    expect(t.git).toEqual([['add', '--', 'steps/demo.hello']]);
  });

  it('does not overwrite a step that appeared in the catalog after the preparation', async () => {
    const t = setup();
    await draft(t);
    mkdirSync(join(t.pilot, 'steps/demo.hello'), { recursive: true });
    writeFileSync(join(t.pilot, 'steps/demo.hello/step.yaml'), 'id: demo.hello\n');
    await expect(step.run(t.c)).rejects.toThrow('Шаг demo.hello уже появился в каталоге');
    expect(existsSync(join(t.pilot, 'steps/demo.hello/index.ts'))).toBe(false);
  });
});
