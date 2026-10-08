import { describe, expect, it } from 'vitest';
import { SECTIONS, sectionHref, sectionOf } from './nav.ts';
import { parseRoute } from './router.ts';

const section = (id: string) => SECTIONS.find((s) => s.id === id)!;

describe('navigation of the header', () => {
  it('has five sections, and only the pipeline and the settings have sub-tabs', () => {
    expect(SECTIONS.map((s) => s.label)).toEqual(['Задачи', 'Стенды', 'Мониторинг', 'Конвейер', 'Настройки']);
    expect(section('pipeline').tabs.map((t) => t.label)).toEqual(['Каталог шагов', 'Пресеты', 'История']);
    expect(section('settings').tabs.map((t) => t.label)).toEqual(['Интеграции', 'Окружение', 'Служебное']);
    expect(SECTIONS.filter((s) => s.tabs.length).map((s) => s.id)).toEqual(['pipeline', 'settings']);
  });

  it('puts every screen in its section, the run page with the tasks, a dashboard and a feature with the monitoring', () => {
    const cases: [string, string][] = [
      ['#/', 'tasks'],
      ['#/runs/r-1', 'tasks'],
      ['#/stands', 'stands'],
      ['#/monitor', 'monitor'],
      ['#/monitor/sso-errors', 'monitor'],
      ['#/monitor/features/captcha', 'monitor'],
      ['#/monitor/attempt/state-1/1700000000000', 'monitor'],
      ['#/catalog', 'pipeline'],
      ['#/presets', 'pipeline'],
      ['#/history', 'pipeline'],
      ['#/integrations', 'settings'],
      ['#/environment', 'settings'],
    ];
    for (const [hash, id] of cases) expect([hash, sectionOf(parseRoute(hash).name).id]).toEqual([hash, id]);
  });

  it('gives every screen exactly one section and every sub-tab an address that opens its screen', () => {
    const owners = SECTIONS.flatMap((s) => [...s.routes, ...s.tabs.map((t) => t.route)]);
    expect(new Set(owners).size).toBe(owners.length);
    for (const t of SECTIONS.flatMap((s) => s.tabs)) expect(parseRoute(t.href).name).toBe(t.route);
    for (const s of SECTIONS.filter((x) => !x.tabs.length)) expect(s.routes).toContain(parseRoute(s.href).name);
  });

  it('opens the sub-tab the owner left the section on, the first one before that, and the own address without sub-tabs', () => {
    expect(sectionHref(section('pipeline'), 'history')).toBe('#/history');
    expect(sectionHref(section('pipeline'), undefined)).toBe('#/catalog');
    expect(sectionHref(section('pipeline'), 'environment')).toBe('#/catalog');
    expect(sectionHref(section('settings'), 'environment')).toBe('#/environment');
    expect(sectionHref(section('stands'), 'history')).toBe('#/stands');
  });
});
