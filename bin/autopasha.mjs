#!/usr/bin/env node
import { run } from '../src/cli.mjs';

/**
 * Код возврата честный: 0 — сделано, 1 — не сделано. Скрипт, который зовёт
 * `autopasha ask` в цепочке, обязан узнать о провале из кода, а не вычитывать
 * его из текста.
 */
process.exitCode = await run(process.argv.slice(2));
