/**
 * agent.js — Claude-агент
 * 1. extractItems(messages) — извлекает список из сообщений чата
 * 2. analyzeDiff(messages, items) — сравнивает чат и текущий список
 */
const fetch = require('node-fetch');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-4-20250514';

async function callClaude(systemPrompt, userContent) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

/**
 * Извлекает список продуктов из сообщений чата.
 * Возвращает массив { name, qty, unit, price, cat, hint }
 */
async function extractItems(messages) {
  const SYSTEM = `Ты помощник для планирования пикника.
Тебе дают переписку из группового чата Telegram.
Извлеки из неё список продуктов и вещей для покупки.

Верни ТОЛЬКО JSON массив без лишнего текста, без markdown-обрамления.
Формат каждого элемента:
{
  "name": "название продукта",
  "qty": 1,
  "unit": "шт|кг|л|г|мл|упак|наб|пуч|банк|меш|рул",
  "price": 0,
  "cat": "rent|meat|grill|food|drinks|extra",
  "hint": "оригинальная фраза из чата"
}

Правила категорий:
- rent: аренда, беседка, место
- meat: мясо, курица, свинина, шашлык, рыба
- grill: уголь, мангал, шампуры, розжиг, решётка
- food: еда, хлеб, овощи, зелень, соусы, фрукты, закуски, гарнир
- drinks: напитки, вода, сок, пиво, вино, газировка
- extra: посуда, тарелки, стаканы, салфетки, пакеты, прочее

Если цена не упоминается — ставь 0.
Если количество не упоминается — ставь 1.
Если продукт упоминается несколько раз — объедини в одну позицию с максимальным количеством.
Игнорируй сообщения не связанные с покупками.`;

  const userContent = messages
    .map(m => `${m.user_name}: ${m.text}`)
    .join('\n');

  if (!userContent.trim()) return [];

  try {
    const raw = await callClaude(SYSTEM, userContent);
    // Strip possible markdown fences
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('extractItems error:', e.message);
    return [];
  }
}

/**
 * Анализирует расхождения между чатом и текущим списком.
 * Возвращает { summary, missing, extra, changed }
 */
async function analyzeDiff(messages, currentItems) {
  const SYSTEM = `Ты помощник для планирования пикника.
Тебе дают:
1. Переписку из группового чата — что обсуждали купить
2. Текущий список покупок — что реально добавили в список

Сравни их и найди расхождения.
Верни ТОЛЬКО JSON без markdown, формат:
{
  "summary": "краткий вывод одним абзацем по-русски, дружелюбно",
  "missing": [
    { "name": "название", "hint": "что говорили в чате" }
  ],
  "extra": [
    { "name": "название", "hint": "почему лишнее" }
  ],
  "changed": [
    { "name": "название", "chat_qty": "сколько в чате", "list_qty": "сколько в списке" }
  ]
}

missing — обсуждали в чате, но нет в списке
extra — есть в списке, но в чате не упоминалось (не всегда плохо)
changed — количество отличается от того что обсуждали

Если всё ок — верни пустые массивы и позитивный summary.`;

  const chatText = messages.map(m => `${m.user_name}: ${m.text}`).join('\n');
  const listText = currentItems
    .filter(i => i.enabled)
    .map(i => `- ${i.name}: ${i.qty} ${i.unit}`)
    .join('\n');

  const userContent = `=== ЧАТ ===\n${chatText}\n\n=== ТЕКУЩИЙ СПИСОК ===\n${listText}`;

  try {
    const raw = await callClaude(SYSTEM, userContent);
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('analyzeDiff error:', e.message);
    return {
      summary: 'Не удалось проанализировать. Попробуйте позже.',
      missing: [], extra: [], changed: [],
    };
  }
}

module.exports = { extractItems, analyzeDiff };
