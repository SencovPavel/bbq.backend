/**
 * password-policy.js — минимальные требования к паролю.
 */

const MIN_LENGTH = 8;

/**
 * @param {string} password
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
const validatePassword = (password) => {
  if (!password || password.length < MIN_LENGTH) {
    return { ok: false, error: `Пароль минимум ${MIN_LENGTH} символов` };
  }
  const hasLetter = /[a-zA-Zа-яА-ЯёЁ]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) {
    return { ok: false, error: 'Пароль должен содержать букву и цифру' };
  }
  return { ok: true };
};

module.exports = { validatePassword, MIN_LENGTH };
