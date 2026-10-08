import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Команда в песочнице: программа и аргументы, которые запускает оболочка. */
export interface SandboxedCommand {
  program: string;
  args: string[];
}

/**
 * Песочница команд сборки. Код ветки пишет агент, поэтому команда идет без сети, кроме localhost, пишет только в свои
 * папки и не читает файлы с токенами. Реализация зависит от системы; сейчас есть macOS Seatbelt (`seatbeltSandbox`).
 */
export interface Sandbox {
  /** Есть ли песочница на этой машине: без нее оболочка команду не запускает. */
  available(): boolean;
  /** Чего не хватает, когда песочницы нет: для ошибки оболочки и проверки окружения. */
  readonly missing: string;
  /** Команда `/bin/sh -c command` внутри песочницы: писать можно в cwd и writeDirs. */
  wrap(command: string, opts: { cwd: string; writeDirs: string[] }): SandboxedCommand;
}

/** Где живут владелец и служебные файлы инструмента: от этого зависит профиль песочницы. */
export interface SandboxOptions {
  home: string;
  dataDir: string;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function quote(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function regexEscape(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/"/g, '\\"');
}

/**
 * Профиль macOS Seatbelt для сборки. Сеть закрыта, кроме localhost и unix-сокетов: тестам нужны
 * локальные серверы, а Mockito подключает агент к своей JVM через unix-сокет. Правило (local ip ...)
 * для исходящих соединений не используется: вместе с DNS через unix-сокет оно пропускает любой трафик.
 * Писать можно в рабочую папку, writeDirs, ~/.m2 и временные папки; файлы с токенами и служебная
 * папка инструмента не читаются.
 */
export function sandboxProfile(opts: { cwd: string; writeDirs: string[]; home: string; dataDir: string }): string {
  const home = real(opts.home);
  const writable = [opts.cwd, ...opts.writeDirs, join(home, '.m2'), '/private/tmp', '/private/var/folders', '/dev'].map(real);
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-bind (local unix-socket))',
    '(allow network-inbound (local unix-socket))',
    '(allow network-outbound (remote unix-socket))',
    '(deny file-write*)',
    `(allow file-write* ${[...new Set(writable)].map((p) => `(subpath ${quote(p)})`).join(' ')})`,
    `(deny file-read* (regex #"^${regexEscape(join(home, '.claude.json'))}") (subpath ${quote(join(home, '.claude', 'backups'))}) (subpath ${quote(real(opts.dataDir))}))`,
  ].join('\n');
}

/** Песочница macOS Seatbelt: `sandbox-exec` (путь exec) с профилем `sandboxProfile`. */
export function seatbeltSandbox(o: SandboxOptions, exec = SANDBOX_EXEC): Sandbox {
  return {
    available: () => existsSync(exec),
    missing: `нет ${exec}`,
    wrap: (command, { cwd, writeDirs }) => ({ program: exec, args: ['-p', sandboxProfile({ cwd, writeDirs, home: o.home, dataDir: o.dataDir }), '/bin/sh', '-c', command] }),
  };
}
