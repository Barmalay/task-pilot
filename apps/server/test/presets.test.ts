import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Catalog } from '../src/catalog/catalog.ts';
import { createPresetEditor } from '../src/catalog/presets.ts';
import { buildServer } from '../src/http/server.ts';
import { TaskService } from '../src/tasks.ts';
import { FakeCatalog, makeEngine, manifest, PROFILES } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PLANNED = ['jira.start', 'git.prepare', 'code.implement', 'wiki.update']
  .map((id) => `- id: ${id}\n  title: Шаг ${id}\n  hint: подсказка\n  phase: task\n  kind: code\n  stage: 2\n`)
  .join('');

const FINISH = `id: finish
title: Завершение
hint: После ревью
steps:
  - git.prepare
  - wiki.update
# Вики включает владелец, когда страница нужна.
off:
  - wiki.update
`;

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'presets-')));
  dirs.push(root);
  mkdirSync(join(root, 'steps'));
  mkdirSync(join(root, 'pipelines'));
  writeFileSync(join(root, 'steps', '_planned.yaml'), PLANNED);
  writeFileSync(join(root, 'pipelines', 'finish.yaml'), FINISH);
  writeFileSync(join(root, 'pipelines', 'full.yaml'), 'id: full\ntitle: Полный цикл\nhint: Все шаги\nsteps:\n  - jira.start\n');
  const catalog = new Catalog(join(root, 'steps'), join(root, 'pipelines'));
  await catalog.load();
  const editor = createPresetEditor({ dir: join(root, 'pipelines'), catalog, reload: () => catalog.load(), board: () => PROFILES.jira });
  return { root, catalog, editor, file: (f: string) => join(root, 'pipelines', f) };
}

describe('preset editor', () => {
  it('creates a preset in its own file and the catalog knows it at once', async () => {
    const t = await setup();
    const saved = await t.editor.create({ id: 'docs', title: 'Документы', hint: 'Только вики', steps: ['git.prepare', 'wiki.update'], off: [] });
    expect(saved).toEqual({ id: 'docs', title: 'Документы', hint: 'Только вики', steps: ['git.prepare', 'wiki.update'], off: [], inputs: ['issue', 'ac'], params: {}, issues: [] });
    expect(readFileSync(t.file('docs.yaml'), 'utf8')).toBe('id: docs\ntitle: Документы\nhint: Только вики\nsteps:\n  - git.prepare\n  - wiki.update\n');
    expect(t.catalog.preset('docs')?.title).toBe('Документы');
    await expect(t.editor.create({ id: 'docs', title: 'Еще', hint: 'x', steps: ['git.prepare'] })).rejects.toThrow('Пресет docs уже есть');
  });

  it('changes the fields of an existing preset and keeps the comments of its file', async () => {
    const t = await setup();
    await t.editor.update('finish', { title: 'Завершение задачи', hint: 'После ревью', steps: ['code.implement', 'git.prepare', 'wiki.update'], off: ['wiki.update', 'code.implement'] });
    const text = readFileSync(t.file('finish.yaml'), 'utf8');
    expect(text).toContain('title: Завершение задачи');
    expect(text).toContain('# Вики включает владелец, когда страница нужна.\noff:\n  - wiki.update\n  - code.implement');
    expect(t.catalog.preset('finish')).toMatchObject({ steps: ['code.implement', 'git.prepare', 'wiki.update'], off: ['wiki.update', 'code.implement'] });
    await t.editor.update('finish', { title: 'Завершение задачи', hint: 'После ревью', steps: ['git.prepare'], off: [] });
    expect(readFileSync(t.file('finish.yaml'), 'utf8')).not.toContain('off:');
  });

  it('refuses unknown or repeated steps, switched off steps outside the preset and a broken id', async () => {
    const t = await setup();
    const base = { id: 'x', title: 'X', hint: 'x' };
    await expect(t.editor.create({ ...base, steps: ['git.prepare', 'deploy.moon'] })).rejects.toThrow('Неизвестные шаги: deploy.moon');
    await expect(t.editor.create({ ...base, steps: ['git.prepare', 'git.prepare'] })).rejects.toThrow('Шаги повторяются: git.prepare');
    await expect(t.editor.create({ ...base, steps: ['git.prepare'], off: ['wiki.update'] })).rejects.toThrow('Выключены шаги, которых нет в пресете: wiki.update');
    await expect(t.editor.create({ ...base, id: '../evil', steps: ['git.prepare'] })).rejects.toMatchObject({ status: 400 });
    await expect(t.editor.update('nope', { title: 'X', hint: 'x', steps: ['git.prepare'] })).rejects.toMatchObject({ status: 404 });
    expect(existsSync(t.file('x.yaml'))).toBe(false);
  });

  it('deletes a preset but not the ones Task Pilot relies on', async () => {
    const t = await setup();
    await t.editor.remove('finish');
    expect(existsSync(t.file('finish.yaml'))).toBe(false);
    expect(t.catalog.preset('finish')).toBeUndefined();
    await expect(t.editor.remove('full')).rejects.toMatchObject({ status: 409, message: 'Пресет full нужен Task Pilot: его можно изменить, но не удалить' });
    await expect(t.editor.remove('finish')).rejects.toMatchObject({ status: 404 });
  });

  it('is available over the API with the status of every refusal', async () => {
    const t = await setup();
    const deps = makeEngine(new FakeCatalog());
    const server = buildServer({ ...deps, profiles: PROFILES, catalog: t.catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), presets: t.editor });
    const LOCAL = { host: '127.0.0.1:5176', 'x-task-pilot': '1' };
    try {
      const created = await server.inject({ method: 'POST', url: '/api/presets', headers: LOCAL, payload: { id: 'docs', title: 'Документы', hint: 'x', steps: ['wiki.update'] } });
      expect(created.statusCode).toBe(201);
      const updated = await server.inject({ method: 'PUT', url: '/api/presets/docs', headers: LOCAL, payload: { title: 'Вики', hint: 'x', steps: ['git.prepare', 'wiki.update'], off: ['wiki.update'] } });
      expect(updated.json()).toMatchObject({ id: 'docs', title: 'Вики', off: ['wiki.update'] });
      expect((await server.inject({ method: 'GET', url: '/api/catalog', headers: LOCAL })).json().presets.map((p: { id: string }) => p.id)).toContain('docs');
      const bad = await server.inject({ method: 'PUT', url: '/api/presets/docs', headers: LOCAL, payload: { title: 'Вики', hint: 'x', steps: ['moon.walk'] } });
      expect(bad.statusCode).toBe(400);
      expect((await server.inject({ method: 'DELETE', url: '/api/presets/full', headers: LOCAL })).statusCode).toBe(409);
      expect((await server.inject({ method: 'DELETE', url: '/api/presets/docs', headers: LOCAL })).json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });
});

describe('order of the steps in the preset editor', () => {
  const LOCAL = { host: '127.0.0.1:5176', 'x-task-pilot': '1' };

  /** Редактор над каталогом, где деплой требует сборку, которую дает шаг сборки. */
  function orderSetup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'presets-order-')));
    dirs.push(root);
    const catalog = new FakeCatalog()
      .add(manifest('ci.wait', { title: 'Сборка', provides: ['build'] }), { run: async () => ({}) })
      .add(manifest('deploy.stand', { title: 'Деплой', requires: ['build'] }), { run: async () => ({}) })
      .add(manifest('pilot.new-step', { title: 'Новый шаг', requires: ['stepRequest'] }), { run: async () => ({}) });
    const editor = createPresetEditor({ dir: root, catalog, reload: async () => {}, board: () => PROFILES.jira });
    return { catalog, editor, file: (f: string) => join(root, f) };
  }

  it('refuses a step placed before the step that provides its key and a key no step provides, all errors at once', async () => {
    const t = orderSetup();
    const base = { id: 'order', title: 'Порядок', hint: 'x' };
    await expect(t.editor.create({ ...base, steps: ['deploy.stand', 'ci.wait'] })).rejects.toMatchObject({
      status: 400,
      message: 'Порядок шагов: шаг "Деплой" требует build, который дает шаг "Сборка", стоящий позже',
    });
    await expect(t.editor.create({ ...base, steps: ['deploy.stand', 'pilot.new-step'] })).rejects.toMatchObject({
      message: 'Порядок шагов: ключ build для шага "Деплой" не дает ни один шаг пресета; ключ stepRequest для шага "Новый шаг" не дает ни один шаг пресета',
    });
    expect(existsSync(t.file('order.yaml'))).toBe(false);
  });

  it('saves a preset whose provider is switched off by default and gives the warning back', async () => {
    const t = orderSetup();
    const saved = await t.editor.create({ id: 'order', title: 'Порядок', hint: 'x', steps: ['ci.wait', 'deploy.stand'], off: ['ci.wait'] });
    expect(saved.issues).toEqual([{ level: 'warning', stepId: 'deploy.stand', key: 'build', message: 'build для шага "Деплой" дает шаг "Сборка", выключенный по умолчанию' }]);
    expect(existsSync(t.file('order.yaml'))).toBe(true);
  });

  it('writes the inputs of a preset to its file only when they are not the task and its AC', async () => {
    const t = orderSetup();
    await t.editor.create({ id: 'wizard', title: 'Мастер', hint: 'x', steps: ['pilot.new-step'], inputs: ['stepRequest'] });
    expect(readFileSync(t.file('wizard.yaml'), 'utf8')).toContain('inputs:\n  - stepRequest\n');
    await t.editor.create({ id: 'plain', title: 'Сборка', hint: 'x', steps: ['ci.wait'] });
    expect(readFileSync(t.file('plain.yaml'), 'utf8')).not.toContain('inputs');
  });

  it('answers 400 over the API for a step placed before its provider', async () => {
    const t = orderSetup();
    const deps = makeEngine(t.catalog);
    const server = buildServer({ ...deps, profiles: PROFILES, catalog: t.catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), presets: t.editor });
    try {
      const bad = await server.inject({ method: 'POST', url: '/api/presets', headers: LOCAL, payload: { id: 'order', title: 'Порядок', hint: 'x', steps: ['deploy.stand', 'ci.wait'] } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error_description: 'Порядок шагов: шаг "Деплой" требует build, который дает шаг "Сборка", стоящий позже' });
    } finally {
      await server.close();
    }
  });
});

describe('default settings of steps in the preset editor', () => {
  /** Редактор над каталогом, где у шага "В работу" есть настройка перевода по доске, а у шага ветки настроек нет. */
  function settingsSetup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'presets-params-')));
    dirs.push(root);
    const catalog = new FakeCatalog()
      .add(manifest('jira.start', { title: 'В работу', params: { moveTo: { type: 'jiraStatus', label: 'Куда перевести задачу', milestone: 'inProgress' } } }), { run: async () => ({}) })
      .add(manifest('git.prepare', { title: 'Ветка' }), { run: async () => ({}) });
    const editor = createPresetEditor({ dir: root, catalog, reload: async () => {}, board: () => PROFILES.jira });
    return { editor, file: (f: string) => join(root, f) };
  }

  it('writes the default settings of steps to the preset file and removes them once they are cleared', async () => {
    const t = settingsSetup();
    const steps = ['jira.start', 'git.prepare'];
    const saved = await t.editor.create({ id: 'quiet', title: 'Без доски', hint: 'x', steps, params: { 'jira.start': { moveTo: 'none' } } });
    expect(saved.params).toEqual({ 'jira.start': { moveTo: 'none' } });
    expect(readFileSync(t.file('quiet.yaml'), 'utf8')).toContain('params:\n  jira.start:\n    moveTo: none\n');
    await t.editor.update('quiet', { title: 'Без доски', hint: 'x', steps, params: { 'jira.start': { moveTo: 'Open' } } });
    expect(readFileSync(t.file('quiet.yaml'), 'utf8')).toContain('    moveTo: Open\n');
    await t.editor.update('quiet', { title: 'Без доски', hint: 'x', steps, params: {} });
    expect(readFileSync(t.file('quiet.yaml'), 'utf8')).not.toContain('params');
  });

  it('refuses settings of a step outside the preset, a setting the step does not have and a status that is not on the board', async () => {
    const t = settingsSetup();
    const base = { id: 'bad', title: 'X', hint: 'x', steps: ['jira.start'] };
    await expect(t.editor.create({ ...base, params: { 'git.prepare': { moveTo: 'none' } } })).rejects.toThrow('Настройки шага git.prepare, которого нет в пресете');
    await expect(t.editor.create({ ...base, params: { 'jira.start': { color: 'red' } } })).rejects.toThrow('У шага "В работу" нет настройки color');
    await expect(t.editor.create({ ...base, params: { 'jira.start': { moveTo: 'Closed' } } })).rejects.toMatchObject({ status: 400, message: 'Шаг "В работу": "Куда перевести задачу": варианта "Closed" нет' });
    expect(existsSync(t.file('bad.yaml'))).toBe(false);
  });
});
