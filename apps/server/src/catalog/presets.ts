import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, parse, parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { formatZodError, paramProblem, presetOrderIssues, presetSchema, stepSettings, TASK_INPUTS, type JiraConfig, type Preset, type PresetOrderIssue } from '@task-pilot/step-kit';
import { EngineError } from '../engine/engine.ts';
import type { CatalogView } from './catalog.ts';

/**
 * Пресеты, на которые опирается код: full - пресет нового прогона, rework - плашка изменений задачи, new-step - мастер
 * "Новый шаг". Их можно править, но не удалять.
 */
export const PROTECTED_PRESETS = new Set(['full', 'rework', 'new-step']);

const fieldsSchema = presetSchema.omit({ id: true });

/** Сохраненный пресет и предупреждения к порядку его шагов, которые сохранению не мешают. */
export type SavedPreset = Preset & { issues: PresetOrderIssue[] };

/** Правка пресетов из интерфейса: файлы pipelines/<id>.yaml, после записи каталог перечитывается. */
export interface PresetEditor {
  create(input: unknown): Promise<SavedPreset>;
  update(id: string, input: unknown): Promise<SavedPreset>;
  remove(id: string): Promise<void>;
}

/**
 * Проверяет пресет: схема, шаги без повторов и только из каталога (запланированные тоже: они ждут реализации
 * выключенными), выключенные по умолчанию - только из шагов пресета, настройки по умолчанию - только у шагов пресета и
 * только те, что есть в манифесте шага, со значениями из его вариантов (статусы доски board), и порядок: шаг не стоит
 * раньше шага, который дает нужный ему ключ (`presetOrderIssues`). Ошибки порядка отклоняют пресет все сразу,
 * предупреждения возвращаются.
 */
export function validPreset(preset: Preset, catalog: CatalogView, board: Pick<JiraConfig, 'path' | 'after' | 'milestones'>): PresetOrderIssue[] {
  const twice = preset.steps.filter((id, i) => preset.steps.indexOf(id) !== i);
  if (twice.length) throw new EngineError(`Шаги повторяются: ${[...new Set(twice)].join(', ')}`, 400);
  const unknown = preset.steps.filter((id) => !catalog.entry(id));
  if (unknown.length) throw new EngineError(`Неизвестные шаги: ${unknown.join(', ')}`, 400);
  const outside = preset.off.filter((id) => !preset.steps.includes(id));
  if (outside.length) throw new EngineError(`Выключены шаги, которых нет в пресете: ${outside.join(', ')}`, 400);
  for (const [stepId, values] of Object.entries(preset.params)) {
    const manifest = catalog.entry(stepId)?.manifest;
    if (!manifest || !preset.steps.includes(stepId)) throw new EngineError(`Настройки шага ${stepId}, которого нет в пресете`, 400);
    const settings = stepSettings(manifest, board);
    for (const [key, value] of Object.entries(values)) {
      const setting = settings.find((s) => s.key === key);
      if (!setting) throw new EngineError(`У шага "${manifest.title}" нет настройки ${key}`, 400);
      const problem = paramProblem(setting, value);
      if (problem) throw new EngineError(`Шаг "${manifest.title}": ${problem}`, 400);
    }
  }
  const issues = presetOrderIssues(preset, (id) => catalog.entry(id)?.manifest);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) throw new EngineError(`Порядок шагов: ${errors.map((i) => i.message).join('; ')}`, 400);
  return issues;
}

/** Входы пресета по умолчанию: задача и ее AC. Такие в файл не пишутся. */
const defaultInputs = (inputs: string[]) => inputs.length === TASK_INPUTS.length && TASK_INPUTS.every((k, i) => inputs[i] === k);

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new EngineError(formatZodError(r.error), 400);
  return r.data;
}

/** Файл пресета: тот, где записан этот id, или pipelines/<id>.yaml для нового. */
function fileOf(dir: string, id: string): { file: string; exists: boolean } {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')) : [];
  for (const f of files) {
    const value = parse(readFileSync(join(dir, f), 'utf8')) as { id?: unknown } | null;
    if (value?.id === id) return { file: join(dir, f), exists: true };
  }
  return { file: join(dir, `${id}.yaml`), exists: false };
}

/** Текст файла пресета. У существующего файла правятся поля, а комментарии остаются на местах. */
function yamlOf(preset: Preset, previous: string | null): string {
  const fields = {
    id: preset.id,
    title: preset.title,
    hint: preset.hint,
    steps: preset.steps,
    ...(preset.off.length ? { off: preset.off } : {}),
    ...(defaultInputs(preset.inputs) ? {} : { inputs: preset.inputs }),
    ...(Object.keys(preset.params).length ? { params: preset.params } : {}),
  };
  if (previous === null) return stringify(fields);
  const doc = parseDocument(previous);
  if (!isMap(doc.contents)) return stringify(fields);
  for (const [key, value] of Object.entries(fields)) {
    const node = doc.get(key, true);
    // Скаляр правится на месте, чтобы комментарий у ключа не пропал.
    if (node && typeof value === 'string' && 'value' in (node as object)) (node as { value: unknown }).value = value;
    else doc.set(key, value);
  }
  if (!preset.off.length) doc.delete('off');
  if (defaultInputs(preset.inputs)) doc.delete('inputs');
  if (!Object.keys(preset.params).length) doc.delete('params');
  return doc.toString();
}

/**
 * Редактор пресетов. Новый пресет не может занять id существующего, удаление пресетов из PROTECTED_PRESETS запрещено.
 * Прогоны с удаленным пресетом остаются как есть: их шаги уже записаны в прогоне.
 */
export function createPresetEditor(d: { dir: string; catalog: CatalogView; reload: () => Promise<void>; board: () => Pick<JiraConfig, 'path' | 'after' | 'milestones'> }): PresetEditor {
  const save = async (preset: Preset, previous: string | null, file: string): Promise<SavedPreset> => {
    const issues = validPreset(preset, d.catalog, d.board());
    writeFileSync(file, yamlOf(preset, previous));
    await d.reload();
    return { ...(d.catalog.preset(preset.id) ?? preset), issues };
  };
  return {
    async create(input) {
      const preset = parsed(presetSchema, input);
      const { file, exists } = fileOf(d.dir, preset.id);
      if (exists || d.catalog.preset(preset.id)) throw new EngineError(`Пресет ${preset.id} уже есть`, 409);
      return save(preset, null, file);
    },
    async update(id, input) {
      const { file, exists } = fileOf(d.dir, id);
      if (!exists) throw new EngineError(`Пресет ${id} не найден`, 404);
      return save({ id, ...parsed(fieldsSchema, input) }, readFileSync(file, 'utf8'), file);
    },
    async remove(id) {
      if (PROTECTED_PRESETS.has(id)) throw new EngineError(`Пресет ${id} нужен Task Pilot: его можно изменить, но не удалить`, 409);
      const { file, exists } = fileOf(d.dir, id);
      if (!exists) throw new EngineError(`Пресет ${id} не найден`, 404);
      rmSync(file);
      await d.reload();
    },
  };
}
