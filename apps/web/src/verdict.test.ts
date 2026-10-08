import { describe, expect, it } from 'vitest';
import { buildVerdict } from './verdict.ts';

const changes = (buildGreen: boolean) => ({ summary: 'Сделан счетчик', files: ['A.java'], tests: [], buildGreen, sessionId: 's-1' });
const report = (failures: number) => ({ tests: 295, failures, errors: 0, skipped: 0 });
const build = { key: 'BUILDS-SF24-1', revision: '1a9bf9a1046113162a9fbb8b84c3cc49712e4cc6' };

describe('build verdict for the changes row', () => {
  it('trusts the agent that wrote the code only until the build is checked', () => {
    expect(buildVerdict({ changes: changes(false) })).toMatchObject({ label: 'агент: сборка не зеленая', tone: 'amber' });
    expect(buildVerdict({ changes: changes(true) })).toMatchObject({ label: 'агент: сборка зеленая', tone: 'green' });
  });

  it('shows the local check once it ran, whatever the agent said', () => {
    expect(buildVerdict({ changes: changes(false), testReport: report(0) })).toMatchObject({ label: 'проверка: сборка зеленая', tone: 'green' });
    expect(buildVerdict({ changes: changes(true), testReport: report(2) })).toMatchObject({ label: 'проверка: упало 2', tone: 'red' });
  });

  it('shows the green CI build of the current commit last of all, and not the build of an older commit', () => {
    expect(buildVerdict({ changes: changes(false), testReport: report(0), commitSha: '1a9bf9a1', build })).toMatchObject({ label: 'CI: сборка прошла', tone: 'green' });
    expect(buildVerdict({ testReport: report(1), commitSha: 'f00dbabe', build })).toMatchObject({ label: 'проверка: упало 1' });
  });

  it('says nothing without any check', () => {
    expect(buildVerdict({ plan: { summary: 'План' } })).toBeNull();
  });
});
