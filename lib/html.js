'use strict';

/**
 * Экранирует пользовательский текст для безопасной вставки в HTML-сообщения ботов
 * (Telegram parse_mode:'HTML', MAX format:'html'). Нейтрализует только структурные
 * символы `& < >` — этого достаточно, т.к. значения подставляются как текст, а не в атрибуты.
 * @param {unknown} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { escapeHtml };
