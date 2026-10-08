import { describe, expect, it } from 'vitest';
import { pageProblems, SMOKE_PANELS, SMOKE_ROUTES, type PageFacts } from '../src/smoke.ts';

const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ exceptions: [], consoleErrors: [], apiErrors: [], alerts: [], textLength: 500, ...over });

describe('smoke of the interface', () => {
  it('opens every main screen of the navigation and the screens of the monitoring of the demo', () => {
    expect(SMOKE_ROUTES.map(([, route]) => route)).toEqual(['/', '/stands', '/monitor', '/monitor/features/confirm', '/monitor/demo-2-division', '/catalog', '/presets', '/history', '/integrations', '/environment', '/service']);
  });

  it('opens the profile panel and the notices of the header and the edit panel of a dashboard by their buttons', () => {
    expect(SMOKE_PANELS).toEqual([
      ['Профиль', '/', '[data-profile]'],
      ['Уведомления', '/', '[aria-label^="Уведомления"]'],
      ['Изменить по запросу', '/monitor/demo-2-division', '[data-edit]'],
    ]);
  });

  it('counts exceptions, console errors, failed API requests, error boxes and an empty screen as problems', () => {
    expect(pageProblems(facts())).toEqual([]);
    expect(
      pageProblems(facts({ exceptions: ['TypeError: x is undefined'], consoleErrors: ['Не удалось прочитать'], apiErrors: ['500 /api/stands'], alerts: ['Не удалось прочитать интеграции'], textLength: 3 })),
    ).toEqual(['исключение: TypeError: x is undefined', 'ошибка в консоли: Не удалось прочитать', 'API: 500 /api/stands', 'плашка ошибки: Не удалось прочитать интеграции', 'пустой экран']);
  });

  it('ignores the event stream cut when the page goes away and the icon request the browser makes itself', () => {
    const noise = ['Failed to load resource: net::ERR_ABORTED (http://127.0.0.1:5000/api/events)', 'Failed to load resource: 404 (http://127.0.0.1:5000/favicon.ico)'];
    expect(pageProblems(facts({ consoleErrors: noise }))).toEqual([]);
  });
});
