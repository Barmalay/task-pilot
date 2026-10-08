import { spawn } from 'node:child_process';

/** Хранилище токенов, заведенных на экране "Интеграции". В базе Task Pilot лежат только подписи к ним. */
export interface SecretStore {
  /** Где лежат токены, в предложном падеже: "Keychain macOS", "памяти демо". */
  readonly where: string;
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Код выхода security, когда записи нет. */
const NOT_FOUND = 44;
/** Имя записи в Keychain: только такие символы идут в команды security без кавычек. */
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const TIMEOUT_MS = 15_000;

/** Настройки хранилища в Keychain. */
export interface KeychainOptions {
  /** Имя службы записей в Keychain. */
  service?: string;
  /** Путь к security: в тестах его подменяет скрипт. */
  security?: string;
}

function safe(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Недопустимое имя записи Keychain: ${id}`);
  return id;
}

function run(security: string, args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(security, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    // Если security не запустился, запись в его stdin тоже падает: причина придет событием error процесса.
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/**
 * Токены в Keychain macOS через /usr/bin/security. Значение записывается командой из stdin в интерактивном
 * режиме security и в шестнадцатеричном виде, поэтому не попадает ни в аргументы процесса, ни в разбор кавычек.
 * Запись, созданную security, он же и читает без вопроса владельцу.
 */
export function keychainSecrets(o: KeychainOptions = {}): SecretStore {
  const service = safe(o.service ?? 'task-pilot');
  const security = o.security ?? '/usr/bin/security';
  const get = async (id: string): Promise<string | null> => {
    const r = await run(security, ['find-generic-password', '-s', service, '-a', safe(id), '-w']);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`Keychain не отдал токен ${id}: ${r.stderr.trim() || `код ${r.code}`}`);
    return r.stdout.replace(/\n$/, '');
  };
  return {
    where: 'Keychain macOS',
    get,
    async set(id, value) {
      const hex = Buffer.from(value, 'utf8').toString('hex');
      await run(security, ['-i'], `add-generic-password -U -s ${service} -a ${safe(id)} -X ${hex}\n`);
      // В интерактивном режиме код выхода не говорит об ошибке команды, а ее вывод может повторить команду с
      // токеном: запись сверяется чтением, и вывод в сообщение не идет.
      if ((await get(id)) !== value) throw new Error(`Keychain не сохранил токен ${id}: запись не читается`);
    },
    async remove(id) {
      const r = await run(security, ['delete-generic-password', '-s', service, '-a', safe(id)]);
      if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`Keychain не удалил токен ${id}: ${r.stderr.trim() || `код ${r.code}`}`);
    },
  };
}

/** Токены в памяти процесса: демо и тесты не трогают Keychain. */
export function memorySecrets(where = 'памяти процесса'): SecretStore {
  const values = new Map<string, string>();
  return {
    where,
    async get(id) {
      return values.get(id) ?? null;
    },
    async set(id, value) {
      values.set(id, value);
    },
    async remove(id) {
      values.delete(id);
    },
  };
}
