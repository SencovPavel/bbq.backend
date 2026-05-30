/**
 * Тесты лимита размера тела запроса.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { readJsonBody, BodyTooLargeError } from '../lib/http-body.js';

const mockReq = (chunks) => {
  const req = new EventEmitter();
  queueMicrotask(() => {
    for (const c of chunks) req.emit('data', c);
    req.emit('end');
  });
  return req;
};

describe('readJsonBody', () => {
  it('парсит JSON в пределах лимита', async () => {
    const req = mockReq([Buffer.from('{"a":1}')]);
    const body = await readJsonBody(req, 1024);
    expect(body).toEqual({ a: 1 });
  });

  it('отклоняет тело больше лимита', async () => {
    const req = mockReq([Buffer.alloc(200)]);
    await expect(readJsonBody(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
