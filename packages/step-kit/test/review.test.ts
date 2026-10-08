import { describe, expect, it } from 'vitest';
import { commentsToAnswer } from '../src/review.ts';
import type { PrComment } from '../src/types.ts';

const AUTHOR = 'Автор PR';
const comment = (id: number, author: string, replies: string[] = [], state = 'OPEN'): PrComment => ({
  id,
  author,
  text: `замечание ${id}`,
  createdAt: '2026-09-22T08:00:00.000Z',
  state,
  file: null,
  line: null,
  replies: replies.map((a, i) => ({ id: id * 10 + i, author: a, text: 'ответ', createdAt: `2026-09-22T09:0${i}:00.000Z` })),
});

describe('comments the author has to answer', () => {
  it('takes open comments of others where the last word is not the author', () => {
    const comments = [
      comment(1, 'Ревьюер'),
      comment(2, 'Ревьюер', [AUTHOR]),
      comment(3, 'Ревьюер', [AUTHOR, 'Ревьюер']),
      comment(4, 'Ревьюер', [], 'RESOLVED'),
      comment(5, AUTHOR),
    ];
    expect(commentsToAnswer({ author: AUTHOR, comments }).map((c) => c.id)).toEqual([1, 3]);
  });
});
