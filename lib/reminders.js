'use strict';

const { sendMessage } = require('./bot');
const { escapeHtml } = require('./html');

/** Integer days from today to dateStr (negative = past). Зеркало picnic-frontend/useEventScreenVM.ts:daysUntil. */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr.slice(0, 10) + 'T00:00:00');
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function pluralDays(n) {
  if (n === 1) return 'день';
  if (n >= 2 && n <= 4) return 'дня';
  return 'дней';
}

/**
 * Проверяет активные события с датой и шлёт напоминание в привязанный Telegram-чат
 * при пересечении порогов 4 дня / 1 день (те же пороги, что urgency-цвета на фронте).
 * Идемпотентно — каждый порог шлётся не больше одного раза (флаги в events).
 */
async function checkEventReminders(pool) {
  const { rows } = await pool.query(`
    SELECT e.id, e.name, e.event_date, e.reminder_4d_sent, e.reminder_1d_sent, g.tg_chat_id
    FROM events e
    JOIN picnic_groups g ON g.id = e.group_id
    WHERE e.status = 'active' AND e.event_date IS NOT NULL AND g.tg_chat_id IS NOT NULL
  `);

  for (const row of rows) {
    if (!row.tg_chat_id) continue;
    const daysLeft = daysUntil(row.event_date);
    if (daysLeft === null) continue;

    try {
      if (daysLeft > 1 && daysLeft <= 4 && !row.reminder_4d_sent) {
        await sendMessage(row.tg_chat_id, `⏳ До «${escapeHtml(row.name)}» осталось ${daysLeft} ${pluralDays(daysLeft)} — не забудьте собрать список`);
        await pool.query('UPDATE events SET reminder_4d_sent=true WHERE id=$1', [row.id]);
      } else if (daysLeft >= 0 && daysLeft <= 1 && !row.reminder_1d_sent) {
        const when = daysLeft === 0 ? 'сегодня' : 'завтра';
        await sendMessage(row.tg_chat_id, `🔥 «${escapeHtml(row.name)}» уже ${when}!`);
        await pool.query('UPDATE events SET reminder_1d_sent=true WHERE id=$1', [row.id]);
      }
    } catch (e) {
      console.error('[reminders] не удалось отправить напоминание', row.id, e.message);
    }
  }
}

module.exports = { checkEventReminders, daysUntil };
