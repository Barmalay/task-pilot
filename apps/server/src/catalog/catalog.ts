import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  CONTEXT_SCHEMAS,
  formatZodError,
  plannedStepSchema,
  presetOrderIssues,
  presetSchema,
  stepManifestSchema,
  type Preset,
  type PresetOrderIssue,
  type StepManifest,
  type StepModule,
} from '@task-pilot/step-kit';

/** Шаг каталога: реализованный (с модулем) или только запланированный. */
export interface CatalogEntry {
  manifest: StepManifest;
  implemented: boolean;
  module?: StepModule;
  stage: number | null;
}

/** Ошибка загрузки файла каталога. */
export interface CatalogError {
  file: string;
  message: string;
}

/** То, что движку и API нужно от каталога. */
export interface CatalogView {
  entry(id: string): CatalogEntry | undefined;
  entries(): CatalogEntry[];
  preset(id: string): Preset | undefined;
  presets(): Preset[];
  /** Замечания к порядку шагов пресета: ошибки и предупреждения. */
  presetIssues(id: string): PresetOrderIssue[];
  errors(): CatalogError[];
  loadedAt(): string;
}

const plannedFileSchema = z.array(plannedStepSchema);

function readYaml(file: string): unknown {
  return parse(readFileSync(file, 'utf8'));
}

function isStepModule(value: unknown): value is StepModule {
  return !!value && typeof value === 'object' && typeof (value as { run?: unknown }).run === 'function';
}

const hookedDirs = new Set<string>();

/**
 * Хук загрузчика Node: метка перезагрузки ?t= с модуля шага переходит на все его локальные импорты
 * внутри папки steps. Без этого перезагружался бы только index.ts, а вспомогательные файлы шага
 * оставались бы в кэше модулей до перезапуска сервера.
 */
export function installReloadHook(stepsDir: string): void {
  const base = pathToFileURL(stepsDir.endsWith('/') ? stepsDir : `${stepsDir}/`).href;
  if (hookedDirs.has(base)) return;
  hookedDirs.add(base);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const parent = context.parentURL;
      if (!parent?.startsWith(base) || !result.url.startsWith(base) || result.url.includes('?')) return result;
      const t = new URL(parent).searchParams.get('t');
      return t ? { ...result, url: `${result.url}?t=${t}` } : result;
    },
  });
}

/**
 * Каталог шагов и пресетов. Шаг - папка steps/<id> с step.yaml и index.ts; запланированные шаги
 * описаны в steps/_planned.yaml. Папки и файлы, начинающиеся с "_", шагами не считаются.
 * Модули импортируются заново при каждой перезагрузке, поэтому правка шага не требует перезапуска.
 */
export class Catalog extends EventEmitter implements CatalogView {
  private readonly stepsDir: string;
  private readonly pipelinesDir: string;
  private map = new Map<string, CatalogEntry>();
  private presetMap = new Map<string, Preset>();
  private issueMap = new Map<string, PresetOrderIssue[]>();
  private errorList: CatalogError[] = [];
  private loaded = new Date(0).toISOString();
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;

  constructor(stepsDir: string, pipelinesDir: string) {
    super();
    this.stepsDir = stepsDir;
    this.pipelinesDir = pipelinesDir;
    installReloadHook(stepsDir);
  }

  entry(id: string): CatalogEntry | undefined {
    return this.map.get(id);
  }

  entries(): CatalogEntry[] {
    return [...this.map.values()];
  }

  preset(id: string): Preset | undefined {
    return this.presetMap.get(id);
  }

  presets(): Preset[] {
    return [...this.presetMap.values()];
  }

  presetIssues(id: string): PresetOrderIssue[] {
    return this.issueMap.get(id) ?? [];
  }

  errors(): CatalogError[] {
    return this.errorList;
  }

  loadedAt(): string {
    return this.loaded;
  }

  /** Полная перезагрузка каталога. Ошибки отдельных файлов не роняют загрузку остальных. */
  async load(): Promise<void> {
    const map = new Map<string, CatalogEntry>();
    const errors: CatalogError[] = [];
    // Своя метка на каждую загрузку: модули шагов и их локальные импорты читаются заново.
    const stamp = `${Date.now()}${++this.generation}`;

    const plannedFile = join(this.stepsDir, '_planned.yaml');
    if (existsSync(plannedFile)) {
      const r = plannedFileSchema.safeParse(readYaml(plannedFile));
      if (r.success) {
        for (const p of r.data) {
          const manifest: StepManifest = {
            id: p.id,
            title: p.title,
            hint: p.hint,
            phase: p.phase,
            kind: p.kind,
            gate: p.gate,
            requires: [],
            provides: [],
            sideEffects: true,
            interactive: false,
            params: {},
            refresh: [],
            background: false,
          };
          map.set(p.id, { manifest, implemented: false, stage: p.stage });
        }
      } else {
        errors.push({ file: 'steps/_planned.yaml', message: formatZodError(r.error) });
      }
    }

    const dirs = existsSync(this.stepsDir) ? readdirSync(this.stepsDir).filter((d) => !d.startsWith('_')).sort() : [];
    for (const dir of dirs) {
      const base = join(this.stepsDir, dir);
      if (!statSync(base).isDirectory() || !existsSync(join(base, 'step.yaml'))) continue;
      const file = `steps/${dir}/step.yaml`;
      const r = stepManifestSchema.safeParse(readYaml(join(base, 'step.yaml')));
      if (!r.success) {
        errors.push({ file, message: formatZodError(r.error) });
        continue;
      }
      if (r.data.id !== dir) {
        errors.push({ file, message: `id ${r.data.id} не совпадает с именем папки ${dir}` });
        continue;
      }
      const indexFile = join(base, 'index.ts');
      if (!existsSync(indexFile)) {
        errors.push({ file: `steps/${dir}/index.ts`, message: 'нет файла реализации шага' });
        continue;
      }
      try {
        // Параметр t понимают и Node, и Vite в тестах, где другой параметр ломает разбор TypeScript.
        const url = `${pathToFileURL(indexFile).href}?t=${stamp}`;
        const mod = (await import(url)) as { default?: unknown };
        if (!isStepModule(mod.default)) throw new Error('default export должен быть объектом шага с функцией run');
        const planned = map.get(r.data.id);
        map.set(r.data.id, { manifest: r.data, implemented: true, module: mod.default, stage: planned?.stage ?? null });
      } catch (e) {
        errors.push({ file: `steps/${dir}/index.ts`, message: e instanceof Error ? e.message : String(e) });
      }
    }

    // Опечатка в списке петли молча выключила бы повтор шага: движок перезапускает только шаги прогона.
    for (const e of map.values()) {
      const unknown = (e.manifest.loop?.restart ?? []).filter((id) => !map.has(id));
      if (unknown.length) errors.push({ file: `steps/${e.manifest.id}/step.yaml`, message: `петля перезапускает неизвестные шаги: ${unknown.join(', ')}` });
      // Фоновый шаг идет, пока цепочка работает: его петля перезапускала бы шаги цепочки у нее на ходу.
      if (e.manifest.background && e.manifest.loop) errors.push({ file: `steps/${e.manifest.id}/step.yaml`, message: 'фоновый шаг не может быть петлей: петля перезапускает шаги цепочки' });
    }

    // Выход без контракта движок записал бы без проверки: каждый ключ provides реализованного шага описан в step-kit или,
    // если его кладет только этот шаг, в contracts модуля. Свой контракт общего ключа разошелся бы с общим.
    for (const e of map.values()) {
      if (!e.implemented) continue;
      const own = e.module?.contracts ?? {};
      const bare = e.manifest.provides.filter((key) => !CONTEXT_SCHEMAS[key] && !own[key]);
      if (bare.length) {
        errors.push({ file: `steps/${e.manifest.id}/step.yaml`, message: `нет контракта выходов ${bare.join(', ')}: опишите их в packages/step-kit/src/contracts.ts или в contracts модуля шага` });
      }
      const shadow = Object.keys(own).filter((key) => CONTEXT_SCHEMAS[key]);
      if (shadow.length) errors.push({ file: `steps/${e.manifest.id}/index.ts`, message: `контракт уже есть в step-kit, свой не нужен: ${shadow.join(', ')}` });
    }

    const presetMap = new Map<string, Preset>();
    const issueMap = new Map<string, PresetOrderIssue[]>();
    const files = existsSync(this.pipelinesDir) ? readdirSync(this.pipelinesDir).filter((f) => f.endsWith('.yaml')).sort() : [];
    for (const f of files) {
      const r = presetSchema.safeParse(readYaml(join(this.pipelinesDir, f)));
      if (!r.success) {
        errors.push({ file: `pipelines/${f}`, message: formatZodError(r.error) });
        continue;
      }
      const unknown = [...r.data.steps, ...r.data.off].filter((id) => !map.has(id));
      if (unknown.length) {
        errors.push({ file: `pipelines/${f}`, message: `неизвестные шаги: ${unknown.join(', ')}` });
        continue;
      }
      presetMap.set(r.data.id, r.data);
      // Ошибка порядка шагов видна на экране каталога, а пресет остается: прогон на нем остановится на нужном шаге с
      // понятным текстом, а без пресета full не завести ни одного прогона.
      const issues = presetOrderIssues(r.data, (id) => map.get(id)?.manifest);
      issueMap.set(r.data.id, issues);
      const wrong = issues.filter((i) => i.level === 'error');
      if (wrong.length) errors.push({ file: `pipelines/${f}`, message: `порядок шагов: ${wrong.map((i) => i.message).join('; ')}` });
    }

    this.map = map;
    this.presetMap = presetMap;
    this.issueMap = issueMap;
    this.errorList = errors;
    this.loaded = new Date().toISOString();
    this.emit('updated');
  }

  /** Следит за папками шагов и пресетов и перезагружает каталог после правок. */
  watch(): void {
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.load().catch((e) => this.emit('error', e)), 300);
    };
    for (const dir of [this.stepsDir, this.pipelinesDir]) {
      if (existsSync(dir)) this.watchers.push(watch(dir, { recursive: true }, schedule));
    }
  }

  close(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
