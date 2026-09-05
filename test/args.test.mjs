import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseDecision, parseSince, UsageError } from '../src/args.mjs';

test('команда, позиционные слова и значения флагов', () => {
  const { command, args, opts } = parseArgs(['ask', 'посмотри', 'отклики', '--why', 'горит', '--json']);
  assert.equal(command, 'ask');
  assert.deepEqual(args, ['посмотри', 'отклики']);
  assert.equal(opts.why, 'горит');
  assert.equal(opts.json, true);
});

test('--ключ=значение и всё после -- считается словами', () => {
  const { opts, args } = parseArgs(['say', '--profile=stend', '--', '--это-текст']);
  assert.equal(opts.profile, 'stend');
  assert.deepEqual(args, ['--это-текст']);
});

test('флаг без значения — ошибка вызывающего, а не «показал всё»', () => {
  assert.throws(() => parseArgs(['feed', '--since']), UsageError);
  assert.throws(() => parseArgs(['feed', '--since', '--json']), UsageError);
});

test('срок разбирается, курсор проходит насквозь', () => {
  assert.deepEqual(parseSince('2h'), { kind: 'ago', ms: 7_200_000 });
  assert.deepEqual(parseSince('30m'), { kind: 'ago', ms: 1_800_000 });
  assert.deepEqual(parseSince('3d'), { kind: 'ago', ms: 259_200_000 });
  assert.deepEqual(parseSince(undefined), { kind: 'none' });
  const opaque = 'MjAyNi0wOS0wNVQxMjowMDowMFp8YWJj';
  assert.deepEqual(parseSince(opaque), { kind: 'cursor', cursor: opaque });
});

test('решение словами человека', () => {
  assert.equal(parseDecision('да'), 'approved');
  assert.equal(parseDecision('ДА'), 'approved');
  assert.equal(parseDecision('approved'), 'approved');
  assert.equal(parseDecision('нет'), 'declined');
  assert.equal(parseDecision('no'), 'declined');
  assert.throws(() => parseDecision('может быть'), UsageError);
  assert.throws(() => parseDecision(undefined), UsageError);
});
