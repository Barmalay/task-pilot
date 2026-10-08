/** Маскирование секретов по точному значению во всем, что уходит в логи, события и интерфейс. */
export interface Redactor {
  text(value: string): string;
  deep<T>(value: T): T;
  /** Добавляет секрет, появившийся после запуска: токен, заведенный на экране "Интеграции". */
  add(secret: string): void;
}

const MASK = '***';

/** Создает маскировщик для списка секретов; короткие значения игнорируются, чтобы не портить обычный текст. */
export function createRedactor(secrets: string[]): Redactor {
  let list: string[] = [];
  // Длинные первыми: секрет, внутри которого есть другой, маскируется целиком.
  const set = (all: string[]) => (list = [...new Set(all.filter((s) => s && s.length >= 8))].sort((a, b) => b.length - a.length));
  set(secrets);
  const text = (value: string): string => list.reduce((acc, secret) => acc.split(secret).join(MASK), value);
  const deep = <T>(value: T): T => {
    if (typeof value === 'string') return text(value) as T;
    if (Array.isArray(value)) return value.map((v) => deep(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deep(v)])) as T;
    }
    return value;
  };
  return { text, deep, add: (secret) => void set([...list, secret]) };
}
