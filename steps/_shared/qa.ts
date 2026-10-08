import type { QaReport } from '../../packages/step-kit/src/index.ts';

/** AC, которые код должен починить: не пройденные и пройденные частично. "Не проверен" кодом не исправить. */
export function failedOf(report: Pick<QaReport, 'results'>): string[] {
  return report.results.filter((r) => r.result === 'не пройден' || r.result === 'частично').map((r) => r.ac);
}
