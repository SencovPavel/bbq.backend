'use strict';

// Типы событий: иконка/лейбл для UI + дефолт бюджета + шаблон категорий,
// подтягиваемых в группу при создании события этого типа (см. ws.js: event:add).
const EVENT_TYPES = [
  {
    id: 'picnic', label: 'Пикник / выезд', icon: '🔥', hasBudgetDefault: true,
    categories: [
      { title: 'Еда и напитки', icon: '🥩' },
      { title: 'Мангал и место', icon: '🔥' },
      { title: 'Разное', icon: '📦' },
    ],
  },
  {
    id: 'trip', label: 'Поездка', icon: '🧳', hasBudgetDefault: true,
    categories: [
      { title: 'Билеты и жильё', icon: '🎫' },
      { title: 'Сборы', icon: '🧳' },
      { title: 'На месте', icon: '📍' },
    ],
  },
  {
    id: 'moving', label: 'Переезд', icon: '📦', hasBudgetDefault: false,
    categories: [
      { title: 'Упаковка', icon: '📦' },
      { title: 'Транспорт', icon: '🚚' },
      { title: 'На новом месте', icon: '🏠' },
    ],
  },
  {
    id: 'party', label: 'Праздник', icon: '🎉', hasBudgetDefault: true,
    categories: [
      { title: 'Еда и напитки', icon: '🥂' },
      { title: 'Декор', icon: '🎈' },
      { title: 'Развлечения', icon: '🎶' },
    ],
  },
  {
    id: 'cleanup', label: 'Субботник / дело', icon: '🧹', hasBudgetDefault: false,
    categories: [
      { title: 'Инвентарь', icon: '🧹' },
      { title: 'Задачи', icon: '✅' },
    ],
  },
  {
    id: 'custom', label: 'Своё', icon: '✨', hasBudgetDefault: false,
    categories: [
      { title: 'Задачи', icon: '✅' },
    ],
  },
];

const EVENT_TYPES_BY_ID = Object.fromEntries(EVENT_TYPES.map(t => [t.id, t]));

module.exports = { EVENT_TYPES, EVENT_TYPES_BY_ID };
