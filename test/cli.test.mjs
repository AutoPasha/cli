import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, watchLoop } from '../src/cli.mjs';

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'autopasha-cli-'));
  return { AUTOPASHA_CONFIG: join(dir, 'config.json') };
}

function collect() {
  const lines = [];
  return { lines, write: (s) => lines.push(s), text: () => lines.join('\n') };
}

test('login проверяет ключ живым запросом и кладёт его с правами 0600', async () => {
  const env = await sandbox();
  const out = collect();
  const code = await run(['login', '--token', 'ap_live_test'], {
    env,
    out: out.write,
    err: out.write,
    client: {
      me: async () => ({
        client: { title: 'ООО Ромашка' },
        employee: { name: 'Паша' },
        key: { scopes: ['read', 'tasks'] },
      }),
    },
  });

  assert.equal(code, 0);
  assert.match(out.text(), /Ключ принят: ООО Ромашка/);
  assert.match(out.text(), /read, tasks/);

  const info = await stat(env.AUTOPASHA_CONFIG);
  assert.equal(info.mode & 0o777, 0o600, 'ключ на диске не должен быть открыт всей машине');
  const saved = JSON.parse(await readFile(env.AUTOPASHA_CONFIG, 'utf8'));
  assert.equal(saved.profiles.default.token, 'ap_live_test');
});

test('login без ключа не пишет ничего и объясняет, где его взять', async () => {
  const env = await sandbox();
  const out = collect();
  const code = await run(['login'], { env, out: out.write, err: out.write, stdin: '', client: { me: async () => ({}) } });
  assert.equal(code, 1);
  assert.match(out.text(), /раздел «API»/);
  await assert.rejects(() => stat(env.AUTOPASHA_CONFIG));
});

test('status показывает состояние, вопросы и как на них ответить', async () => {
  const env = await sandbox();
  const out = collect();
  const code = await run(['status'], {
    env: { ...env, AUTOPASHA_TOKEN: 'ap_live_test' },
    out: out.write,
    err: out.write,
    client: {
      status: async () => ({
        employee: { name: 'Паша', state: 'работает', since: '2026-09-05T09:12:00Z', doing: 'разбирает отклики' },
        waiting: { onOwner: 1, selfResolving: 2, total: 4 },
        questions: [{ id: 'q-1', question: 'Купить прокси?', ifSilent: 'пробуем без', expiresAt: '2026-09-06T06:00:00Z' }],
        recent: [{ at: '2026-09-05T09:40:00Z', kind: 'task_done', title: 'Гейт зелёный' }],
      }),
    },
  });
  assert.equal(code, 0);
  const text = out.text();
  assert.match(text, /Паша — работает/);
  assert.match(text, /Ждут вас: 1 · решится само: 2 · всего: 4/);
  assert.match(text, /Купить прокси\?/);
  assert.match(text, /молчание значит «пробуем без»/);
  assert.match(text, /autopasha answer <id> да/);
});

test('feed --since 2h отсекает старое на нашей стороне, курсор не выдумывает', async () => {
  const env = await sandbox();
  const out = collect();
  const asked = [];
  const now = Date.now();
  const code = await run(['feed', '--since', '2h'], {
    env: { ...env, AUTOPASHA_TOKEN: 'ap_live_test' },
    out: out.write,
    err: out.write,
    client: {
      feed: async (q) => {
        asked.push(q);
        return {
          items: [
            { id: 'e-1', at: new Date(now - 5 * 3600_000).toISOString(), kind: 'note', title: 'позавчерашнее' },
            { id: 'e-2', at: new Date(now - 600_000).toISOString(), kind: 'task_done', title: 'свежее' },
          ],
          cursor: 'c-2',
        };
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(asked[0].since, undefined, 'срок не превращается в самодельный курсор');
  assert.match(out.text(), /свежее/);
  assert.doesNotMatch(out.text(), /позавчерашнее/);
});

test('answer переводит «да» в approved и передаёт комментарий', async () => {
  const env = await sandbox();
  const out = collect();
  let got;
  const code = await run(['answer', 'q-1', 'да', '--comment', 'бери бесплатный вариант'], {
    env: { ...env, AUTOPASHA_TOKEN: 'ap_live_test' },
    out: out.write,
    err: out.write,
    client: {
      answer: async (id, body) => {
        got = { id, body };
        return { id, decision: body.decision };
      },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(got, { id: 'q-1', body: { decision: 'approved', comment: 'бери бесплатный вариант' } });
  assert.match(out.text(), /Сотрудник разбужен/);
});

test('ask без текста не уходит на сервер', async () => {
  const env = await sandbox();
  const out = collect();
  let called = false;
  const code = await run(['ask'], {
    env: { ...env, AUTOPASHA_TOKEN: 'ap_live_test' },
    out: out.write,
    err: out.write,
    client: {
      ask: async () => {
        called = true;
        return {};
      },
    },
  });
  assert.equal(code, 1);
  assert.equal(called, false);
});

test('незнакомая команда — код 1 и подсказка, а не молчание', async () => {
  const out = collect();
  const code = await run(['статус'], { env: await sandbox(), out: out.write, err: out.write });
  assert.equal(code, 1);
  assert.match(out.text(), /не знаю команду/);
});

test('ошибка API в --json остаётся машинной', async () => {
  const out = collect();
  const err = collect();
  const code = await run(['status', '--json'], {
    env: { ...(await sandbox()), AUTOPASHA_TOKEN: 'ap_live_test' },
    out: out.write,
    err: err.write,
    client: {
      status: async () => {
        const { ApiCallError } = await import('../src/client.mjs');
        throw new ApiCallError({ status: 403, code: 'scope_missing', message: 'нет права', hint: 'заведите ключ', requestId: 'r-9' });
      },
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err.text()), {
    error: { code: 'scope_missing', message: 'нет права', hint: 'заведите ключ' },
    requestId: 'r-9',
  });
});

test('watch печатает новое и двигает курсор только по напечатанному', async () => {
  const out = collect();
  const err = collect();
  const asked = [];
  let round = 0;
  const client = {
    feed: async (q) => {
      asked.push(q);
      round += 1;
      if (round === 1) return { items: [], cursor: 'c-0' };
      if (round === 2) return { items: [{ at: '2026-09-05T10:00:00Z', kind: 'task_done', title: 'первое' }], cursor: 'c-1' };
      return { items: [{ at: '2026-09-05T10:01:00Z', kind: 'note', title: 'второе' }], cursor: 'c-2' };
    },
  };
  let left = 2;
  const code = await watchLoop({
    client,
    opts: {},
    out: out.write,
    err: err.write,
    sleep: async () => {},
    shouldContinue: () => left-- > 0,
  });

  assert.equal(code, 0);
  assert.equal(asked[1].since, 'c-0', 'опрос начинается с хвоста, а не с начала ленты');
  assert.equal(asked[2].since, 'c-1');
  assert.match(out.text(), /первое/);
  assert.match(out.text(), /второе/);
});

test('watch переживает обрыв сети и не теряет место в ленте', async () => {
  const out = collect();
  const err = collect();
  const asked = [];
  let round = 0;
  const client = {
    feed: async (q) => {
      asked.push(q);
      round += 1;
      if (round === 1) return { items: [], cursor: 'c-0' };
      if (round === 2) throw new (await import('../src/client.mjs')).NetworkError('не достучался');
      return { items: [{ at: '2026-09-05T10:00:00Z', kind: 'note', title: 'после обрыва' }], cursor: 'c-1' };
    },
  };
  let left = 2;
  const code = await watchLoop({
    client,
    opts: {},
    out: out.write,
    err: err.write,
    sleep: async () => {},
    shouldContinue: () => left-- > 0,
  });

  assert.equal(code, 0);
  assert.equal(asked[2].since, 'c-0', 'после обрыва повторяем тот же курсор, а не следующий');
  assert.match(err.text(), /повтор через/);
  assert.match(out.text(), /после обрыва/);
});

test('watch не крутится вхолостую на 403 — это не лечится ожиданием', async () => {
  const out = collect();
  const err = collect();
  const { ApiCallError } = await import('../src/client.mjs');
  let round = 0;
  const client = {
    feed: async () => {
      round += 1;
      if (round === 1) return { items: [], cursor: 'c-0' };
      throw new ApiCallError({ status: 403, code: 'scope_missing', message: 'нет права read', hint: 'заведите ключ' });
    },
  };
  const code = await watchLoop({
    client,
    opts: {},
    out: out.write,
    err: err.write,
    sleep: async () => {},
    shouldContinue: () => true,
  });
  assert.equal(code, 1);
  assert.match(err.text(), /нет права read/);
});
