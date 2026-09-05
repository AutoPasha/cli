import { randomUUID } from 'node:crypto';

/**
 * Клиент API. Тонкий слой поверх `fetch`, вся его ценность — в трёх местах:
 * заголовок с ключом, повтор без второго срабатывания и ошибка, которую можно
 * показать человеку.
 */

export class ApiCallError extends Error {
  constructor({ status, code, message, hint, requestId }) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.requestId = requestId;
  }
}

/** Сеть, а не сервис: отдельным типом, потому что её лечит повтор, а не правка запроса. */
export class NetworkError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ api, token, fetchImpl = fetch, retries = 2, onRetry }) {
  if (!token) {
    throw new ApiCallError({
      status: 0,
      code: 'no_token',
      message: 'не вижу ключа',
      hint: 'наберите autopasha login и вставьте ключ из кабинета (раздел «API»), либо задайте AUTOPASHA_TOKEN',
    });
  }
  // Ключ уходит заголовком, а заголовок — это байты. Русская буква или кавычка,
  // прилипшая при копировании, роняет `fetch` изнутри с «Cannot convert argument
  // to a ByteString», и человек ищет поломку в сети, а не в своей строке.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new ApiCallError({
      status: 0,
      code: 'bad_token',
      message: 'в ключе есть символы, которых в ключе не бывает',
      hint: 'ключ выглядит как ap_live_ и 32 знака латиницей и цифрами — скопируйте его целиком, без кавычек и пробелов',
    });
  }
  const base = api.replace(/\/+$/, '');

  async function request(method, path, { body, query, idempotencyKey } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'autopasha-cli',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      // Ключ повтора один на все попытки одного вызова — в этом весь смысл:
      // сеть моргнула на ответе, задача уже принята, и вторая попытка обязана
      // получить тот же ответ, а не поставить сотруднику дубль.
      headers['Idempotency-Key'] = idempotencyKey ?? randomUUID();
    }

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt) {
        const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
        onRetry?.({ attempt, wait, error: lastError });
        await sleep(wait);
      }
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        lastError = new NetworkError(`не достучался до ${url.origin}: ${e.message}`);
        continue;
      }

      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('json')) {
        // Не JSON на нашем адресе — это почти всегда чужой ответ: прокси
        // компании, страница входа отеля, заглушка. Показать её как ошибку API
        // значит соврать про причину.
        const text = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
        throw new ApiCallError({
          status: res.status,
          code: 'not_api',
          message: `по адресу ${url.origin} ответил не API (${res.status})`,
          hint: text ? `начало ответа: ${text}` : 'проверьте --api и что запрос не заворачивает прокси',
        });
      }

      const payload = await res.json();
      if (res.ok) return payload;

      const err = new ApiCallError({
        status: res.status,
        code: payload?.error?.code ?? 'unknown',
        message: payload?.error?.message ?? `ответ ${res.status}`,
        hint: payload?.error?.hint ?? '',
        requestId: payload?.requestId,
      });
      // 5xx повторяем, 4xx нет: 401 и 403 не вылечатся ожиданием, а 429 несёт
      // свой срок в заголовке, и наш спуск по степеням двойки его не знает.
      if (res.status >= 500 && attempt < retries) {
        lastError = err;
        continue;
      }
      if (res.status === 429) {
        const reset = Number(res.headers.get('RateLimit-Reset') ?? 0);
        if (reset > 0) err.hint = `${err.hint} Подождите ${reset} с.`.trim();
      }
      throw err;
    }

    throw lastError ?? new NetworkError('запрос не удался');
  }

  return {
    base,
    me: () => request('GET', '/me'),
    status: () => request('GET', '/status'),
    feed: (query) => request('GET', '/feed', { query }),
    tasks: () => request('GET', '/tasks'),
    questions: () => request('GET', '/questions'),
    plans: () => request('GET', '/plans'),
    report: (id) => request('GET', `/reports/${encodeURIComponent(id)}`),
    ask: (body, idempotencyKey) => request('POST', '/tasks', { body, idempotencyKey }),
    say: (body, idempotencyKey) => request('POST', '/chat', { body, idempotencyKey }),
    answer: (id, body, idempotencyKey) =>
      request('POST', `/questions/${encodeURIComponent(id)}/answer`, { body, idempotencyKey }),
    request,
  };
}
