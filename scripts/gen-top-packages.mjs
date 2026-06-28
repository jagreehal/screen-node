#!/usr/bin/env node
// Generate data/top-packages.json: a corpus of popular npm package names used by the
// typosquat signal (a name one or two edits away from a popular package is suspicious).
//
// We derive our OWN corpus from npm's public search API rather than shipping someone
// else's list. The search API caps paging at `from + size <= 250` per query, so breadth
// comes from many seed queries (letters, digits, keywords, popular scopes); we keep the
// best popularity score seen for each name, then take the top N. Re-run with:
//
//   node scripts/gen-top-packages.mjs [count]
//
// It's intentionally reproducible-ish (npm popularity is stable) and fully self-contained.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Cap deliberately modest: typosquat signal wants the POPULAR set (what attackers mimic), and a
// bloated list of obscure names only adds edit-distance-2 false positives. CORE is always kept;
// the rest fills from the most-popular search hits.
const COUNT = Number(process.argv[2] ?? 2500);
const REGISTRY = process.env.SCREEN_NPM_REGISTRY ?? 'https://registry.npmjs.org';
const PAGE = 250; // API max for size (and from + size must be <= 250)

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const KEYWORDS = [
  'cli', 'react', 'vue', 'angular', 'svelte', 'types', 'test', 'testing', 'build', 'bundler',
  'server', 'http', 'https', 'util', 'utils', 'parse', 'parser', 'stream', 'promise', 'async',
  'config', 'logger', 'log', 'date', 'time', 'string', 'array', 'object', 'json', 'yaml',
  'css', 'sass', 'webpack', 'rollup', 'vite', 'babel', 'eslint', 'prettier', 'typescript',
  'node', 'express', 'koa', 'fastify', 'router', 'middleware', 'auth', 'jwt', 'crypto', 'hash',
  'fs', 'path', 'glob', 'watch', 'env', 'dotenv', 'color', 'ansi', 'terminal', 'prompt',
  'graphql', 'rest', 'api', 'sdk', 'aws', 'gcp', 'azure', 'database', 'sql', 'orm', 'mongodb',
  'redis', 'cache', 'queue', 'websocket', 'socket', 'event', 'emitter', 'validation', 'schema',
  'markdown', 'html', 'dom', 'jsx', 'next', 'nuxt', 'electron', 'mobile', 'native', 'icon',
];
const SCOPES = [
  '@types/', '@babel/', '@angular/', '@aws-sdk/', '@vue/', '@nestjs/', '@emotion/',
  '@mui/', '@reduxjs/', '@tanstack/', '@storybook/', '@nrwl/', '@nx/', '@octokit/',
  '@google-cloud/', '@azure/', '@sentry/', '@fortawesome/', '@radix-ui/', '@vitejs/',
  '@typescript-eslint/', '@testing-library/', '@playwright/', '@swc/', '@trpc/',
];

const SEEDS = [...LETTERS, ...KEYWORDS, ...SCOPES];

// Curated core of the genuinely-popular / most-typosquatted npm packages. npm's search
// relevance won't reliably surface all of these from token seeds, and for typosquatting the
// high-value corpus IS the popular set attackers mimic — so we always include these, then let
// the search pass add breadth. Keep this to real, well-known packages: every name here is a
// thing a fresh install one or two edits away from it should be suspicious of.
const CORE = [
  // frameworks / view layers
  'react', 'react-dom', 'react-native', 'vue', 'vue-router', 'vuex', 'svelte', 'preact',
  'angular', '@angular/core', '@angular/common', 'next', 'nuxt', 'gatsby', 'remix', 'astro',
  'solid-js', 'lit', 'ember-source', 'backbone', 'jquery', 'alpinejs',
  // node servers / http
  'express', 'koa', 'fastify', 'hapi', '@hapi/hapi', 'restify', 'connect', 'body-parser',
  'cors', 'helmet', 'morgan', 'compression', 'cookie-parser', 'express-session', 'multer',
  'http-proxy', 'http-proxy-middleware', 'socket.io', 'ws', 'undici', 'node-fetch', 'got',
  'axios', 'superagent', 'request', 'cross-fetch', 'ky',
  // utils
  'lodash', 'lodash.merge', 'underscore', 'ramda', 'immutable', 'rxjs', 'date-fns', 'dayjs',
  'moment', 'luxon', 'uuid', 'nanoid', 'classnames', 'clsx', 'qs', 'query-string', 'deepmerge',
  'fast-deep-equal', 'object-assign', 'extend', 'merge', 'clone', 'is-plain-object',
  // cli / terminal
  'chalk', 'colors', 'kleur', 'picocolors', 'ansi-styles', 'ansi-regex', 'strip-ansi',
  'supports-color', 'commander', 'yargs', 'yargs-parser', 'minimist', 'meow', 'inquirer',
  'prompts', 'enquirer', 'ora', 'cli-spinners', 'boxen', 'cli-table3', 'figlet', 'chalk-template',
  'debug', 'signale', 'log-symbols', 'listr', 'execa', 'cross-spawn', 'shelljs',
  // build / bundlers / transpilers
  'webpack', 'webpack-cli', 'webpack-dev-server', 'rollup', 'vite', 'esbuild', 'parcel',
  'babel', '@babel/core', '@babel/preset-env', '@babel/preset-react', '@babel/runtime',
  'typescript', 'ts-node', 'tsx', 'tsup', 'swc', '@swc/core', 'terser', 'uglify-js',
  'postcss', 'autoprefixer', 'cssnano', 'sass', 'node-sass', 'less', 'stylus', 'tailwindcss',
  // lint / format / test
  'eslint', 'prettier', 'stylelint', 'jest', 'vitest', 'mocha', 'chai', 'jasmine', 'ava',
  'sinon', 'nyc', 'c8', 'supertest', 'cypress', 'playwright', '@playwright/test', 'puppeteer',
  'testing-library', '@testing-library/react', '@testing-library/jest-dom', 'enzyme', 'karma',
  'husky', 'lint-staged', 'cross-env', 'rimraf', 'nodemon', 'concurrently', 'npm-run-all',
  // types
  '@types/node', '@types/react', '@types/express', '@types/lodash', '@types/jest',
  '@types/jquery', '@types/uuid',
  // env / config / fs
  'dotenv', 'dotenv-expand', 'cosmiconfig', 'rc', 'config', 'convict', 'env-cmd',
  'fs-extra', 'graceful-fs', 'glob', 'fast-glob', 'globby', 'chokidar', 'del', 'mkdirp',
  'find-up', 'pkg-dir', 'read-pkg', 'tmp', 'tempy',
  // data / validation / parsing
  'zod', 'yup', 'joi', 'ajv', 'class-validator', 'superstruct', 'io-ts', 'valibot',
  'semver', 'json5', 'js-yaml', 'yaml', 'toml', 'ini', 'dotenv-parse-variables', 'csv-parse',
  'papaparse', 'xml2js', 'fast-xml-parser', 'cheerio', 'jsdom', 'node-html-parser',
  'marked', 'markdown-it', 'remark', 'gray-matter', 'highlight.js', 'prismjs',
  // crypto / auth / security
  'bcrypt', 'bcryptjs', 'jsonwebtoken', 'jose', 'passport', 'passport-jwt', 'crypto-js',
  'argon2', 'uuid', 'helmet', 'csurf', 'express-rate-limit', 'cookie', 'jwt-decode',
  // databases / orm
  'mongoose', 'mongodb', 'mysql', 'mysql2', 'pg', 'pg-promise', 'sqlite3', 'better-sqlite3',
  'redis', 'ioredis', 'sequelize', 'typeorm', 'prisma', '@prisma/client', 'knex', 'drizzle-orm',
  'kysely', 'mikro-orm', 'objection',
  // state / data fetching (react ecosystem)
  'redux', '@reduxjs/toolkit', 'react-redux', 'zustand', 'jotai', 'recoil', 'mobx',
  'react-query', '@tanstack/react-query', 'swr', 'apollo-client', '@apollo/client', 'graphql',
  'react-router', 'react-router-dom', 'react-hook-form', 'formik', 'react-final-form',
  'styled-components', '@emotion/react', '@emotion/styled', 'react-spring', 'framer-motion',
  // ui kits
  '@mui/material', '@material-ui/core', 'antd', 'react-bootstrap', 'bootstrap', '@chakra-ui/react',
  '@radix-ui/react-dialog', 'react-icons', 'react-select', 'react-table', 'recharts', 'd3',
  'chart.js', 'three', 'pixi.js', 'leaflet', 'mapbox-gl',
  // backend frameworks / tooling
  '@nestjs/core', '@nestjs/common', 'nestjs', 'sequelize-cli', 'pino', 'winston', 'bunyan',
  'log4js', 'bull', 'bullmq', 'agenda', 'node-cron', 'cron', 'amqplib', 'kafkajs',
  'nodemailer', 'twilio', 'stripe', 'aws-sdk', '@aws-sdk/client-s3', 'firebase', 'firebase-admin',
  '@google-cloud/storage', '@azure/storage-blob', '@sentry/node', '@sentry/react', 'newrelic',
  // misc heavy hitters
  'core-js', 'regenerator-runtime', 'tslib', 'pollyfill', 'whatwg-fetch', 'abort-controller',
  'event-emitter', 'eventemitter3', 'p-limit', 'p-queue', 'p-map', 'p-retry', 'async', 'bluebird',
  'node-gyp', 'prebuild-install', 'sharp', 'canvas', 'jimp', 'image-size', 'multer-s3',
  'archiver', 'adm-zip', 'tar', 'unzipper', 'mime', 'mime-types', 'content-type', 'accepts',
  'dotenv-flow', 'slugify', 'pluralize', 'change-case', 'camelcase', 'kebab-case', 'lodash-es',
];

/** Popularity score for a search result, robust to API shape changes. */
function popularity(obj) {
  return obj?.score?.detail?.popularity ?? obj?.searchScore ?? 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(text) {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=${PAGE}&popularity=1.0`;
  // npm's search API rate-limits aggressively; retry 429/5xx with exponential backoff.
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const body = await res.json();
      return Array.isArray(body.objects) ? body.objects : [];
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`search "${text}" -> ${res.status}`);
  }
  throw new Error(`search "${text}" -> exhausted retries`);
}

async function main() {
  /** name -> best popularity score seen across seed queries */
  const best = new Map();
  let done = 0;
  for (const seed of SEEDS) {
    try {
      const objects = await search(seed);
      for (const o of objects) {
        const name = o?.package?.name;
        if (typeof name !== 'string') continue;
        const score = popularity(o);
        if (!best.has(name) || score > best.get(name)) best.set(name, score);
      }
    } catch (err) {
      process.stderr.write(`warn: ${err.message}\n`);
    }
    done++;
    process.stderr.write(`\r${done}/${SEEDS.length} seeds, ${best.size} unique names`);
    await sleep(400); // be gentle with the search API rate limiter
  }
  process.stderr.write('\n');

  // CORE is always included; search hits fill the remaining slots by popularity. Dedup + sort
  // alphabetically on disk for clean diffs.
  const searchFill = [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .filter((name) => !CORE.includes(name));
  const ranked = [...new Set([...CORE, ...searchFill])].slice(0, COUNT).sort();

  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'top-packages.json');
  writeFileSync(out, `${JSON.stringify(ranked, null, 0)}\n`);
  process.stderr.write(`wrote ${ranked.length} names to ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
