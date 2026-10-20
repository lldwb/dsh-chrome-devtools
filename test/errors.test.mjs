// lib/errors.mjs 的离线单测：错误类型、稳定错误码、toPublicError 归一化。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BrowserError,
  ERROR_CODES,
  SCHEME_UNKNOWN,
  isBrowserError,
  toPublicError,
} from '../lib/errors.mjs';

test('BrowserError 携带 code / message / details', () => {
  const error = new BrowserError('CONNECT_FAILED', '连不上', { wsUrl: 'ws://127.0.0.1:9222' });
  assert.equal(error.name, 'BrowserError');
  assert.equal(error.code, 'CONNECT_FAILED');
  assert.equal(error.message, '连不上');
  assert.deepEqual(error.details, { wsUrl: 'ws://127.0.0.1:9222' });
  assert.ok(error instanceof Error);
  assert.ok(error instanceof BrowserError);
});

test('BrowserError 的 details 缺省为空对象，code 非法时兜底 UNKNOWN', () => {
  const plain = new BrowserError('TIMEOUT', '超时');
  assert.deepEqual(plain.details, {});
  const bogus = new BrowserError('', '空码');
  assert.equal(bogus.code, 'UNKNOWN');
  const nullDetails = new BrowserError('CDP_ERROR', 'x', null);
  assert.deepEqual(nullDetails.details, {});
});

test('BrowserError 可以 JSON 序列化（RPC / 工具输出用）', () => {
  const error = new BrowserError('INVALID_ARGUMENT', '参数不对', { field: 'scheme' });
  assert.deepEqual(JSON.parse(JSON.stringify(error)), {
    code: 'INVALID_ARGUMENT',
    message: '参数不对',
    details: { field: 'scheme' },
  });
  assert.deepEqual(error.toJSON(), { code: 'INVALID_ARGUMENT', message: '参数不对', details: { field: 'scheme' } });
});

test('ERROR_CODES 覆盖契约 §3.1 列出的全部错误码', () => {
  // 契约原文（注意 SCHEME_UNKNOWN 是契约里的拼写，不能"修正"：T2/T3 按它比较）。
  for (const code of [
    'SCHEME_UNKNOWN',
    'CHROME_NOT_FOUND',
    'CONNECT_FAILED',
    'NOT_CONNECTED',
    'TARGET_NOT_FOUND',
    'TIMEOUT',
    'CDP_ERROR',
    'PROTOCOL_ERROR',
    'INVALID_ARGUMENT',
    'NO_DEBUG_ENDPOINT',
  ]) {
    assert.ok(
      Object.values(ERROR_CODES).includes(code),
      `ERROR_CODES 缺少契约错误码 ${code}`,
    );
  }
  // SCHEME_UNKNOWN 是同一值的别名（正确拼写），供新代码使用。
  assert.equal(SCHEME_UNKNOWN, 'SCHEME_UNKNOWN');
  assert.equal(ERROR_CODES.SCHEME_UNKNOWN, 'SCHEME_UNKNOWN');
});

test('toPublicError 展开 BrowserError，保留 details', () => {
  const error = new BrowserError('TARGET_NOT_FOUND', 'selector 找不到', { selector: '#a' });
  assert.deepEqual(toPublicError(error), {
    code: 'TARGET_NOT_FOUND',
    message: 'selector 找不到',
    details: { selector: '#a' },
  });
});

test('toPublicError 处理普通 Error（有 code 时沿用，否则 UNKNOWN）', () => {
  const withCode = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
  assert.deepEqual(toPublicError(withCode), { code: 'ECONNREFUSED', message: 'boom', details: {} });
  assert.deepEqual(toPublicError(new Error('plain')), { code: 'UNKNOWN', message: 'plain', details: {} });
});

test('toPublicError 对非 Error 值也给出结构化结果，永不抛', () => {
  assert.deepEqual(toPublicError('字符串错误'), { code: 'UNKNOWN', message: '字符串错误', details: {} });
  assert.deepEqual(toPublicError(undefined), { code: 'UNKNOWN', message: '未知错误', details: {} });
  assert.deepEqual(toPublicError(null), { code: 'UNKNOWN', message: '未知错误', details: {} });
  const circular = {};
  circular.self = circular;
  const result = toPublicError(circular);
  assert.equal(result.code, 'UNKNOWN');
  assert.equal(typeof result.message, 'string');
  assert.deepEqual(result.details, {});
  const numeric = toPublicError(42);
  assert.equal(numeric.code, 'UNKNOWN');
  assert.equal(numeric.message, '42');
});

test('isBrowserError 同时识别实例与同形对象', () => {
  assert.equal(isBrowserError(new BrowserError('TIMEOUT', 'x')), true);
  assert.equal(isBrowserError(new Error('x')), false);
  assert.equal(isBrowserError({ name: 'BrowserError', code: 'TIMEOUT', message: 'x' }), true);
  assert.equal(isBrowserError(null), false);
  assert.equal(isBrowserError('BrowserError'), false);
});
