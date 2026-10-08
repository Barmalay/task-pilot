import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/config.ts';

const HOOK = join(ROOT, '.githooks', 'pre-commit');

/**
 * Хук с подменным pnpm первым в PATH: pnpm дописывает свои аргументы в файл, записывает переменные GIT_* и выходит с
 * кодом, заданным для команды: check печатает output, smoke - строку итога смоука. Хуку передаются переменные, которые
 * git ставит при коммите.
 */
function runHook(code: number, output = '', smoke = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'task-pilot-hook-'));
  const argsFile = join(dir, 'args.txt');
  const envFile = join(dir, 'env.txt');
  const pnpm = join(dir, 'pnpm');
  writeFileSync(
    pnpm,
    `#!/bin/sh\necho "$@" >> "${argsFile}"\nenv | grep '^GIT_' > "${envFile}"\nif [ "$1" = check ]; then printf '%s\\n' "${output}"; exit ${code}; fi\nprintf '%s\\n' 'Смоук интерфейса: экранов 8, с ошибками ${smoke ? 1 : 0}, 8 с'\nexit ${smoke}\n`,
  );
  chmodSync(pnpm, 0o755);
  const git = { GIT_INDEX_FILE: '/repo/.git/index', GIT_AUTHOR_NAME: 'owner', GIT_CONFIG_PARAMETERS: "'user.name=owner'", GIT_PREFIX: '' };
  const r = spawnSync('/bin/sh', [HOOK], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...git, PATH: `${dir}:${process.env.PATH ?? ''}`, TMPDIR: dir } });
  return { status: r.status, stderr: r.stderr, args: readFileSync(argsFile, 'utf8').trim(), gitEnv: readFileSync(envFile, 'utf8').trim() };
}

describe('local CI before a commit', () => {
  it('lets the commit through when pnpm check and the smoke of the interface are green and shows both results', () => {
    const r = runHook(0, ' Tests  642 passed | 1 skipped (643)');
    expect(r.status).toBe(0);
    expect(r.args).toBe('check\nsmoke');
    expect(r.stderr).toContain('Tests  642 passed');
    expect(r.stderr).toContain('Смоук интерфейса: экранов 8, с ошибками 0');
  });

  it('runs the check without the variables git gives the hook, so tests with their own repositories use their own index', () => {
    expect(runHook(0).gitEnv).toBe('');
  });

  it('cancels the commit when pnpm check fails and shows the end of its output, without running the smoke', () => {
    const r = runHook(1, 'FAIL apps/server/test/x.test.ts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('коммит отменен');
    expect(r.stderr).toContain('FAIL apps/server/test/x.test.ts');
    expect(r.args).toBe('check');
  });

  it('cancels the commit when the smoke of the interface finds an error and shows its output', () => {
    const r = runHook(0, ' Tests  642 passed (642)', 1);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('смоук интерфейса не прошел, коммит отменен');
    expect(r.stderr).toContain('Смоук интерфейса: экранов 8, с ошибками 1');
  });

  it('is executable and turned on by pnpm install through core.hooksPath', () => {
    expect(statSync(HOOK).mode & 0o111).not.toBe(0);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepare).toBe('git config core.hooksPath .githooks || true');
  });
});
