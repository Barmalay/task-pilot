import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Набор тестов из отчета surefire. */
export interface Suite {
  name: string;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

/** Папки отчетов: корень проекта и модули первого уровня. */
function reportDirs(root: string): string[] {
  const dirs = [join(root, 'target', 'surefire-reports')];
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    if (entry.startsWith('.') || entry === 'target' || entry === 'src') continue;
    const dir = join(root, entry, 'target', 'surefire-reports');
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs.filter((d) => existsSync(d) && statSync(d).isDirectory());
}

/**
 * Разбирает TEST-*.xml; null - это не отчет surefire. Счетчики заголовка testsuite бывают занижены:
 * для классов с @Nested surefire пишет tests="0", хотя testcase в файле есть. Поэтому берется
 * максимум из заголовка и числа элементов в теле; вывод тестов в CDATA при подсчете не учитывается.
 */
export function parseSuite(xml: string): Suite | null {
  const tag = xml.match(/<testsuite\b([^>]*)>/)?.[1];
  if (tag === undefined) return null;
  const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!attrs.name) return null;
  const body = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const count = (re: RegExp) => body.match(re)?.length ?? 0;
  const num = (name: string, re: RegExp) => Math.max(Number(attrs[name] ?? 0) || 0, count(re));
  return {
    name: attrs.name,
    tests: num('tests', /<testcase\b/g),
    failures: num('failures', /<failure\b/g),
    errors: num('errors', /<error\b/g),
    skipped: num('skipped', /<skipped\b/g),
  };
}

/** Все наборы тестов последней сборки. */
export function readSurefire(root: string): Suite[] {
  const suites: Suite[] = [];
  for (const dir of reportDirs(root)) {
    for (const f of readdirSync(dir)) {
      if (!/^TEST-.*\.xml$/.test(f)) continue;
      const s = parseSuite(readFileSync(join(dir, f), 'utf8'));
      if (s) suites.push(s);
    }
  }
  return suites.sort((a, b) => a.name.localeCompare(b.name));
}

/** Удаляет отчеты перед сборкой: сборка, упавшая до тестов, иначе оставила бы старые зеленые отчеты. */
export function clearSurefire(root: string): void {
  for (const dir of reportDirs(root)) rmSync(dir, { recursive: true, force: true });
}

/**
 * true, если в исходнике есть запускаемые тесты: аннотация теста JUnit и конкретный класс.
 * Базовые абстрактные классы, интерфейсы и вспомогательные классы отчета surefire не дают.
 */
export function declaresTests(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (!/@(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(code)) return false;
  return !/\babstract\s+class\b|@interface\b|\binterface\s+\w+/.test(code);
}

/**
 * Класс теста по пути файла, если surefire запускает его по умолчанию:
 * src/test/java/ru/x/FooTest.java - ru.x.FooTest. Имена Test*, *Test, *Tests и *TestCase.
 */
export function testClassOf(path: string): string | null {
  const m = path.match(/(?:^|\/)src\/test\/java\/(.+)\.java$/);
  if (!m) return null;
  const cls = m[1]!.replace(/\//g, '.');
  const simple = cls.split('.').pop()!;
  return /^Test|Test$|Tests$|TestCase$/.test(simple) ? cls : null;
}
