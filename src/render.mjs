/**
 * Человеческий вывод. Он по умолчанию, а `--json` — по требованию: команду
 * набирает и человек тоже, а таблица JSON в терминале читается хуже, чем две
 * строки словами.
 *
 * Всё время в API — UTC; здесь оно переводится в зону машины. Это единственное
 * место, где мы вообще форматируем время: агенту в `--json` уходит исходный ISO.
 */

export function clock(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? time : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function line(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function renderStatus(s, now = new Date()) {
  const out = [];
  const e = s.employee ?? {};
  out.push(
    line(
      `${e.name ?? 'сотрудник'} — ${e.state ?? 'неизвестно'}`,
      e.since ? `с ${clock(e.since, now)}` : '',
      e.doing ? `· ${e.doing}` : '',
    ),
  );
  if (e.headline && e.headline !== e.doing) out.push(e.headline);

  const w = s.waiting ?? {};
  out.push(`Ждут вас: ${w.onOwner ?? 0} · решится само: ${w.selfResolving ?? 0} · всего: ${w.total ?? 0}`);

  if (s.questions?.length) {
    out.push('', 'Вопросы:');
    for (const q of s.questions) {
      out.push(`  ${q.id}`);
      out.push(`    ${q.question}`);
      const tail = [];
      if (q.ifSilent) tail.push(`молчание значит «${q.ifSilent}»`);
      else tail.push('без ответа встанет');
      if (q.expiresAt) tail.push(`до ${clock(q.expiresAt, now)}`);
      out.push(`    ${tail.join(', ')}`);
    }
    out.push('', 'Ответить: autopasha answer <id> да --comment "…"');
  }

  if (s.recent?.length) {
    out.push('', 'Последнее:');
    for (const r of s.recent) out.push(`  ${clock(r.at, now)}  ${r.kind}  ${r.title}`);
  }
  return out.join('\n');
}

export function renderEvent(e, now = new Date()) {
  return line(clock(e.at, now), e.kind, '·', e.title, e.project ? `[${e.project}]` : '');
}

export function renderFeed(items, now = new Date()) {
  if (!items.length) return 'ничего нового';
  return items.map((e) => renderEvent(e, now)).join('\n');
}

export function renderError(e) {
  const out = [`Ошибка: ${e.message}`];
  if (e.hint) out.push(`  ${e.hint}`);
  if (e.requestId) out.push(`  requestId: ${e.requestId}`);
  return out.join('\n');
}
