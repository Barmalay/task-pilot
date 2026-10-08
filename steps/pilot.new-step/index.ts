import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { LintIssue, NewStep, PilotCheck, StepContext, StepModule, StepRequest } from '../../packages/step-kit/src/index.ts';
import { renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, readText, sha256 } from '../_shared/agent.ts';

const LABEL = 'новый шаг';
const STEP_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
/** Что может лежать в папке шага: манифест, код, промпты и справочники. */
const ALLOWED = /\.(ya?ml|ts|md)$/;
const MAX_FILES = 20;

const SCHEMA = {
  type: 'object',
  properties: {
    stepId: { type: 'string', description: 'id шага вида область.действие' },
    title: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: 'Записанные файлы, пути от папки для файлов' },
    summary: { type: 'string', description: 'Суть шага в 1-3 предложениях и чего ему не хватает' },
  },
  required: ['stepId', 'title', 'files', 'summary'],
  additionalProperties: false,
};

interface Draft {
  sessionId: string;
  stepId: string;
  title: string;
  summary: string;
  /** Файлы шага: путь от корня Task Pilot и текст. */
  files: { path: string; text: string }[];
  check: PilotCheck | null;
  blocks: LintIssue[];
}

function draftOf(c: StepContext): Draft {
  const d = c.draft as Draft | undefined;
  if (!d) throw new Error('Черновика шага нет');
  return d;
}

/** Существующие шаги для промпта: id, название и вид из манифестов. */
function stepList(root: string): string {
  const dir = join(root, 'steps');
  return readdirSync(dir)
    .filter((d) => !d.startsWith('_') && existsSync(join(dir, d, 'step.yaml')))
    .sort()
    .map((d) => {
      const yaml = readFileSync(join(dir, d, 'step.yaml'), 'utf8');
      const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(yaml)?.[1]?.trim() ?? '';
      return `- ${d}: ${field('title')} (${field('kind')})`;
    })
    .join('\n');
}

function walk(dir: string, prefix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), posix.join(prefix, e.name)) : e.isFile() ? [posix.join(prefix, e.name)] : []));
}

function checkText(check: PilotCheck): string {
  return check.results.map((r) => (r.ok ? r.summary : `${r.summary}\n${r.output.trim()}`)).join('\n\n');
}

/**
 * Мастер "Новый шаг": по описанию владельца агент пишет папку шага (манифест, реализацию, промпт, тест) в отдельную
 * папку, а шаг проверяет ее на копии Task Pilot: типы шагов, тест нового шага и загрузку каталога с ним. Подтверждение
 * показывает все файлы и итог проверки, упавшая проверка и секреты в файлах его блокируют. После подтверждения код
 * кладет папку в steps/, добавляет ее в git и каталог подхватывает шаг; коммит - по команде владельца.
 */
const step: StepModule = {
  async done(c) {
    const made = c.get<NewStep>('newStep');
    return made ? { note: `Шаг ${made.id} уже в каталоге` } : null;
  },

  async prepare(c) {
    const request = c.get<StepRequest>('stepRequest');
    if (!request?.description.trim()) throw new Error('Нет описания шага');
    const { root } = c.ports.pilot;
    const staging = join(dirname(c.paths.agentDocs), 'new-step');
    const previous = c.draft as Draft | undefined;
    const resume = c.feedback && previous ? previous.sessionId : undefined;
    if (!resume) rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const failed = previous?.check && !previous.check.ok ? `\nПроверка прошлой версии не прошла:\n\n${checkText(previous.check)}\n` : '';
    const prompt = resume
      ? renderTemplate(readText(import.meta.url, './rework.md'), { feedback: c.feedback, check: failed, staging })
      : `${renderTemplate(readText(import.meta.url, './prompt.md'), { description: request.description.trim(), steps: stepList(root), staging })}\n\n${agentRules(c)}`;
    const r = await c.agent.run({
      label: LABEL,
      prompt,
      cwd: root,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      // Папку шага код перенесет в каталог после подтверждения: агент пишет только в отдельную папку.
      writeCwd: false,
      writeDirs: [staging],
      schema: SCHEMA,
      resume,
    });
    const o = (r.output ?? {}) as { stepId?: unknown; title?: unknown; summary?: unknown };
    const stepId = typeof o.stepId === 'string' ? o.stepId.trim() : '';
    if (!STEP_ID.test(stepId)) throw new Error(`Агент дал шагу id "${stepId}": нужен вид область.действие`);
    if (existsSync(join(root, 'steps', stepId, 'step.yaml'))) throw new Error(`Шаг ${stepId} уже есть в каталоге: переделайте с другим id`);
    const dir = join(staging, 'steps', stepId);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Агент не записал папку шага ${stepId}`);
    const paths = walk(dir, `steps/${stepId}`);
    const odd = paths.filter((p) => !ALLOWED.test(p));
    if (odd.length) throw new Error(`В папке шага лишние файлы: ${odd.join(', ')}`);
    if (paths.length > MAX_FILES) throw new Error(`В папке шага ${paths.length} файлов, больше ${MAX_FILES}`);
    const missing = ['step.yaml', 'index.ts'].filter((f) => !paths.includes(`steps/${stepId}/${f}`));
    if (!paths.some((p) => p.endsWith('.test.ts'))) missing.push('тест *.test.ts');
    if (missing.length) throw new Error(`В папке шага нет: ${missing.join(', ')}`);
    const files = paths.map((path) => ({ path, text: readFileSync(join(staging, path), 'utf8') }));
    const blocks: LintIssue[] = files.flatMap((f) => c.lint(f.text).issues.filter((i) => i.severity === 'block').map((i) => ({ ...i, message: `${f.path}: ${i.message}` })));
    // Каталог проверяется своим тестом: он грузит настоящие шаги копии, то есть и новый.
    const check = await c.ports.pilot.check(Object.fromEntries(files.map((f) => [f.path, f.text])), [`steps/${stepId}`, 'apps/server/test/catalog.test.ts']);
    if (!check.ok) blocks.push({ rule: 'tests', severity: 'block', message: `Проверка шага не прошла: ${check.results.filter((x) => !x.ok).map((x) => x.summary).join('; ')}` });
    return {
      sessionId: r.sessionId,
      stepId,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : stepId,
      summary: typeof o.summary === 'string' ? o.summary : r.text,
      files,
      check,
      blocks,
    } satisfies Draft;
  },

  async preview(c) {
    const d = draftOf(c);
    return {
      title: `Новый шаг "${d.title}" (${d.stepId})`,
      summary: d.summary,
      actions: [`Записать папку steps/${d.stepId}: файлов ${d.files.length}, и добавить ее в git`, 'Каталог подхватит шаг сразу; коммит - по команде владельца'],
      texts: [
        ...d.files.map((f, i) => ({ id: `file-${i}`, label: f.path, text: f.text, publish: false })),
        ...(d.check ? [{ id: 'check', label: 'Проверка типов, теста шага и каталога на копии Task Pilot', text: checkText(d.check), publish: false }] : []),
      ],
      lint: d.blocks,
      payload: { stepId: d.stepId, files: d.files.map((f) => ({ path: f.path, hash: sha256(f.text) })) },
    };
  },

  async simulate() {
    return {};
  },

  async run(c) {
    const d = draftOf(c);
    const { root } = c.ports.pilot;
    // Повтор после сбоя git: папка уже записана этим же черновиком, осталось добавить ее в git.
    const written = d.files.every((f) => existsSync(join(root, f.path)) && readFileSync(join(root, f.path), 'utf8') === f.text);
    if (!written && existsSync(join(root, 'steps', d.stepId, 'step.yaml'))) throw new Error(`Шаг ${d.stepId} уже появился в каталоге: переделайте с другим id`);
    if (!written) {
      for (const f of d.files) {
        mkdirSync(dirname(join(root, f.path)), { recursive: true });
        writeFileSync(join(root, f.path), f.text);
      }
    }
    await c.ports.git.run(root, ['add', '--', `steps/${d.stepId}`]);
    c.log(`Шаг ${d.stepId} записан в steps/${d.stepId} и добавлен в git. Коммит - по команде владельца`);
    return { newStep: { id: d.stepId, title: d.title, files: d.files.map((f) => f.path), at: new Date().toISOString() } satisfies NewStep };
  },
};

export default step;
