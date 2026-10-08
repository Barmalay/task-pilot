import { describe, expect, it } from 'vitest';
import html from '../index.html?raw';
import { isDark, parseTheme, THEME_KEY } from './theme.ts';

describe('theme of the page', () => {
  it('follows the system until the owner picks light or dark, and a stored value it does not know means the system', () => {
    expect(parseTheme(null)).toBe('system');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('sepia')).toBe('system');
  });

  it('is dark when picked dark, light when picked light whatever the system says, and like the system otherwise', () => {
    expect(isDark('dark', false)).toBe(true);
    expect(isDark('light', true)).toBe(false);
    expect(isDark('system', true)).toBe(true);
    expect(isDark('system', false)).toBe(false);
  });

  it('is applied before the first paint by index.html from the same stored key', () => {
    expect(html).toContain(`localStorage.getItem('${THEME_KEY}')`);
    expect(html.indexOf(THEME_KEY)).toBeLessThan(html.indexOf('/src/main.tsx'));
  });
});
