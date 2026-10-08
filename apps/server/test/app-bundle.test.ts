import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/config.ts';

const source = readFileSync(join(ROOT, 'launcher/TaskPilot.swift'), 'utf8');
const install = readFileSync(join(ROOT, 'launcher/install.sh'), 'utf8');
const PLACEHOLDERS = ['__NODE__', '__LAUNCHER__', '__UI_LOCALHOST__', '__UI__'];

/** Компилятор Swift из Command Line Tools: без него сборка приложения не проверяется. */
function hasSwift(): boolean {
  if (process.platform !== 'darwin') return false;
  return spawnSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status === 0;
}

describe('app for the Dock', () => {
  it('fills every placeholder of the app source at build time', () => {
    for (const p of PLACEHOLDERS) {
      expect(source).toContain(`"${p}"`);
      expect(install).toContain(`s|${p}|`);
    }
    expect(install).toContain('launcher/TaskPilot.swift');
  });

  it.skipIf(!hasSwift())('compiles: the Swift source of the app window typechecks against the macOS SDK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pilot-app-'));
    try {
      const filled = PLACEHOLDERS.reduce((s, p) => s.replaceAll(p, p === '__NODE__' ? '/usr/bin/true' : 'http://127.0.0.1:5177/'), source);
      writeFileSync(join(dir, 'main.swift'), filled);
      execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-typecheck', join(dir, 'main.swift')], { stdio: 'pipe', timeout: 180_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 200_000);
});
