import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { RepoProfile, StepContext, TextStyle } from '../../packages/step-kit/src/index.ts';
import { isJavaBuild } from '../../packages/step-kit/src/index.ts';

/** Текст файла рядом с модулем шага; читается при каждом запуске, поэтому правка промпта не требует перезапуска. */
export function readText(base: string | URL, name: string): string {
  return readFileSync(new URL(name, base), 'utf8');
}

/** Правило личного стиля для агента: что линтер все равно исправит в его текстах; без стиля - пусто. */
export function styleRule(style: TextStyle): string {
  const parts = [style.yo ? 'без буквы е с точками' : '', style.dash ? 'без длинного тире' : '', style.quotes ? 'с прямыми кавычками' : ''].filter(Boolean);
  return parts.length ? `- Тексты пиши ${parts.join(', ')}.` : '';
}

/**
 * Правила для промпта агента: общие правила конвейера, шагам, которые меняют код, - правила про тесты и план, и затем
 * правила текстов команды (rules.md ее пакета) и личного стиля.
 */
export function agentRules(c: Pick<StepContext, 'texts'>, code = false): string {
  const rules = readText(import.meta.url, './rules.md');
  const base = code ? `${rules}\n${readText(import.meta.url, './rules-code.md')}` : rules;
  const own = [styleRule(c.texts.style), c.texts.rules.trim()].filter(Boolean).join('\n');
  return own ? `${base}\n## Правила текстов команды и личные\n\n${own}\n` : base;
}

/** Инструменты MCP-сервера Jira и Confluence для агента: имя сервера задает профиль доски (jira.yaml слоев). */
export function jiraTools(c: Pick<StepContext, 'jira'>, tools: string[]): string[] {
  return tools.map((t) => `mcp__${c.jira.mcp}__${t}`);
}

/** Команды git только на чтение. */
export const GIT_READ = [
  'Bash(git status)',
  'Bash(git status *)',
  'Bash(git diff)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git blame *)',
  'Bash(git ls-files *)',
  'Bash(git merge-base *)',
  'Bash(git rev-parse *)',
  'Bash(git rev-list *)',
];

/** Окружение сборки: JAVA_HOME из профиля репозитория и его bin первым в PATH. */
export function buildEnv(repo: RepoProfile): Record<string, string> {
  const javaHome = repo.build?.javaHome;
  return javaHome ? { JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${process.env.PATH ?? ''}` } : {};
}

/** Разрешение агенту на программу сборки из профиля с любыми аргументами. */
export function buildRule(repo: RepoProfile): string[] {
  const program = repo.build?.command.trim().split(/\s+/)[0];
  return program ? [`Bash(${program} *)`] : [];
}

/**
 * Команда сборки и тестов из профиля. Сборка Java без JDK (build.javaHome профиля репозитория или javaHome личных
 * настроек) - ошибка конфигурации.
 */
export function buildCommand(repo: RepoProfile): string {
  const command = repo.build?.command;
  if (!command) throw new Error(`В профиле репозитория ${repo.id} нет команды сборки (build.command)`);
  if (isJavaBuild(command) && !repo.build?.javaHome) {
    throw new Error(`Для сборки Java в репозитории ${repo.id} нужен JDK 21: укажите javaHome в личных настройках ~/.task-pilot/profile.yaml, иначе сборка пойдет под JDK по умолчанию`);
  }
  return command;
}

/** Рабочая папка ветки задачи из контекста прогона. */
export function worktreeOf(c: StepContext): string {
  const worktree = c.get<string>('worktree');
  if (!worktree) throw new Error('Нет рабочей папки ветки: сначала нужен шаг "Ветка"');
  if (!existsSync(worktree)) throw new Error(`Рабочей папки ${worktree} нет: повторите шаг "Ветка"`);
  return worktree;
}

/** sha256 текста в hex. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Файлы папки с хэшами содержимого по относительному пути. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files.set(relative(root, full), createHash('sha256').update(readFileSync(full)).digest('hex'));
  }
  return files;
}

/**
 * Готовит папку доков для агента: копирует в нее текущие доки задачи, чтобы агент мог их обновить.
 * CLI не дает агенту писать в папки .claude, поэтому агенту дается копия, а back() после успешной
 * работы агента возвращает в настоящую папку доков задачи только те файлы, которые агент изменил или создал:
 * фоновый шаг работает, пока цепочка пишет свои доки, и копия целиком затерла бы их прежней версией.
 */
export function stageDocs(c: StepContext): { dir: string; back(): void } {
  const dir = c.paths.agentDocs;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (existsSync(c.paths.docs)) cpSync(c.paths.docs, dir, { recursive: true });
  const before = snapshot(dir);
  return {
    dir,
    back() {
      mkdirSync(c.paths.docs, { recursive: true });
      for (const [file, hash] of snapshot(dir)) {
        if (before.get(file) === hash) continue;
        mkdirSync(dirname(join(c.paths.docs, file)), { recursive: true });
        cpSync(join(dir, file), join(c.paths.docs, file));
      }
    },
  };
}

/** Коммит, от которого ветка задачи отошла от базовой ветки. */
export async function mergeBase(c: StepContext, cwd: string): Promise<string> {
  const base = `${c.repo.remote}/${c.repo.baseBranch}`;
  return (await c.ports.git.run(cwd, ['merge-base', 'HEAD', base])).stdout.trim();
}
