import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { patchHunks, type BrowserPort } from '@task-pilot/step-kit';
import { isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import type { AgentRunner, ClaudeResult } from '../agent/claude.ts';

/** Калькулятор учебного проекта после задачи DEMO-1: сложение и разность. */
export const CALCULATOR = `package demo;

/** Калькулятор целых чисел. */
public class Calculator {

    /** Сумма двух чисел. */
    public int add(int a, int b) {
        return a + b;
    }

    /** Разность двух чисел: a минус b. */
    public int subtract(int a, int b) {
        return a - b;
    }
}
`;

/** Тест калькулятора после задачи DEMO-1, с отрицательной разностью. */
export const CALCULATOR_TEST = `package demo;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalculatorTest {

    @Test
    void addsTwoNumbers() {
        assertEquals(5, new Calculator().add(2, 3));
    }

    @Test
    void subtractsTwoNumbers() {
        assertEquals(2, new Calculator().subtract(5, 3));
        assertEquals(-2, new Calculator().subtract(3, 5));
    }
}
`;

/** План DEMO-1, как его пишет агент анализа: разделы, таблица, код и открытые вопросы владельцу. */
const DEMO_PLAN = `# DEMO-1 - вычитание в калькуляторе

## Постановка

Калькулятору нужен метод разности двух чисел; критерии приемки - три AC задачи.

## Решение

| Что | Где | Как проверить |
|---|---|---|
| метод \`subtract(a, b)\` | \`Calculator.java\` | тест на положительную и отрицательную разность |
| Javadoc метода | \`Calculator.java\` | ревью |

\`\`\`java
public int subtract(int a, int b) {
    return a - b;
}
\`\`\`

## Открытые вопросы владельцу

1. Нужен ли тест на вычитание отрицательных чисел?
2. Дописать вычитание в README?
`;

const DEMO_QUESTIONS = ['Нужен ли тест на вычитание отрицательных чисел?', 'Дописать вычитание в README?'];

/** Страница вики по учебной задаче в разметке эталона: факты помечены, откуда они. */
const DEMO_WIKI_PAGE = `# Калькулятор: разность

## Что сделано

Калькулятор считает разность двух чисел методом \`Calculator.subtract\` (код-подтверждено, src/main/java/demo/Calculator.java). Разность может быть отрицательной: \`subtract(3, 5)\` возвращает -2 (код-подтверждено тестом \`CalculatorTest.subtractsTwoNumbers\`).

## Проверка на стенде

Вычитание проверено на учебном стенде по трем критериям приемки, итоги с кадрами - в комментарии задачи (подтверждено скрином со стенда).
`;

/** Дашборд, который шаг "Дашборд задачи" получает в демо: строки учебного калькулятора в его логах. */
function demoDashboard(key: string): string {
  return `# Дашборд задачи ${key}: формат описан в docs/dashboards.md.
id: ${key.toLowerCase()}-calculator
title: Калькулятор - вычитание
description: >-
  Сколько вычитаний считает калькулятор, сколько из них падает и свежие строки.
task: ${key}
service: calculator
headline: [subtract, errors]
panels:
  - id: subtract
    title: Вычитания
    hint: 'Строка "Calculator subtract: a=..., b=..."'
    type: timeseries
    match: ['Calculator subtract']
  - id: errors
    title: Ошибки вычитания
    type: stat
    match: ['Calculator subtract failed']
  - id: lines
    title: Свежие строки калькулятора
    type: lines
    match: ['Calculator subtract']
alerts:
  - id: no-subtract
    panel: subtract
    when: zero
    window: 15m
`;
}

/** Панель, которую демо-агент добавляет по замечанию владельца. */
const DEMO_ERRORS_SHARE = `  - id: errors-share
    title: Доля ошибок вычитания
    type: share
    part:
      match: ['Calculator subtract failed']
    of:
      match: ['Calculator subtract']
alerts:
`;

/**
 * Правка мониторинга по просьбе в демо: у дашборда добавляется панель доли (вторая панель от первой) или по просьбе
 * убрать - последняя панель, у фичи порог автоматов становится 4, у пути скрывается служебная строка запроса в шлюз.
 * Комментарии файла остаются: правка идет по документу YAML.
 */
const STYLE = { flowCollectionPadding: false };

function demoEdit(source: string, ask: string): { source: string; summary: string } {
  const doc = parseDocument(source);
  const panels = doc.get('panels') as YAMLSeq | undefined;
  if (panels && isSeq(panels)) {
    if (/убер|удал|скро/i.test(ask) && panels.items.length > 1) {
      const last = panels.items.pop() as YAMLMap;
      return { source: doc.toString(STYLE), summary: `Убрана панель "${String(last.get('title'))}"` };
    }
    const list = panels.toJSON() as { title: string; match?: string[] }[];
    const of = list[0]?.match ?? [];
    const part = list[1]?.match ?? of;
    panels.add(doc.createNode({ id: 'share', title: `Доля: ${(list[1]?.title ?? 'строки').toLowerCase()}`, type: 'share', part: { match: part }, of: { match: of } }));
    return { source: doc.toString(STYLE), summary: `Добавлена панель доли "${(list[1]?.title ?? 'строки').toLowerCase()}" от "${(list[0]?.title ?? 'строк').toLowerCase()}"` };
  }
  if (doc.has('stages')) {
    doc.setIn(['automation', 'threshold'], 4);
    return { source: doc.toString(STYLE), summary: 'Порог автоматов снижен до 4 повторов' };
  }
  const events = doc.get('events') as YAMLSeq | undefined;
  if (events && isSeq(events)) {
    events.items = events.items.filter((e) => (e as YAMLMap).get('key') !== 'request');
    return { source: doc.toString(STYLE), summary: 'Убрано правило "Запрос в шлюз": такие строки идут без разбора' };
  }
  return { source, summary: 'Нечего менять' };
}

/** Шаг, который мастер "Новый шаг" пишет в демо: манифест, код и тест. */
const DEMO_STEP: Record<string, string> = {
  'steps/demo.greet/step.yaml': `id: demo.greet
title: Приветствие
hint: "Пишет в ленту приветствие с ключом задачи: учебный шаг мастера"
phase: meta
kind: code
provides: [greeting]
sideEffects: false
`,
  'steps/demo.greet/index.ts': `import type { StepModule } from '../../packages/step-kit/src/index.ts';
import { z } from '../../packages/step-kit/src/index.ts';

/** Учебный шаг мастера: пишет в ленту приветствие с ключом задачи и кладет его в контекст. */
const step: StepModule = {
  async run(c) {
    const greeting = \`Привет, \${c.run.issueKey}\`;
    c.log(greeting);
    return { greeting };
  },
  // Приветствие - новый ключ контекста, его кладет только этот шаг: контракт описан здесь.
  contracts: { greeting: z.string() },
};

export default step;
`,
  'steps/demo.greet/demo.greet.test.ts': `import { describe, expect, it } from 'vitest';
import { testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

describe('demo.greet', () => {
  it('greets the task in the feed and gives the greeting to the next steps', async () => {
    const c = testContext({ issueKey: 'DEMO-1', repo: testRepo('/repo', '/wt'), ports: {} });
    expect(await step.run(c)).toEqual({ greeting: 'Привет, DEMO-1' });
    expect(c.logs).toEqual(['Привет, DEMO-1']);
  });
});
`,
};

type Shot = 'pass' | 'fail' | 'logs';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/**
 * Условный скриншот для демо: PNG со шапкой, плашкой итога (зеленой или красной) и строками текста, у кадра
 * Kibana темный фон. Настоящие кадры снимает QA-браузер, а здесь важно, чтобы галерея и Jira получили картинку.
 */
export function demoShot(kind: Shot): Buffer {
  const w = 480;
  const h = 300;
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  const back = kind === 'logs' ? [15, 23, 42] : [248, 250, 252];
  const mark = kind === 'fail' ? [220, 38, 38] : kind === 'pass' ? [22, 163, 74] : [56, 189, 248];
  const text = kind === 'logs' ? [100, 116, 139] : [203, 213, 225];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const line = y >= 150 && (y - 150) % 30 < 10 && x >= 24 && x < 456 - Math.floor((y - 150) / 30) * 90;
      const c = y < 36 ? [30, 41, 59] : y >= 60 && y < 120 && x >= 24 && x < 456 ? mark : line ? text : back;
      raw.set(c, y * row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** QA-браузер демо и тестов: окна не открывает, кадры сценарный агент кладет в папку артефактов сам. */
export const demoBrowser: BrowserPort = {
  port: 0,
  ensure: async () => ({ started: false }),
  act: async () => '',
  kibanaLogs: async () => '',
};

/**
 * Агент без CLI для демо и сквозных тестов: по заданию шага делает то, что сделал бы настоящий, и возвращает итог
 * по схеме. С bug реализация теряет знак разности, первый тест на стенде это находит, а доработка по тесту исправляет.
 * На замечание ревьюера демо агент дополняет тест вычитанием нуля и отвечает на каждое замечание, по изменениям задачи
 * и по замечанию к плану дописывает план, страницу вики пишет по учебной задаче, разбор прогона предлагает правило про
 * знак разности в промпт доработки по тесту и в учебный скилл, а мастер "Новый шаг" пишет учебный шаг demo.greet с
 * тестом.
 */
const DEMO_STATE: Record<string, [string, string]> = {
  running: ['выполняется', 'Дождитесь конца шага: если тишина затянется, остановите прогон и повторите шаг кнопкой "Повторить".'],
  waiting_owner: ['ждет вашего подтверждения', 'Откройте подтверждение главной кнопкой или кнопкой "Подтвердить" в строке шага.'],
  waiting: ['ждет события снаружи', 'Наблюдатель продолжит сам; проверить сейчас можно главной кнопкой.'],
  failed: ['упал', 'Повторите шаг, а если агенту нужно что-то сказать, повторите "С замечанием".'],
  blocked: ['заблокирован', 'Включите шаг, который дает нужный ключ, или пропустите этот шаг.'],
};

/**
 * Ответ демо на вопрос о прогоне: шаг, на котором прогон сейчас, по строкам шагов задания, и его последнее событие
 * ленты. Настоящий агент читает еще код шага и рабочую папку.
 */
function demoAnswer(prompt: string): string {
  const step = [...prompt.matchAll(/^\d+\. (\S+) "([^"]+)": (\w+)/gm)].find((m) => DEMO_STATE[m[3]!]);
  if (!step) return 'Прогон сейчас не идет: отмеченные шаги выполнены или ждут запуска. Запустите их главной кнопкой.\n\n_Ответ демо._';
  const [, id, title, status] = step;
  const last = [...prompt.matchAll(new RegExp(`^\\S+ \\S+ \\[${id!.replace(/\./g, '\\.')}\\] (.+)$`, 'gm'))].at(-1)?.[1];
  const [state, advice] = DEMO_STATE[status!]!;
  return [`**Что происходит.** Шаг "${title}" ${state}.${last ? ` Последнее событие шага в ленте: ${last}.` : ''}`, '', `**Что сделать.** ${advice}`, '', '_Ответ демо: настоящий агент читает еще код шага и рабочую папку задачи._'].join('\n');
}

export function scriptedAgent(scenario: { bug?: boolean } = {}): { runner: AgentRunner; prompts: string[] } {
  const prompts: string[] = [];
  const runner: AgentRunner = {
    async run(input) {
      const prompt = input.args[input.args.indexOf('-p') + 1]!;
      const dirs = input.args.filter((_a, i) => input.args[i - 1] === '--add-dir');
      const sessionId = input.args[input.args.indexOf('--session-id') + 1] ?? input.args[input.args.indexOf('--resume') + 1]!;
      prompts.push(prompt);
      input.onEvent({ kind: 'init', sessionId, model: 'scripted' });
      let calls = 0;
      // Запись файла, как ее делает настоящий агент: файл меняется, в журнал потока идут вызов Write и ответ с диффом,
      // в ленту - событие вызова, поэтому подробности правки открываются в ленте и в демо.
      const write = (file: string, text: string) => {
        const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        const id = `toolu_demo_${sessionId.slice(0, 8)}_${++calls}`;
        const call = { file_path: file, content: text };
        const lines = [
          { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: call }] } },
          {
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: id, content: before === null ? `File created successfully at: ${file}` : `The file ${file} has been updated.` }] },
            tool_use_result: { type: before === null ? 'create' : 'update', filePath: file, content: text, structuredPatch: patchHunks(before ?? '', text) },
          },
        ];
        appendFileSync(input.logFile, lines.map((l) => `${input.redact(JSON.stringify(l))}\n`).join(''));
        input.onEvent({ kind: 'tool', id, name: 'Write', input: call });
      };
      let output: unknown;
      let text = 'готово';
      if (prompt.startsWith('Правка мониторинга Task Pilot')) {
        // Правка мониторинга по просьбе: агент возвращает новый текст файла, на диск ничего не пишет.
        const source = /<файл>\n([\s\S]*?)\n<\/файл>/.exec(prompt)?.[1] ?? '';
        output = demoEdit(`${source}\n`, [...prompt.matchAll(/^Владелец: (.+)$/gm)].at(-1)?.[1] ?? '');
      } else if (prompt.startsWith('Вопрос владельца о прогоне')) {
        // Вопрос о прогоне: ответ по шагу, на котором прогон сейчас, и его последнему событию из задания.
        text = demoAnswer(prompt);
      } else if (prompt.includes('шаг "Доработка задачи"')) {
        // Задача изменилась в Jira: агент дописывает к плану раздел доработки, код не трогает.
        const file = join(dirs[0]!, 'plan.md');
        const plan = existsSync(file) ? readFileSync(file, 'utf8').trimEnd() : '# План\n\nДобавить метод subtract и тест на разность.';
        write(file, `${plan}\n\n## Доработка\n\nПостановка изменилась в Jira: план сверен с задачей, код и тесты проходят цикл заново.\n`);
        output = { summary: 'План сверен с изменениями задачи: цикл проходит заново', questions: [] };
      } else if (prompt.includes('Владелец прочитал план и просит доработать его')) {
        // Замечание к плану (анализа или доработки задачи) дописывается в план разделом.
        const file = join(dirs[0]!, 'plan.md');
        const remark = /<замечание>\s*([\s\S]*?)\s*<\/замечание>/.exec(prompt)?.[1] ?? '';
        write(file, `${existsSync(file) ? readFileSync(file, 'utf8').trimEnd() : '# План'}\n\n## По замечанию\n\n${remark}\n`);
        output = { summary: 'План дополнен по замечанию владельца', questions: [] };
      } else if (prompt.includes('шаг "Анализ и план"')) {
        write(join(dirs[0]!, 'plan.md'), DEMO_PLAN);
        output = { summary: 'Добавить `Calculator.subtract` с Javadoc и тестом на разность; два вопроса владельцу в конце плана', questions: DEMO_QUESTIONS };
      } else if (prompt.includes('шаг "Ответ на ревью"')) {
        // Замечание ревьюера демо просит тест на вычитание нуля: агент добавляет проверку и отвечает на каждое.
        write(join(input.cwd, 'src/test/java/demo/CalculatorTest.java'), CALCULATOR_TEST.replace('        assertEquals(-2, new Calculator().subtract(3, 5));\n', '        assertEquals(-2, new Calculator().subtract(3, 5));\n        assertEquals(5, new Calculator().subtract(5, 0));\n'));
        const ids = [...prompt.matchAll(/Замечание (\d+)/g)].map((m) => Number(m[1]));
        output = {
          replies: ids.map((commentId) => ({ commentId, text: 'Добавил в тест вычитание нуля: subtract(5, 0).', fixed: true })),
          summary: 'Тест дополнен вычитанием нуля',
          files: ['src/test/java/demo/CalculatorTest.java'],
          tests: ['src/test/java/demo/CalculatorTest.java'],
          buildGreen: true,
        };
      } else if (prompt.includes('шаг "Доработка по тесту"')) {
        write(join(input.cwd, 'src/main/java/demo/Calculator.java'), CALCULATOR);
        write(join(input.cwd, 'src/test/java/demo/CalculatorTest.java'), CALCULATOR_TEST);
        output = {
          cause: 'code',
          summary: 'subtract брал модуль разности: знак вернулся, тест на отрицательную разность',
          files: ['src/main/java/demo/Calculator.java'],
          tests: ['src/test/java/demo/CalculatorTest.java'],
          buildGreen: true,
        };
      } else if (prompt.includes('шаг "Реализация"')) {
        write(join(input.cwd, 'src/main/java/demo/Calculator.java'), scenario.bug ? CALCULATOR.replace('return a - b;', 'return Math.abs(a - b);') : CALCULATOR);
        write(join(input.cwd, 'src/test/java/demo/CalculatorTest.java'), scenario.bug ? CALCULATOR_TEST.replace('        assertEquals(-2, new Calculator().subtract(3, 5));\n', '') : CALCULATOR_TEST);
        output = { summary: 'Добавлен subtract', files: ['src/main/java/demo/Calculator.java'], tests: ['src/test/java/demo/CalculatorTest.java'], buildGreen: true };
      } else if (prompt.includes('шаг "Вики"') || prompt.includes('черновик страницы')) {
        // Страница по учебной задаче: факты помечены по скиллу, замечание владельца дописывается разделом.
        const file = join(dirs[0]!, 'wiki.md');
        const remark = /<замечание>\s*([\s\S]*?)\s*<\/замечание>/.exec(prompt)?.[1];
        const page = remark && existsSync(file) ? `${readFileSync(file, 'utf8').trimEnd()}\n\n## По замечанию\n\n${remark}\n` : DEMO_WIKI_PAGE;
        write(file, page);
        output = { pageId: null, title: 'Калькулятор: разность', space: /в пространстве (\S+?)[\s.,]/.exec(prompt)?.[1] ?? 'DEMO', parentId: null, summary: 'Описан метод subtract и его проверка на стенде' };
      } else if (prompt.includes('шаг "Разбор прогона"') || prompt.includes('Владелец посмотрел правки')) {
        // Разбор демо: круг доработки по тесту дает правило про знак разности в промпт доработки и в учебный скилл.
        const staging = dirs[0]!;
        const rules: [string, string][] = [
          ['steps/qa.fix/prompt.md', 'Проверь тестом знак результата арифметики: модуль вместо разности тест на положительных числах не ловит.'],
          ['skills/demo-calculator/SKILL.md', '- Отрицательная разность проверяется отдельно: subtract(3, 5) дает -2.'],
        ];
        const changes: { file: string; reason: string }[] = [];
        for (const [file, rule] of rules) {
          const target = join(staging, file);
          const source = new RegExp(`^- ${file.replace(/\./g, '\\.')}: (.+)$`, 'm').exec(prompt)?.[1];
          if (source) {
            write(target, `${readFileSync(source, 'utf8').trimEnd()}\n\n${rule}\n`);
          }
          if (existsSync(target)) changes.push({ file, reason: 'Круг доработки по тесту: разность потеряла знак' });
        }
        output = { changes, summary: 'Правило про знак разности добавлено в промпт доработки по тесту и в учебный скилл' };
      } else if (prompt.includes('шаг "Новый шаг"') || prompt.includes('Владелец посмотрел шаг')) {
        // Мастер в демо пишет учебный кодовый шаг с тестом: проверка на копии Task Pilot идет по-настоящему.
        for (const [file, text] of Object.entries(DEMO_STEP)) {
          write(join(dirs[0]!, file), text);
        }
        output = { stepId: 'demo.greet', title: 'Приветствие', files: Object.keys(DEMO_STEP), summary: 'Учебный шаг: пишет в ленту приветствие с ключом задачи и отдает его следующим шагам' };
      } else if (prompt.includes('Собери дашборд мониторинга') || prompt.includes('Владелец посмотрел дашборд')) {
        // Дашборд учебной задачи: строки учебного сервиса calculator, по замечанию владельца добавляется доля ошибок.
        const file = join(dirs[0]!, 'dashboard.yaml');
        const rework = prompt.includes('Владелец посмотрел дашборд') && existsSync(file);
        const key = /для задачи ([A-Z][A-Z0-9_]+-\d+)/.exec(prompt)?.[1] ?? 'DEMO-1';
        const base = rework ? readFileSync(file, 'utf8') : demoDashboard(key);
        write(file, rework && !base.includes('id: errors-share') ? base.replace('alerts:\n', DEMO_ERRORS_SHARE) : base);
        output = {
          summary: `Вычитания калькулятора: объем, ошибки и свежие строки${rework ? ', доля ошибок' : ''}`,
          lines: ['log.info("Calculator subtract: a={}, b={}", a, b)', 'log.error("Calculator subtract failed", e)'],
        };
      } else if (prompt.includes('ревью изменений')) {
        output = { findings: [] };
      } else if (prompt.includes('тексты публикации')) {
        const subject = prompt.includes('исправления по замечаниям ревьюеров')
          ? 'Тест на вычитание нуля по замечанию ревью'
          : prompt.includes('доработка после теста на стенде')
            ? 'Разность может быть отрицательной'
            : 'Калькулятор считает разность';
        output = { subject, body: '', prTitle: '', prDescription: '- Метод subtract\n- Тест на разность' };
      } else if (prompt.includes('шаг "Тест на стенде"')) {
        // Настоящий агент снимал бы кадры инструментом qa_browser: сервер кладет их в папку артефактов задачи.
        const artifacts = /ложатся в (.+?); смотри/.exec(prompt)![1]!;
        const recheck = prompt.includes('Что проверить: только AC 2');
        const lost = scenario.bug && !recheck;
        const shots: [string, Shot][] = recheck
          ? [['03-negative-fixed.png', 'pass']]
          : [
              ['01-subtract.png', 'pass'],
              ['02-negative.png', lost ? 'fail' : 'pass'],
              ...(lost ? ([['kibana-logs-01.png', 'logs']] as [string, Shot][]) : []),
            ];
        for (const [name, kind] of shots) writeFileSync(join(artifacts, name), demoShot(kind));
        write(join(dirs[0]!, 'qa-guide.md'), '# QA-гайд\n\n1. subtract(5, 3)\n');
        write(join(dirs[0]!, 'qa-report.md'), '# Отчет\n\n| AC | Итог |\n|---|---|\n| 1 | пройден |\n');
        const row = (ac: string, result: string, files: string[], note: string) => ({ ac, scenario: `AC ${ac}`, action: 'вызов на стенде', expected: 'по AC', result, note, files });
        output = {
          summary: lost ? 'Разность теряет знак' : 'Вычитание работает на стенде',
          results: recheck
            ? [row('2', 'пройден', ['03-negative-fixed.png'], '-2')]
            : [
                row('1', 'пройден', ['01-subtract.png'], '2'),
                row('2', lost ? 'не пройден' : 'пройден', lost ? ['02-negative.png', 'kibana-logs-01.png'] : ['02-negative.png'], lost ? 'subtract(3, 5) вернул 2' : '-2'),
                row('3', 'не проверен', [], 'сборку проверяет шаг Проверка'),
              ],
          remarks: [],
        };
      } else {
        throw new Error(`Неожиданное задание агенту: ${prompt.slice(0, 80)}`);
      }
      const result: ClaudeResult = { sessionId, isError: false, subtype: 'success', text, output, costUsd: 0, durationMs: 1, turns: 1, denials: [] };
      input.onEvent({ kind: 'result', result });
      return result;
    },
  };
  return { runner, prompts };
}
