/**
 * Тесты бизнес-правил бота (чистые unit-тесты).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCatId, isDuplicateName } = require('../lib/bot.js');

// ── resolveCatId ──────────────────────────────────────────────────────────────

describe('resolveCatId', () => {
  const VALID = ['rent', 'meat', 'grill', 'food', 'drinks', 'extra'];

  it.each(VALID)('известная категория "%s" проходит без изменений', (cat) => {
    expect(resolveCatId(cat)).toBe(cat);
  });

  it('неизвестная категория возвращает "extra"', () => {
    expect(resolveCatId('snacks')).toBe('extra');
  });

  it('пустая строка → "extra"', () => {
    expect(resolveCatId('')).toBe('extra');
  });

  it('undefined → "extra"', () => {
    expect(resolveCatId(undefined)).toBe('extra');
  });

  it('null → "extra"', () => {
    expect(resolveCatId(null)).toBe('extra');
  });
});

// ── isDuplicateName ───────────────────────────────────────────────────────────

describe('isDuplicateName', () => {
  it('возвращает true если первые 8 символов совпадают', () => {
    expect(isDuplicateName(['Шашлык из свинины'], 'Шашлык ')).toBe(true);
  });

  it('сравнение без учёта регистра', () => {
    expect(isDuplicateName(['шашлык из свинины'], 'Шашлык ')).toBe(true);
  });

  it('возвращает false если список пуст', () => {
    expect(isDuplicateName([], 'Хлеб')).toBe(false);
  });

  it('возвращает false если нет совпадения', () => {
    expect(isDuplicateName(['Кола', 'Вода'], 'Шашлык')).toBe(false);
  });

  it('короткое имя (< 8 символов) тоже дедуплицируется', () => {
    expect(isDuplicateName(['Соль мелкая'], 'Соль')).toBe(true);
  });
});
