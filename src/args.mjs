/**
 * Разбор аргументов. Своими руками, а не библиотекой: единственная зависимость
 * в пакете, который зовут через `npx`, стоит секунды на каждом запуске, а
 * агент дёргает нас в цикле.
 *
 * Форма нарочно скучная: `--ключ значение` и `--ключ=значение`, всё остальное —
 * позиционные слова. Флаги без значения перечислены списком, иначе `--json ask`
 * съел бы команду как значение флага.
 */

const FLAGS = new Set(['json', 'help', 'version', 'verbose']);

export function parseArgs(argv) {
  const opts = {};
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      opts[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (FLAGS.has(body)) {
      opts[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      // Значение не пришло. Молча считать флагом нельзя: `--since` без
      // значения — это опечатка, и ответ «показал последние 20» вместо неё
      // выглядит как работающая команда.
      throw new UsageError(`у --${body} нет значения`);
    }
    opts[body] = next;
    i += 1;
  }

  return { command: rest[0], args: rest.slice(1), opts };
}

/** Ошибка вызывающего, а не сервиса: печатается без «у нас сломалось». */
export class UsageError extends Error {}

const DURATION = /^(\d+)([smhd])$/;

/**
 * `--since 2h` — это «за последние два часа», а не курсор.
 *
 * Курсор у ленты непрозрачный (внутри время и id события), и собирать его
 * руками на стороне CLI значит завязаться на его формат. Поэтому срок
 * превращается в фильтр по времени уже над ответом: запрашиваем побольше и
 * отсекаем старое. Всё, что не похоже на срок, уходит на сервер как курсор.
 */
export function parseSince(value) {
  if (!value) return { kind: 'none' };
  const m = DURATION.exec(value.trim());
  if (!m) return { kind: 'cursor', cursor: value };
  const n = Number(m[1]);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return { kind: 'ago', ms: n * mult };
}

const YES = new Set(['да', 'ага', 'y', 'yes', 'ok', 'ок', 'approve', 'approved']);
const NO = new Set(['нет', 'не', 'n', 'no', 'decline', 'declined', 'reject']);

/**
 * «да» и «нет» словами, потому что так пишет человек, диктующий агенту.
 * `approved`/`declined` тоже приняты: агент, читавший справочник ручек, наберёт
 * их, и заставлять его переводить обратно на русский — лишний шаг на пустом месте.
 */
export function parseDecision(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (YES.has(w)) return 'approved';
  if (NO.has(w)) return 'declined';
  throw new UsageError(`решение должно быть «да» или «нет», а не «${word}»`);
}
