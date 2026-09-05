import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs, parseDecision, parseSince, UsageError } from './args.mjs';
import { configPath, DEFAULT_API, profileName, resolveAuth, saveProfile } from './config.mjs';
import { ApiCallError, createClient, NetworkError } from './client.mjs';
import { renderError, renderEvent, renderFeed, renderStatus } from './render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Версия живёт в package.json и только там: вторая копия в коде рано или поздно
// разойдётся с опубликованной, и `autopasha --version` начнёт врать.
export const VERSION = createRequire(import.meta.url)('../package.json').version;

const HELP = `autopasha — командная строка АвтоПаши.

  autopasha login [--token ap_live_…]   принять ключ из кабинета и запомнить
  autopasha status                      чем занят сотрудник, что стоит, что спрашивает
  autopasha feed [--since 2h]           что произошло
  autopasha ask "текст" [--why "…"]     поставить задачу
  autopasha answer <id> да|нет [--comment "…"]   ответить на вопрос
  autopasha say "текст"                 реплика в разговор
  autopasha watch [--since 1h]          ждать событий и печатать их построчно
  autopasha skill                       напечатать умение для своего агента

Общее: --json (машинный вывод), --profile <имя>, --api <адрес>, --version.
Ключ берётся из AUTOPASHA_TOKEN, если он задан, иначе из ~/.autopasha/config.json.
Справочник: https://autopasha.ru/docs/api`;

/**
 * Точка входа. Возвращает код возврата, а не зовёт `process.exit`: так её
 * можно прогнать тестом и так же честно ответить вызывающему скрипту.
 */
export async function run(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const env = io.env ?? process.env;

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`Ошибка: ${e.message}`);
    err(HELP);
    return 1;
  }
  const { command, args, opts } = parsed;

  if (opts.version) {
    out(VERSION);
    return 0;
  }
  if (!command || opts.help || command === 'help') {
    out(HELP);
    return command || opts.help ? 0 : 1;
  }
  if (command === 'skill') {
    out(await readFile(join(HERE, '..', 'skill', 'SKILL.md'), 'utf8'));
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    err(`Ошибка: не знаю команду «${command}»`);
    err(HELP);
    return 1;
  }

  try {
    const auth = await resolveAuth(opts, env);
    // У `login` ключа в конфиге ещё нет — он его как раз и приносит. Общий
    // клиент здесь упал бы с «не вижу ключа» на команде, которая ключ вводит.
    const client =
      command === 'login'
        ? io.client
        : (io.client ??
          createClient({
            api: auth.api,
            token: auth.token,
            fetchImpl: io.fetchImpl ?? fetch,
            onRetry: ({ wait, error }) => err(`# ${error?.message ?? 'сбой'} — повтор через ${wait / 1000} с`),
          }));
    return await handler({ client, args, opts, out, err, env, auth, io });
  } catch (e) {
    if (e instanceof UsageError) {
      err(`Ошибка: ${e.message}`);
      return 1;
    }
    if (e instanceof ApiCallError) {
      err(opts.json ? JSON.stringify({ error: { code: e.code, message: e.message, hint: e.hint }, requestId: e.requestId }) : renderError(e));
      return 1;
    }
    if (e instanceof NetworkError) {
      err(`Ошибка: ${e.message}`);
      return 1;
    }
    err(`Ошибка: ${e.message}`);
    return 1;
  }
}

const COMMANDS = {
  login: cmdLogin,
  status: cmdStatus,
  feed: cmdFeed,
  ask: cmdAsk,
  answer: cmdAnswer,
  say: cmdSay,
  watch: cmdWatch,
};

/**
 * `login` проверяет ключ живым запросом, а не «похож на ключ».
 *
 * Записать непроверенный ключ дешевле, но тогда первая же настоящая команда
 * упадёт с 401, и человек будет искать ошибку в ней, а не во входе.
 */
async function cmdLogin({ args, opts, out, err, env, io }) {
  const token = (opts.token || args[0] || env.AUTOPASHA_TOKEN || (await readStdin(io))).trim();
  if (!token) {
    err('Ошибка: не вижу ключа');
    err('  Ключ заводится в кабинете, раздел «API». Дальше: autopasha login --token ap_live_…');
    return 1;
  }

  const api = opts.api || env.AUTOPASHA_API || DEFAULT_API;
  const client = io.client ?? createClient({ api, token, fetchImpl: io.fetchImpl ?? fetch });
  const me = await client.me();

  const name = profileName(opts, env);
  const path = await saveProfile(name, { token, api }, env);

  if (opts.json) {
    out(JSON.stringify({ ...me, profile: name, config: path }, null, 2));
    return 0;
  }
  out(`Ключ принят: ${me.client?.title ?? 'клиент'}, сотрудник ${me.employee?.name ?? '—'}.`);
  out(`Права ключа: ${(me.key?.scopes ?? []).join(', ') || 'нет'}`);
  out(`Профиль «${name}» записан в ${path} (права 0600).`);
  return 0;
}

async function cmdStatus({ client, opts, out }) {
  const s = await client.status();
  out(opts.json ? JSON.stringify(s, null, 2) : renderStatus(s));
  return 0;
}

async function cmdFeed({ client, opts, out }) {
  const since = parseSince(opts.since);
  const limit = opts.limit ? Number(opts.limit) : undefined;

  if (since.kind === 'ago') {
    // Срок отсекаем над ответом: курсор ленты непрозрачный, и собирать его из
    // времени на стороне CLI значило бы завязаться на его внутренний вид.
    const cutoff = Date.now() - since.ms;
    const page = await client.feed({ limit: limit ?? 100 });
    const items = (page.items ?? []).filter((e) => new Date(e.at).getTime() >= cutoff);
    out(opts.json ? JSON.stringify({ ...page, items }, null, 2) : renderFeed(items));
    return 0;
  }

  const page = await client.feed({ since: since.kind === 'cursor' ? since.cursor : undefined, limit });
  out(opts.json ? JSON.stringify(page, null, 2) : renderFeed(page.items ?? []));
  return 0;
}

async function cmdAsk({ client, args, opts, out }) {
  const text = args.join(' ').trim();
  if (!text) throw new UsageError('нечего ставить: autopasha ask "что сделать"');
  const res = await client.ask({ text, why: opts.why }, opts['idempotency-key']);
  if (opts.json) {
    out(JSON.stringify(res, null, 2));
    return 0;
  }
  out(`Задача поставлена: ${res.id}`);
  out('Судьба — autopasha status, или autopasha watch, чтобы дождаться отчёта.');
  return 0;
}

async function cmdAnswer({ client, args, opts, out }) {
  const [id, word] = args;
  if (!id) throw new UsageError('нужен id вопроса: autopasha answer <id> да');
  const decision = parseDecision(word);
  const res = await client.answer(id, { decision, comment: opts.comment }, opts['idempotency-key']);
  if (opts.json) {
    out(JSON.stringify(res, null, 2));
    return 0;
  }
  out(`Ответ записан: ${decision === 'approved' ? 'да' : 'нет'}${opts.comment ? ` — ${opts.comment}` : ''}`);
  out('Сотрудник разбужен и вернётся к этому делу.');
  return 0;
}

async function cmdSay({ client, args, opts, out }) {
  const text = args.join(' ').trim();
  if (!text) throw new UsageError('нечего говорить: autopasha say "текст"');
  const res = await client.say({ text }, opts['idempotency-key']);
  out(opts.json ? JSON.stringify(res, null, 2) : 'Сказал.');
  return 0;
}

async function cmdWatch(ctx) {
  return watchLoop(ctx);
}

/**
 * `watch` — опрос ленты по курсору, а не открытое соединение.
 *
 * Опрос честнее выглядит слабее, но именно он переживает разрыв: у нас нет
 * состояния на сервере, и после любого обрыва мы просто повторяем запрос с тем
 * же курсором. Событий между заходами не теряется — курсор двигается только на
 * то, что мы уже напечатали. Когда появятся вебхуки, они лягут рядом, а не
 * вместо: приёмник вебхука нужен снаружи, а `watch` работает с ноутбука.
 */
export async function watchLoop({ client, opts, out, err, sleep = defaultSleep, shouldContinue = () => true }) {
  const intervalMs = Math.max(2, Number(opts.interval ?? 20)) * 1000;
  const since = parseSince(opts.since);

  let cursor = since.kind === 'cursor' ? since.cursor : undefined;
  let printedFirst = false;

  if (!cursor) {
    // Первый заход: берём хвост ленты, чтобы было от чего оттолкнуться. Со
    // сроком (`--since 2h`) печатаем и его — агент, поднятый после простоя,
    // должен увидеть, что он проспал.
    const page = await client.feed({ limit: since.kind === 'ago' ? 100 : 1 });
    cursor = page.cursor ?? undefined;
    if (since.kind === 'ago') {
      const cutoff = Date.now() - since.ms;
      for (const e of (page.items ?? []).filter((x) => new Date(x.at).getTime() >= cutoff)) {
        out(opts.json ? JSON.stringify(e) : renderEvent(e));
      }
    }
    printedFirst = true;
  }

  let backoff = 0;
  while (shouldContinue()) {
    await sleep(backoff || (printedFirst ? intervalMs : 0));
    printedFirst = true;
    try {
      const page = await client.feed({ since: cursor, limit: 100 });
      for (const e of page.items ?? []) out(opts.json ? JSON.stringify(e) : renderEvent(e));
      cursor = page.cursor ?? cursor;
      backoff = 0;
    } catch (e) {
      if (e instanceof ApiCallError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        err(renderError(e));
        return 1;
      }
      // Сеть, 5xx и упёршийся лимит: ждём дольше и продолжаем. Выйти здесь
      // значит бросить агента без глаз ровно тогда, когда он их и ждёт.
      backoff = Math.min(backoff ? backoff * 2 : intervalMs, 5 * 60_000);
      err(`# ${e.message} — повтор через ${Math.round(backoff / 1000)} с`);
    }
  }
  return 0;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readStdin(io = {}) {
  if (io.stdin !== undefined) return io.stdin;
  if (process.stdin.isTTY) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question('Ключ из кабинета (ap_live_…): ');
    rl.close();
    return answer;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export { configPath };
