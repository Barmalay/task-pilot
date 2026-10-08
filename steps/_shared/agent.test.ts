import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testContext, testRepo } from '../_test/context.ts';
import { agentRules, stageDocs, styleRule } from './agent.ts';
import { NO_STYLE } from '../../packages/step-kit/src/index.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'stage-docs-'));
  const repo = testRepo(join(root, 'repo'), join(root, 'wt'));
  const c = testContext({ issueKey: 'TEAM-1', repo, ports: {} });
  mkdirSync(c.paths.docs, { recursive: true });
  writeFileSync(join(c.paths.docs, 'plan.md'), 'план\n');
  writeFileSync(join(c.paths.docs, 'solution.md'), 'решение\n');
  return c;
}

describe('the copy of the task docs for an agent', () => {
  it('brings back the files the agent changed or created, in folders too', () => {
    const c = setup();
    const docs = stageDocs(c);
    writeFileSync(join(docs.dir, 'plan.md'), 'план, доработка\n');
    mkdirSync(join(docs.dir, 'wiki'), { recursive: true });
    writeFileSync(join(docs.dir, 'wiki', 'page.md'), 'страница\n');
    docs.back();
    expect(readFileSync(join(c.paths.docs, 'plan.md'), 'utf8')).toBe('план, доработка\n');
    expect(readFileSync(join(c.paths.docs, 'wiki', 'page.md'), 'utf8')).toBe('страница\n');
  });

  it('does not overwrite a file another step wrote while the agent worked on its copy', () => {
    const c = setup();
    const docs = stageDocs(c);
    writeFileSync(join(docs.dir, 'wiki.md'), 'вики\n');
    // Пока фоновый шаг работал, цепочка обновила решение: копия агента его не затирает.
    writeFileSync(join(c.paths.docs, 'solution.md'), 'решение после ревью\n');
    docs.back();
    expect(readFileSync(join(c.paths.docs, 'solution.md'), 'utf8')).toBe('решение после ревью\n');
    expect(existsSync(join(c.paths.docs, 'wiki.md'))).toBe(true);
  });
});

describe('rules for an agent', () => {
  const texts = (rules: string, style = NO_STYLE) => ({ texts: { rules, style } });

  it('are the pipeline rules, with the code rules for steps that change code, and nothing of a team without its rules', () => {
    const plain = agentRules(texts(''));
    expect(plain).toContain('## Правила конвейера');
    expect(plain).not.toContain('## Правила для кода');
    expect(plain).not.toContain('## Правила текстов команды и личные');
    expect(agentRules(texts(''), true)).toContain('## Правила для кода');
  });

  it('add the rules of the team and the personal style after the pipeline rules', () => {
    const rules = agentRules(texts('- Keycloak пиши латиницей.\n', { yo: true, dash: false, quotes: true }), true);
    expect(rules.indexOf('## Правила для кода')).toBeLessThan(rules.indexOf('## Правила текстов команды и личные'));
    expect(rules).toContain('## Правила текстов команды и личные\n\n- Тексты пиши без буквы е с точками, с прямыми кавычками.\n- Keycloak пиши латиницей.\n');
  });

  it('say nothing about the style when the personal style turns nothing on', () => {
    expect(styleRule(NO_STYLE)).toBe('');
    expect(styleRule({ yo: true, dash: true, quotes: true })).toBe('- Тексты пиши без буквы е с точками, без длинного тире, с прямыми кавычками.');
  });
});
