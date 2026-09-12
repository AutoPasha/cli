# Что менялось

Формат по [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по
[семверу](https://semver.org/lang/ru/).

## [Не выпущено]

## [0.1.1] - 2026-09-12

### Изменено

- В пакет уехал переписанный README: быстрый старт, снимки терминала с живым
  выводом, кодекс общения.
- Публикация идёт из GitHub Actions по OIDC: npm берёт короткий ключ у GitHub,
  долгоживущий токен в реестр больше не отправляется.

## [0.1.0] - 2026-09-05

Первый выпуск.

### Добавлено

- Команды `login`, `status`, `feed`, `ask`, `answer`, `say`, `watch`, `skill`.
- Профили и ключ в `~/.autopasha/config.json` с правами 0600, переменная
  `AUTOPASHA_TOKEN` для CI.
- `--json` у всех команд, код возврата 0 или 1.
- Повтор запроса при 5xx и обрыве сети, ключ идемпотентности у запросов,
  которые что-то меняют.
- Умение для агента: `autopasha skill`.

[Не выпущено]: https://github.com/AutoPasha/cli/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/AutoPasha/cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AutoPasha/cli/releases/tag/v0.1.0
