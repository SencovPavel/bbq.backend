'use strict';

/** @type {Record<string, string>} */
const LABELS = {
  'group:created': 'Создана группа',
  'group:joined': 'Вступление в группу',
  'user:registered': 'Регистрация',
  'user:login': 'Вход',
  'item:added': 'Добавлен товар',
  'item:updated': 'Изменён товар',
  'item:deleted': 'Удалён товар',
  'item:bought': 'Товар отмечен купленным',
  'event:created': 'Создано мероприятие',
  'event:completed': 'Мероприятие завершено',
  'rsvp:set': 'RSVP',
  'member:joined': 'Участник вступил',
  'agent:added': 'Бот добавил позиции',
  'family:member_added': 'Добавлен в семью',
  'error:ws': 'Ошибка WebSocket',
  'error:http': 'Ошибка HTTP',
};

/**
 * @param {string} type
 * @returns {string}
 */
function labelForEventType(type) {
  if (LABELS[type]) return LABELS[type];
  if (type.startsWith('error:')) return `Ошибка: ${type.slice(6)}`;
  return type;
}

/**
 * @param {{ type: string } & Record<string, unknown>} row
 * @returns {typeof row & { label: string }}
 */
function withLabel(row) {
  return { ...row, label: labelForEventType(row.type) };
}

/**
 * @param {Array<{ type: string } & Record<string, unknown>>} rows
 */
function withLabels(rows) {
  return rows.map(withLabel);
}

module.exports = { LABELS, labelForEventType, withLabel, withLabels };
