import { describe, expect, it } from 'vitest';
import { NO_MOVE, stepSettings, stepManifestSchema } from '@task-pilot/step-kit';
import { customSettings, presetSettings, settingChipText, settingsApplyHint, settingsPatch } from './settings.ts';

const BOARD = {
  path: [
    { from: 'Open', id: '4', name: 'Start Progress', to: 'In Progress' },
    { from: 'In Progress', id: '971', name: 'Готово к ревью', to: 'Ready to Review' },
  ],
  after: ['MERGED'],
  milestones: { review: 'Ready to Review' },
};

const manifest = stepManifestSchema.parse({
  id: 'code.publish',
  title: 'Коммит, пуш и PR',
  hint: 'шаг',
  phase: 'code',
  kind: 'hybrid',
  params: {
    moveTo: { type: 'jiraStatus', label: 'Куда перевести задачу', milestone: 'review' },
    draft: { type: 'boolean', label: 'Черновик PR' },
  },
});

describe('settings of a step on the screen', () => {
  it('sends only the changed values, and a value equal to the default as a return to the default', () => {
    // Пресет переводит в MERGED, прогон выбрал "не переводить".
    const settings = stepSettings(manifest, BOARD, { moveTo: 'MERGED' }, { moveTo: NO_MOVE });
    expect(settingsPatch(settings, { moveTo: NO_MOVE, draft: false })).toEqual({});
    expect(settingsPatch(settings, { moveTo: 'In Progress', draft: true })).toEqual({ moveTo: 'In Progress', draft: true });
    // Выбор, равный умолчанию пресета, не закрепляется в прогоне: действует умолчание.
    expect(settingsPatch(settings, { moveTo: 'MERGED' })).toEqual({ moveTo: null });
  });

  it('shows chips only for the settings chosen in the run or given by the preset, a move on the board as Jira', () => {
    const settings = stepSettings(manifest, BOARD, {}, { moveTo: NO_MOVE });
    expect(customSettings(settings).map(settingChipText)).toEqual(['Jira: не переводить']);
    expect(customSettings(stepSettings(manifest, BOARD))).toEqual([]);
    expect(settingChipText(stepSettings(manifest, BOARD, { draft: true })[1]!)).toBe('Черновик PR: да');
  });

  it('puts the value of the preset over the default of the step in the preset editor', () => {
    const catalog = stepSettings(manifest, BOARD);
    const [move, draft] = presetSettings(catalog, { moveTo: 'MERGED' });
    expect(move).toMatchObject({ value: 'MERGED', defaultValue: '', source: 'preset' });
    expect(draft).toMatchObject({ value: false, source: 'manifest' });
  });

  it('says when the step gets the saved settings by where it is in the run', () => {
    expect(settingsApplyHint('pending')).toBe('Шаг выполнится с этими настройками');
    expect(settingsApplyHint('waiting_owner')).toContain('спросит его заново');
    expect(settingsApplyHint('blocked')).toBe('Настройки применятся, когда шаг продолжится');
    expect(settingsApplyHint('succeeded')).toContain('когда его повторят');
  });
});
