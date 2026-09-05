import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiCallError, createClient, NetworkError } from '../src/client.mjs';

function reply(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('ключ уходит заголовком, параметры — строкой запроса', async () => {
  const seen = [];
  const client = createClient({
    api: 'https://autopasha.ru/api/v1',
    token: 'ap_live_test',
    fetchImpl: async (url, init) => {
      seen.push({ url: url.toString(), init });
      return reply({ items: [] });
    },
  });
  await client.feed({ since: 'cur', limit: 5 });
  assert.equal(seen[0].url, 'https://autopasha.ru/api/v1/feed?since=cur&limit=5');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer ap_live_test');
});

test('POST несёт ключ повтора, и у всех попыток он один', async () => {
  const keys = [];
  let calls = 0;
  const client = createClient({
    api: 'https://autopasha.ru/api/v1',
    token: 'ap_live_test',
    fetchImpl: async (_url, init) => {
      keys.push(init.headers['Idempotency-Key']);
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return reply({ id: 'cmd-1' });
    },
  });
  const res = await client.ask({ text: 'проверить' });
  assert.equal(res.id, 'cmd-1');
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'повтор обязан идти с тем же ключом, иначе задача встанет дважды');
});

test('403 не повторяется и доносит подсказку', async () => {
  let calls = 0;
  const client = createClient({
    api: 'https://autopasha.ru/api/v1',
    token: 'ap_live_test',
    fetchImpl: async () => {
      calls += 1;
      return reply(
        { error: { code: 'scope_missing', message: 'ключу не хватает права tasks', hint: 'заведите ключ с правом tasks' }, requestId: 'r-1' },
        { status: 403 },
      );
    },
  });
  await assert.rejects(
    () => client.ask({ text: 'нельзя' }),
    (e) => e instanceof ApiCallError && e.code === 'scope_missing' && e.hint.includes('tasks') && e.requestId === 'r-1',
  );
  assert.equal(calls, 1, 'ожидание не лечит нехватку права');
});

test('429 добавляет к подсказке срок из заголовка', async () => {
  const client = createClient({
    api: 'https://autopasha.ru/api/v1',
    token: 'ap_live_test',
    fetchImpl: async () =>
      reply({ error: { code: 'rate_limited', message: 'много запросов', hint: 'возьмите watch.' } }, { status: 429, headers: { 'RateLimit-Reset': '17' } }),
  });
  await assert.rejects(
    () => client.status(),
    (e) => e.code === 'rate_limited' && e.hint.includes('17 с'),
  );
});

test('ответ не-JSON называется чужим ответом, а не поломкой API', async () => {
  const client = createClient({
    api: 'https://autopasha.ru/api/v1',
    token: 'ap_live_test',
    fetchImpl: async () => new Response('<html>вход в сеть отеля</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  await assert.rejects(
    () => client.status(),
    (e) => e instanceof ApiCallError && e.code === 'not_api',
  );
});

test('сеть, которая не поднялась ни разу, — NetworkError, а не «сломался сервис»', async () => {
  const client = createClient({
    api: 'https://autopasha.ru/api/v1',
    token: 'ap_live_test',
    retries: 1,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(() => client.status(), NetworkError);
});

test('ключ с русскими буквами не роняет fetch изнутри', () => {
  assert.throws(
    () => createClient({ api: 'https://autopasha.ru/api/v1', token: 'ap_live_ключ' }),
    (e) => e instanceof ApiCallError && e.code === 'bad_token',
  );
});

test('без ключа клиент не создаётся вовсе', () => {
  assert.throws(
    () => createClient({ api: 'https://autopasha.ru/api/v1', token: '' }),
    (e) => e instanceof ApiCallError && e.code === 'no_token',
  );
});
