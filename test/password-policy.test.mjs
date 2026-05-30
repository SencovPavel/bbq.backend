import { describe, it, expect } from 'vitest';
import { validatePassword } from '../lib/password-policy.js';

describe('validatePassword', () => {
  it('требует 8+ символов', () => {
    expect(validatePassword('short1').ok).toBe(false);
  });

  it('требует букву и цифру', () => {
    expect(validatePassword('12345678').ok).toBe(false);
    expect(validatePassword('abcdefgh').ok).toBe(false);
  });

  it('принимает сильный пароль', () => {
    expect(validatePassword('Kotyol42').ok).toBe(true);
  });
});
