import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TG_EMAIL_SQL } = require('../lib/admin-user-sync.js');

describe('admin-user-sync', () => {
  it('TG_EMAIL_SQL содержит паттерн telegram.internal', () => {
    expect(TG_EMAIL_SQL).toContain('telegram.internal');
  });
});
