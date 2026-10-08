/** Вопрос агента, разложенный на пронумерованные пункты: вступление, сами вопросы и текст после них. */
export interface NumberedQuestions {
  intro: string;
  items: string[];
  outro: string;
}

const ITEM = /^\s*(\d+)[.)]\s+(.*)$/;

/**
 * Пронумерованные вопросы в тексте вопроса агента: строки "1) ..." или "1. ..." по порядку с единицы, продолжение пункта -
 * следующие строки до пустой. Текст до первого пункта - вступление, после пустой строки за последним пунктом - хвост.
 * Меньше двух пунктов или сбитая нумерация - null: тогда вопрос один и ответ на него один.
 */
export function numberedQuestions(text: string): NumberedQuestions | null {
  const lines = text.split('\n');
  const items: string[] = [];
  const intro: string[] = [];
  const outro: string[] = [];
  let closed = false;
  for (const line of lines) {
    const m = ITEM.exec(line);
    if (m && !closed && Number(m[1]) === items.length + 1) {
      items.push(m[2]!.trim());
      continue;
    }
    if (!items.length) intro.push(line);
    else if (!closed && line.trim()) items[items.length - 1] += ` ${line.trim()}`;
    else if (!closed) closed = true;
    else outro.push(line);
  }
  if (items.length < 2) return null;
  return { intro: intro.join('\n').trim(), items, outro: outro.join('\n').trim() };
}

/**
 * Ответы на пронумерованные вопросы и общее замечание одним текстом для агента: ответы списком с номерами вопросов,
 * пустые пропускаются, замечание после них. Без ответов остается одно замечание.
 */
export function composeAnswers(answers: string[], comment: string, heading = 'Ответы на вопросы'): string {
  const given = answers.map((a, i) => [i + 1, a.trim()] as const).filter(([, a]) => a);
  const note = comment.trim();
  const list = given.length ? `${heading}:\n${given.map(([n, a]) => `${n}. ${a}`).join('\n')}` : '';
  return [list, note].filter(Boolean).join('\n\n');
}
