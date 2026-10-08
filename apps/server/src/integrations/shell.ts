import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ShellPort } from '@task-pilot/step-kit';
import { childEnv } from '../lib/env.ts';
import type { Sandbox } from './sandbox.ts';

const TAIL_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const STOP_GRACE_MS = 5000;

/** Песочница, в которой оболочка запускает команды сборки. */
export interface ShellOptions {
  sandbox: Sandbox;
}

/**
 * Порт оболочки: команда из профиля репозитория выполняется через /bin/sh в песочнице (`Sandbox`) и в своей
 * группе процессов, чтобы таймаут и остановка владельцем завершали и дочерние процессы (JVM сборки).
 * Код сборки ветки недоверенный: его пишет агент, поэтому без песочницы команда не запускается вовсе.
 * В памяти держится хвост вывода, полный вывод пишется в logFile.
 */
export function createShell({ sandbox }: ShellOptions): ShellPort {
  return {
    run(command, options) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        if (!sandbox.available()) {
          reject(new Error(`Песочница сборки недоступна: ${sandbox.missing}, команда не запускалась`));
          return;
        }
        let log: ReturnType<typeof createWriteStream> | null = null;
        if (options.logFile) {
          mkdirSync(dirname(options.logFile), { recursive: true });
          log = createWriteStream(options.logFile, { flags: 'w' });
          log.on('error', () => {});
        }
        const { program, args } = sandbox.wrap(command, { cwd: options.cwd, writeDirs: options.writeDirs ?? [] });
        const child = spawn(program, args, {
          cwd: options.cwd,
          env: childEnv(process.env, options.env ?? {}),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        let tail = '';
        let timedOut = false;
        let aborted = false;
        const onData = (chunk: Buffer) => {
          log?.write(chunk);
          tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const stop = () => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            return;
          }
          setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {
              // процесс уже завершился
            }
          }, STOP_GRACE_MS).unref();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const onAbort = () => {
          aborted = true;
          stop();
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        const done = (code: number) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          log?.end();
          resolve({ code, output: tail, durationMs: Date.now() - started, timedOut, aborted });
        };
        child.on('error', (e) => {
          tail += `\n${e.message}`;
          done(127);
        });
        child.on('close', (code) => done(code ?? 1));
      });
    },
  };
}
