import { describe, expect, it } from 'vitest';
import { lintBlocks, lintText, type LintOptions } from '../src/lint.ts';
import { renderTemplate } from '../src/template.ts';

const rules = (text: string, options = {}) => lintText(text, options).issues.map((i) => `${i.severity}:${i.rule}`);

/** Личный стиль владельца: е вместо е с точками, дефис вместо длинного тире, прямые кавычки. */
const OWN: LintOptions = { style: { yo: true, dash: true, quotes: true } };

describe('lintText', () => {
  it('fixes yo, long dashes and typographic quotes in prose by the personal style', () => {
    const r = lintText('Её «вход» — через Ёлку – без ошибок', OWN);
    expect(r.text).toBe('Ее "вход" - через Елку - без ошибок');
    expect(r.issues.map((i) => i.message)).toEqual([
      'буква е с точками заменена на е',
      'заглавная Е с точками заменена на Е',
      'длинное тире заменено дефисом (2)',
      'типографские кавычки заменены прямыми (2)',
    ]);
    expect(r.issues.every((i) => !/[ёЁ]/.test(i.message))).toBe(true);
    expect(lintBlocks(r.issues)).toBe(false);
  });

  it('leaves yo, dashes and quotes as they are without a personal style and fixes only the rules the style turns on', () => {
    expect(lintText('Её «вход» — через Ёлку').text).toBe('Её «вход» — через Ёлку');
    expect(lintText('Её «вход» — через Ёлку').issues).toEqual([]);
    expect(lintText('Её «вход» — через Ёлку', { style: { dash: true } }).text).toBe('Её «вход» - через Ёлку');
  });

  it('keeps code spans and fenced blocks untouched', () => {
    const text = 'Проза — тут, а в коде `"Ошибка — ё"` и\n```\nlog.info("ё — «x»");\n```\nконец — тоже';
    expect(lintText(text, OWN).text).toBe('Проза - тут, а в коде `"Ошибка — ё"` и\n```\nlog.info("ё — «x»");\n```\nконец - тоже');
  });

  it('is a fixed point: linting the fixed text changes nothing and reports no fixes', () => {
    const once = lintText('Всё — «готово» в Киклоке', OWN);
    const twice = lintText(once.text, OWN);
    expect(twice.text).toBe(once.text);
    expect(twice.issues).toEqual([]);
  });

  it('fixes the rarer dash and quote forms and keeps a lone apostrophe', () => {
    const r = lintText('Диапазон 2\u20154, флаг ‹beta›, аутентификатор ‘passport-token’, O’Reilly', OWN);
    expect(r.text).toBe('Диапазон 2-4, флаг "beta", аутентификатор "passport-token", O’Reilly');
    expect(lintText(r.text, OWN).issues).toEqual([]);
  });

  it('writes Keycloak in Latin: every Russian spelling in any case becomes Keycloak, whatever the style', () => {
    const r = lintText('Обновил Кейклок, в кейклоке, Киклока и киклоком');
    expect(r.text).toBe('Обновил Keycloak, в Keycloak, Keycloak и Keycloak');
    expect(r.issues.map((i) => i.message)).toEqual(['Keycloak по-русски заменен на латиницу (4)']);
  });

  it('leaves Keycloak in Latin alone in prose, code and identifiers', () => {
    expect(rules('Keycloak отдает токен, в keycloak отдается токен')).toEqual([]);
    expect(rules('Репозиторий gate и `Киклок`')).toEqual([]);
    expect(rules('Поправил `KeycloakSession` и org.keycloak.models')).toEqual([]);
  });

  it('blocks phone numbers in any usual spelling', () => {
    for (const phone of ['+7 916 123-45-67', '8(916)1234567', '79161234567', '+7(916) 123 45 67']) {
      expect(rules(`Пользователь ${phone} вошел`)).toEqual(['block:phone']);
    }
  });

  it('does not take ids, versions and timestamps for phones', () => {
    expect(rules('Сборка 1.0.3-251, задача TEAM-2799, время 1790107352581, код 791612345678')).toEqual([]);
  });

  it('blocks emails except allowed ones', () => {
    expect(rules('Пишите на ivan.petrov@example.com')).toEqual(['block:email']);
    expect(rules('Адрес noreply@example.com', { allowEmails: ['NoReply@example.com'] })).toEqual([]);
    expect(rules('Аннотация @Override и @Test')).toEqual([]);
  });

  it('blocks exact secret values and token shapes and masks them in the sample', () => {
    const r = lintText('token=abcdef1234567890 и Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl', {
      secrets: ['abcdef1234567890'],
    });
    expect(r.issues.filter((i) => i.severity === 'block').map((i) => i.message)).toEqual([
      'в тексте значение токена',
      'в тексте JWT',
      'в тексте токен авторизации',
    ]);
    expect(r.issues.every((i) => !i.sample?.includes('1234567890') && !i.sample?.includes('c2lnbmF0dXJl'))).toBe(true);
  });

  it('blocks employee names including case endings, whole words only', () => {
    expect(rules('Согласовано с Петровым', { names: ['Петров'] })).toEqual(['block:name']);
    expect(rules('Согласовано с тимлидом', { names: ['Петров'] })).toEqual([]);
    expect(rules('Петровский проспект', { names: ['Петров'] })).toEqual([]);
  });

  it('blocks a private key header', () => {
    expect(rules('-----BEGIN RSA PRIVATE KEY-----')).toEqual(['block:secret']);
  });
});

describe('renderTemplate', () => {
  it('substitutes variables and renders null as empty', () => {
    expect(renderTemplate('Задача {{key}}: {{ summary }}{{extra}}', { key: 'TEAM-1', summary: 'вход', extra: null })).toBe('Задача TEAM-1: вход');
  });

  it('fails on an unknown variable so a typo in prompt.md is visible', () => {
    expect(() => renderTemplate('{{key}} {{sumary}}', { key: 'TEAM-1' })).toThrow('sumary');
  });
});
