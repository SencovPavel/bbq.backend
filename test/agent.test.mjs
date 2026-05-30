/**
 * Тесты парсинга ответов Claude (чистые unit-тесты, без HTTP-запросов).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseItemsResponse, parseDiffResponse } = require('../lib/agent.js');

// ── parseItemsResponse ────────────────────────────────────────────────────────

describe('parseItemsResponse', () => {
  it('парсит чистый JSON-массив', () => {
    const raw = JSON.stringify([{ name: 'Хлеб', qty: 1, unit: 'шт', price: 0, cat: 'food' }]);
    const result = parseItemsResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Хлеб');
  });

  it('снимает обёртку ```json``` из ответа Claude', () => {
    const raw = '```json\n[{"name":"Вода","qty":2,"unit":"л","price":0,"cat":"drinks"}]\n```';
    const result = parseItemsResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Вода');
  });

  it('снимает обёртку ``` без слова json', () => {
    const raw = '```\n[{"name":"Уголь","qty":1,"unit":"кг","price":0,"cat":"grill"}]\n```';
    const result = parseItemsResponse(raw);
    expect(result).toHaveLength(1);
  });

  it('возвращает [] если ответ — не массив', () => {
    const raw = JSON.stringify({ error: 'not a list' });
    const result = parseItemsResponse(raw);
    expect(result).toEqual([]);
  });

  it('выбрасывает SyntaxError при невалидном JSON', () => {
    expect(() => parseItemsResponse('не json')).toThrow(SyntaxError);
  });
});

// ── parseDiffResponse ─────────────────────────────────────────────────────────

describe('parseDiffResponse', () => {
  it('парсит объект diff', () => {
    const payload = { summary: 'OK', missing: [], extra: [], changed: [] };
    const raw = JSON.stringify(payload);
    const result = parseDiffResponse(raw);
    expect(result.summary).toBe('OK');
    expect(result.missing).toEqual([]);
  });

  it('снимает обёртку ```json```', () => {
    const payload = { summary: 'Хорошо', missing: [{ name: 'Соль' }], extra: [], changed: [] };
    const raw = '```json\n' + JSON.stringify(payload) + '\n```';
    const result = parseDiffResponse(raw);
    expect(result.missing[0].name).toBe('Соль');
  });
});
