import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Автор коммитов во временных репозиториях тестов. */
export function gitIdentity(): void {
  process.env.GIT_AUTHOR_NAME = 'test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.org';
  process.env.GIT_COMMITTER_NAME = 'test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.org';
}

/** git в папке теста; ошибка команды роняет тест. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Пишет файл, создавая папки. */
export function write(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

/** Коммит файла. */
export function commit(dir: string, file: string, content: string, message = `change ${file}`): void {
  write(dir, file, content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
}

/**
 * Репозиторий с remote: origin (bare) с master и рабочая папка ветки feature/<KEY>, отведенной
 * от origin/master. realpath: на macOS tmpdir лежит под символической ссылкой /var.
 */
export function branchRepo(key: string, files: Record<string, string> = { 'README.md': 'demo\n' }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-pilot-step-')));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  const work = join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  for (const [file, content] of Object.entries(files)) write(work, file, content);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', 'origin', 'master');
  git(work, 'switch', '-q', '-c', `feature/${key}`);
  return { root, origin, work };
}
