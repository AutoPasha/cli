import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Ключ на диске: `~/.autopasha/config.json`, права 0600.
 *
 * Профили нужны не для красоты: у разработчика на машине живут и его рабочий
 * клиент, и стенд, и чужой ключ, которым он что-то проверял. Один файл с одним
 * токеном кончается тем, что задача уезжает не тому сотруднику.
 *
 * `AUTOPASHA_TOKEN` старше файла — это путь для CI и для контейнера, где
 * домашнего каталога может не быть вовсе.
 */

export const DEFAULT_API = 'https://autopasha.ru/api/v1';

export function configPath(env = process.env) {
  return env.AUTOPASHA_CONFIG || join(env.AUTOPASHA_HOME || join(homedir(), '.autopasha'), 'config.json');
}

export async function readConfig(env = process.env) {
  try {
    const raw = await readFile(configPath(env), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { profiles: {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { profiles: {} };
    if (e instanceof SyntaxError) {
      throw new Error(`файл ${configPath(env)} не разбирается как JSON — удалите его и повторите autopasha login`);
    }
    throw e;
  }
}

/**
 * Пишем через временный файл: обрыв на записи не должен оставлять обрезанный
 * конфиг, из которого потом не читается ни один профиль. Права 0600 ставятся
 * до переименования — иначе между созданием и `chmod` файл с ключом секунду
 * лежит открытым для всей машины.
 */
export async function writeConfig(config, env = process.env) {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
  return path;
}

export function profileName(opts = {}, env = process.env) {
  return opts.profile || env.AUTOPASHA_PROFILE || 'default';
}

/**
 * Откуда взялся ключ, важно называть вслух: «не вижу ключа» с подсказкой про
 * `autopasha login` человек чинит сам, а «401 unauthorized» отправляет его
 * читать справочник.
 */
export async function resolveAuth(opts = {}, env = process.env) {
  const name = profileName(opts, env);
  const config = await readConfig(env);
  const profile = config.profiles?.[name] ?? {};

  const token = opts.token || env.AUTOPASHA_TOKEN || profile.token || '';
  const api = opts.api || env.AUTOPASHA_API || profile.api || DEFAULT_API;
  return { token, api, profile: name, saved: profile };
}

export async function saveProfile(name, data, env = process.env) {
  const config = await readConfig(env);
  config.profiles = config.profiles ?? {};
  config.profiles[name] = { ...config.profiles[name], ...data };
  return writeConfig(config, env);
}
