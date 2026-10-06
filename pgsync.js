'use strict';
// Постоянное хранение на хостингах со стираемым диском (Render и т.п.).
// Рабочая база остаётся SQLite-файлом, а её снимок и скриншоты хранятся в PostgreSQL (переменная DATABASE_URL).
// Старт: снимок скачивается из Postgres в файл. Работа: каждые 5 сек, если база менялась, снимок уходит в Postgres.
// Остановка (SIGTERM при деплое/сне): последний снимок отправляется перед выходом.
const fs = require('fs'), path = require('path');
const URL_ = process.env.DATABASE_URL;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'ink.db');
const UP = path.join(__dirname, 'uploads');
let pool = null, inited = null;

function getPool() {
  if (!URL_) return null;
  if (!pool) {
    const { Pool } = require('pg');
    const host = (URL_.match(/@([^:/?]+)/) || [])[1] || '';
    // внутренний адрес Render (без точки в имени хоста) идёт без SSL, внешние адреса (Neon, Supabase, Render external) требуют SSL
    pool = new Pool({ connectionString: URL_, max: 3, ssl: process.env.PGSSL === 'off' || !host.includes('.') ? false : { rejectUnauthorized: false } });
    pool.on('error', e => console.error('pg:', e.message));
  }
  return pool;
}
function init() {
  const p = getPool();
  return inited || (inited = p.query('CREATE TABLE IF NOT EXISTS ink_snapshot(id INT PRIMARY KEY, data BYTEA NOT NULL, updated TIMESTAMPTZ DEFAULT now())')
    .then(() => p.query('CREATE TABLE IF NOT EXISTS ink_files(name TEXT PRIMARY KEY, data BYTEA NOT NULL)')));
}
const put = buf => getPool().query('INSERT INTO ink_snapshot(id,data,updated) VALUES(1,$1,now()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, updated=now()', [buf]);

async function restore() {
  if (!getPool()) return;
  try {
    await init();
    const r = await getPool().query('SELECT data FROM ink_snapshot WHERE id=1');
    if (r.rows[0]) { fs.writeFileSync(DB_FILE, r.rows[0].data); fs.rmSync(DB_FILE + '-journal', { force: true }); console.log(`PG: база восстановлена (${r.rows[0].data.length} байт)`); }
    else console.log('PG: снимка ещё нет, используем текущую базу');
  } catch (e) { console.error('PG: восстановление не удалось, работаем с локальной базой:', e.message); }
  await getPool().end().catch(() => {});
}
async function push() {   // для CLI (set-role): отправить текущий файл базы
  if (!getPool()) return;
  try { await init(); await put(fs.readFileSync(DB_FILE)); console.log('PG: снимок сохранён'); } catch (e) { console.error('PG: не удалось сохранить:', e.message); }
  await getPool().end().catch(() => {});
}
async function snapshot(db) {
  let buf;
  if (typeof db.serialize === 'function') buf = db.serialize();
  else { const t = DB_FILE + '.snap'; await db.backup(t); buf = fs.readFileSync(t); fs.rmSync(t, { force: true }); }
  await put(buf);
}
function start(db) {
  if (!getPool()) { console.log('DATABASE_URL не задан: база лежит только в локальном файле (на бесплатном хостинге она сотрётся при перезапуске)'); return; }
  let last = -1, busy = false;
  const changes = () => db.prepare('SELECT total_changes() c').get().c;
  const tick = async force => {
    if (busy) return; busy = true;
    try { await init(); const c = changes(); if (force || c !== last) { await snapshot(db); last = c; } }
    catch (e) { console.error('PG: снимок не отправлен:', e.message); } finally { busy = false; }
  };
  const timer = setInterval(tick, 5000);
  let bye = false;
  const stop = async () => {
    if (bye) return; bye = true; clearInterval(timer);
    for (let i = 0; busy && i < 100; i++) await new Promise(r => setTimeout(r, 50));
    await tick(true); process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  tick(); console.log('PG: снимки базы включены');
}
async function saveFile(name) {   // скриншот результата -> Postgres
  if (!getPool()) return; await init();
  await getPool().query('INSERT INTO ink_files(name,data) VALUES($1,$2) ON CONFLICT(name) DO NOTHING', [name, fs.readFileSync(path.join(UP, name))]);
}
async function ensureFile(name) {   // если файла нет на диске (после перезапуска), достаём из Postgres
  const f = path.join(UP, name); if (fs.existsSync(f) || !getPool()) return;
  await init(); const r = await getPool().query('SELECT data FROM ink_files WHERE name=$1', [name]);
  if (r.rows[0]) fs.writeFileSync(f, r.rows[0].data);
}
module.exports = { start, saveFile, ensureFile };
if (require.main === module) {
  const c = process.argv[2];
  (c === 'restore' ? restore() : c === 'push' ? push() : Promise.resolve()).then(() => process.exit(0));
}
