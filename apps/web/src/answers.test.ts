import { describe, expect, it } from 'vitest';
import { composeAnswers, numberedQuestions } from './answers.ts';

describe('numbered questions of an agent', () => {
  it('splits an intro, the numbered questions with their continuation lines and the text after them', () => {
    const q = numberedQuestions(
      'TEAM-2860, тест на стенде Testing-LG-1. Три вопроса:\n1) В QA-браузере нет вкладки,\nдрайвер падает на подключении.\n2) Можно брать ключи из k8s?\n3) Какой номер тестовый?\n\nОтветь по пунктам.',
    );
    expect(q).toEqual({
      intro: 'TEAM-2860, тест на стенде Testing-LG-1. Три вопроса:',
      items: ['В QA-браузере нет вкладки, драйвер падает на подключении.', 'Можно брать ключи из k8s?', 'Какой номер тестовый?'],
      outro: 'Ответь по пунктам.',
    });
    expect(numberedQuestions('1. Первый\n2. Второй')?.items).toEqual(['Первый', 'Второй']);
  });

  it('sees one question in a text with a single item or with numbering that does not go from one', () => {
    expect(numberedQuestions('Какой стенд?')).toBeNull();
    expect(numberedQuestions('Вопрос:\n1) Какой стенд?')).toBeNull();
    expect(numberedQuestions('Версии:\n2. старая\n3. новая')).toBeNull();
  });
});

describe('answers to the questions', () => {
  it('lists the given answers under the numbers of their questions, skips empty ones and puts the comment after', () => {
    expect(composeAnswers(['Только send', 'Да', ' ', 'Нет'], 'Пиши план короче')).toBe('Ответы на вопросы:\n1. Только send\n2. Да\n4. Нет\n\nПиши план короче');
  });

  it('keeps only the comment without answers and only the answers without a comment', () => {
    expect(composeAnswers(['', ''], 'Пиши план короче')).toBe('Пиши план короче');
    expect(composeAnswers(['Да'], '  ')).toBe('Ответы на вопросы:\n1. Да');
    expect(composeAnswers([], '')).toBe('');
  });
});
