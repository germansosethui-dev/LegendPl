'use strict';
// InkPlatform server: Express + SQLite. Запуск: JWT_SECRET=... node server.js
const express = require('express'), Database = require('better-sqlite3'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), multer = require('multer'), rateLimit = require('express-rate-limit'),
  path = require('path'), fs = require('fs'), crypto = require('crypto');

process.on('uncaughtException', e => console.error('uncaught:', e));
process.on('unhandledRejection', e => console.error('unhandled:', e));
const PORT = process.env.PORT || 3000;
// Секрет подписи токенов: из переменной JWT_SECRET или из файла .jwt_secret (создаётся один раз, чтобы входы не слетали после перезапуска)
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  const sf = path.join(__dirname, '.jwt_secret');
  try { SECRET = fs.readFileSync(sf, 'utf8').trim(); }
  catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(sf, SECRET, { mode: 0o600 }); }
}
if (SECRET.length < 24) { console.error('JWT_SECRET слишком короткий (минимум 24 символа)'); process.exit(1); }
// Если задан DATABASE_URL (PostgreSQL), перед открытием базы подтягиваем сохранённый снимок — см. pgsync.js
if (process.env.DATABASE_URL) {
  try { require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'pgsync.js'), 'restore'], { stdio: 'inherit', timeout: 30000 }); }
  catch (e) { console.error('PG: восстановление не удалось:', e.message); }
}
const pgsync = require('./pgsync');
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'ink.db'));
db.pragma('busy_timeout = 5000'); db.pragma('synchronous = NORMAL'); // WAL не используем: он ломается на телефонах и общих папках
const UP = path.join(__dirname, 'uploads'); fs.mkdirSync(UP, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, nick TEXT UNIQUE COLLATE NOCASE, sid TEXT UNIQUE, pass TEXT,
  role TEXT DEFAULT 'user', elo INT DEFAULT 100, played INT DEFAULT 0, points INT DEFAULT 0, frame TEXT, banned_until INT DEFAULT 0,
  ban_reason TEXT, seen INT DEFAULT 0, created INT);
CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY AUTOINCREMENT, league TEXT, mode TEXT, map TEXT, status TEXT, winner TEXT, created INT);
CREATE TABLE IF NOT EXISTS mp(match_id INT, user_id INT, team TEXT, k INT DEFAULT 0, d INT DEFAULT 0, a INT DEFAULT 0,
  elo_delta INT DEFAULT 0, PRIMARY KEY(match_id,user_id));
CREATE TABLE IF NOT EXISTS subs(id INTEGER PRIMARY KEY, match_id INT, user_id INT, winner TEXT, k INT, d INT, a INT,
  file TEXT, status TEXT, created INT, UNIQUE(match_id,user_id));
CREATE TABLE IF NOT EXISTS friends(a INT, b INT, status TEXT, PRIMARY KEY(a,b));
CREATE TABLE IF NOT EXISTS owned(user_id INT, item TEXT, PRIMARY KEY(user_id,item));
CREATE TABLE IF NOT EXISTS claims(user_id INT, key TEXT, day TEXT, PRIMARY KEY(user_id,key,day));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, target TEXT, info TEXT, ts INT);
CREATE TABLE IF NOT EXISTS praises(match_id INT, from_id INT, to_id INT, PRIMARY KEY(match_id,from_id,to_id));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, reporter_id INT, reporter TEXT, target_id INT, target TEXT, reason TEXT,
  match_id TEXT, comment TEXT, status TEXT DEFAULT 'open', note TEXT, handler TEXT, created INT);
`);
// миграция старых баз: счётчик калибровки и стартовое Elo 100
try { db.exec('ALTER TABLE users ADD COLUMN played INT DEFAULT 0'); db.exec("UPDATE users SET played=(SELECT COUNT(*) FROM mp JOIN matches m ON m.id=mp.match_id WHERE mp.user_id=users.id AND m.status='done')"); db.exec('UPDATE users SET elo=100 WHERE played=0 AND elo=1500'); } catch {}
for (const q of ['ALTER TABLE matches ADD COLUMN score_a INT', 'ALTER TABLE matches ADD COLUMN score_b INT', 'ALTER TABLE subs ADD COLUMN score_a INT', 'ALTER TABLE subs ADD COLUMN score_b INT']) { try { db.exec(q); } catch {} }
try { db.exec('ALTER TABLE matches ADD COLUMN mode TEXT'); db.exec("UPDATE matches SET mode='5x5' WHERE mode IS NULL"); } catch {}

for (const q of ['ALTER TABLE matches ADD COLUMN rounds INT', 'ALTER TABLE matches ADD COLUMN deadline INT DEFAULT 0', 'ALTER TABLE matches ADD COLUMN turn TEXT',
  'ALTER TABLE matches ADD COLUMN banned TEXT', 'ALTER TABLE matches ADD COLUMN cap_a INT', 'ALTER TABLE matches ADD COLUMN cap_b INT',
  'ALTER TABLE mp ADD COLUMN accepted INT DEFAULT 1', 'ALTER TABLE mp ADD COLUMN vote INT', 'ALTER TABLE users ADD COLUMN avatar TEXT', 'ALTER TABLE users ADD COLUMN ava_v INT DEFAULT 0', 'ALTER TABLE users ADD COLUMN q_ban INT DEFAULT 0', 'ALTER TABLE mp ADD COLUMN cancel INT DEFAULT 0']) { try { db.exec(q); } catch {} }
db.exec('CREATE TABLE IF NOT EXISTS draft_chat(id INTEGER PRIMARY KEY, match_id INT, nick TEXT, team TEXT, text TEXT, ts INT)');

const RANK = { user: 0, moderator: 1, admin: 2 };

// Владельцы платформы: получают роль admin автоматически (при запуске и при регистрации).
// Список меняется переменной ADMIN_NICKS (через запятую).
const ADMINS = (process.env.ADMIN_NICKS || 'inknight666').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
if (ADMINS.length) db.prepare(`UPDATE users SET role='admin' WHERE lower(nick) IN (${ADMINS.map(() => '?').join(',')}) AND role!='admin'`).run(...ADMINS);

// CLI: node server.js users | node server.js set-role <ник> <user|moderator|admin>
if (process.argv[2] === 'users') {
  console.log('База:', db.name); console.table(db.prepare('SELECT id,nick,sid,role FROM users ORDER BY id').all()); process.exit(0);
}
if (process.argv[2] === 'set-role') {
  const [nick, role] = process.argv.slice(3);
  if (!nick || !(role in RANK)) { console.log('Использование: node server.js set-role <ник> <user|moderator|admin>'); process.exit(1); }
  const r = db.prepare('UPDATE users SET role=? WHERE lower(nick)=lower(?)').run(role, nick);
  console.log(r.changes ? `OK: ${nick} -> ${role}  (база: ${db.name})` : `Пользователь "${nick}" не найден в базе ${db.name}. Список: node server.js users`);
  if (r.changes && ADMINS.includes(nick.toLowerCase()) && role !== 'admin') console.log('Внимание: ник в ADMIN_NICKS, при запуске сервера он снова станет admin');
  db.close();
  if (process.env.DATABASE_URL) try { require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'pgsync.js'), 'push'], { stdio: 'inherit', timeout: 30000 }); } catch {}
  process.exit(0);
}

const now = () => Math.floor(Date.now() / 1000);
const pad = id => String(id).padStart(6, '0');           // номер матча: 000001
const wrap = f => (q, s, n) => Promise.resolve(f(q, s, n)).catch(n);
const bad = (s, c, m, x) => s.status(c).json({ error: m, ...x });
const audit = (actor, action, target, info) =>
  db.prepare('INSERT INTO audit(actor,action,target,info,ts) VALUES(?,?,?,?,?)').run(actor, action, String(target), info || '', now());
const device = q => /Android|iPhone|iPad|iPod|Mobile/i.test(q.headers['user-agent'] || '') ? 'phone' : 'pc';
const pub = u => ({ id: u.id, nick: u.nick, sid: u.sid, role: u.role, elo: u.played >= 10 ? u.elo : null, played: u.played, points: u.points, frame: u.frame, ava: u.ava_v || 0 }); // Elo скрыт, пока не пройдена калибровка (10 матчей)

function auth(q, s, n) {
  let p;
  try { p = jwt.verify((q.headers.authorization || '').slice(7), SECRET); } catch { return bad(s, 401, 'unauthorized'); }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.id);
  if (!u) return bad(s, 401, 'unauthorized');
  if (u.banned_until > now()) return bad(s, 403, 'banned', { reason: u.ban_reason, until: u.banned_until });
  if (now() - (u.seen || 0) > 30) db.prepare('UPDATE users SET seen=? WHERE id=?').run(now(), u.id); // не пишем в БД на каждый запрос
  q.user = u; n();
}
const need = r => (q, s, n) => RANK[q.user.role] >= RANK[r] ? n() : bad(s, 403, 'forbidden');

const app = express();
app.use((q, s, n) => { const t = Date.now(); s.on('finish', () => { const d = Date.now() - t; if (d > 300) console.log('МЕДЛЕННО', q.method, q.originalUrl, d + 'мс'); }); n(); });
app.set('trust proxy', 1);
app.use('/api/me/avatar', express.json({ limit: '400kb' }));   // аватар приходит уже уменьшенным (≈10–30 КБ), запас на случай PNG
app.use(express.json({ limit: '50kb' }));
const lim = rateLimit({ windowMs: 15 * 60e3, max: 30, standardHeaders: true });
app.get('/api/health', (q, s) => s.json({ ok: true }));
const sign = u => jwt.sign({ id: u.id }, SECRET, { expiresIn: '30d' });

/* ---------- Авторизация ---------- */
app.post('/api/auth/register', lim, wrap((q, s) => {
  const { nick, sid, password } = q.body || {};
  if (!/^[\wа-яА-ЯёЁ-]{3,16}$/.test(nick || '')) return bad(s, 400, 'Ник: 3–16 символов');
  if (!/^\d{6,12}$/.test(sid || '')) return bad(s, 400, 'Некорректный StandKnife ID');
  if (typeof password !== 'string' || password.length < 8) return bad(s, 400, 'Пароль минимум 8 символов');
  const admins = ADMINS;
  try {
    const r = db.prepare('INSERT INTO users(nick,sid,pass,role,elo,created) VALUES(?,?,?,?,100,?)')
      .run(nick, sid, bcrypt.hashSync(password, 10), admins.includes(nick.toLowerCase()) ? 'admin' : 'user', now());
    s.json({ token: sign({ id: r.lastInsertRowid }) });
  } catch (e) { if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return bad(s, 409, 'Ник или StandKnife ID уже заняты'); console.error(e); bad(s, 500, 'Ошибка базы данных: ' + e.message); }
}));
app.post('/api/auth/login', lim, wrap((q, s) => {
  const { nick, password } = q.body || {};
  const u = db.prepare('SELECT * FROM users WHERE nick=?').get(String(nick || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.pass)) return bad(s, 401, 'Неверный ник или пароль');
  if (u.banned_until > now()) return bad(s, 403, 'banned', { reason: u.ban_reason, until: u.banned_until });
  s.json({ token: sign(u), user: pub(u) });
}));

/* ---------- Профиль, рейтинг ---------- */
function stats(id) {
  const r = db.prepare(`SELECT COUNT(*) n, SUM(m.winner=p.team) w, COALESCE(SUM(p.k),0) k, COALESCE(SUM(p.d),0) d, COALESCE(SUM(p.a),0) a
    FROM mp p JOIN matches m ON m.id=p.match_id WHERE p.user_id=? AND m.status='done'`).get(id);
  const hist = db.prepare(`SELECT m.id,m.map,m.league,p.k,p.d,p.a,(m.winner=p.team) w FROM mp p JOIN matches m ON m.id=p.match_id
    WHERE p.user_id=? AND m.status='done' ORDER BY m.id DESC LIMIT 5`).all(id).map(h => ({ ...h, id: pad(h.id), w: !!h.w }));
  return { praises: db.prepare('SELECT COUNT(*) c FROM praises WHERE to_id=?').get(id).c, matches: r.n, wins: r.w || 0, kills: r.k, deaths: r.d, assists: r.a, calibration: Math.min(10, r.n), hist };
}
app.get('/api/me', auth, (q, s) => s.json({ user: pub(q.user), stats: { ...stats(q.user.id), calibration: Math.min(10, q.user.played) },
  owned: db.prepare('SELECT item FROM owned WHERE user_id=?').all(q.user.id).map(x => x.item) }));
app.get('/api/users/:nick', auth, (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE nick=?').get(q.params.nick);
  u ? s.json({ user: { nick: u.nick, sid: u.sid, elo: u.played >= 10 ? u.elo : null, frame: u.frame }, stats: stats(u.id) }) : bad(s, 404, 'Игрок не найден');
});

/* ---------- Аватарки ---------- */
const AVRE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;   // SVG запрещён намеренно (XSS)
app.get('/api/avatar/:id', (q, s) => {
  const u = db.prepare('SELECT avatar FROM users WHERE id=?').get(+q.params.id), m = u && u.avatar && AVRE.exec(u.avatar);
  if (!m) return s.status(404).end();
  s.set({ 'Content-Type': 'image/' + m[1], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  s.send(Buffer.from(m[2], 'base64'));
});
app.post('/api/me/avatar', auth, (q, s) => {
  const m = AVRE.exec(String((q.body || {}).image || ''));
  if (!m) return bad(s, 400, 'Нужна картинка JPG, PNG или WebP');
  const buf = Buffer.from(m[2], 'base64');
  const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'png' && buf.slice(1, 4).toString() === 'PNG') || (m[1] === 'webp' && buf.slice(8, 12).toString() === 'WEBP');
  if (!ok || buf.length > 200 * 1024) return bad(s, 400, 'Файл повреждён или слишком большой (до 200 КБ)');
  const v = now(); db.prepare('UPDATE users SET avatar=?, ava_v=? WHERE id=?').run(m[0], v, q.user.id); s.json({ ok: true, ava: v });
});
app.delete('/api/me/avatar', auth, (q, s) => { db.prepare('UPDATE users SET avatar=NULL, ava_v=0 WHERE id=?').run(q.user.id); s.json({ ok: true }); });

app.get('/api/leaderboard', (q, s) => {
  const t = '%' + String(q.query.q || '').replace(/[%_]/g, '') + '%';
  s.json(db.prepare('SELECT id,nick,sid,elo,played,frame,ava_v FROM users WHERE banned_until<=? AND played>=10 AND nick LIKE ? ORDER BY elo DESC, played DESC LIMIT 50').all(now(), t));
});
app.get('/api/stats', (q, s) => s.json({ players: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  matches: db.prepare("SELECT COUNT(*) c FROM matches WHERE status='done'").get().c }));

/* ---------- Подбор матча (PC League / Phone League) ---------- */
const MAPS = ['Sandstone', 'Province', 'Breeze', 'Dune', 'Rust', 'Hanami'];   // пул драфта: банят по очереди, остаётся одна
const ROUNDS = [10, 13, 16, 19], DSEC = 30, VOTE_SEC = 15, BAN_SEC = 15, QBAN_SEC = 300, DRAFT = ['accept', 'ban', 'rounds'];
const rnd = a => a[Math.floor(Math.random() * a.length)];
const MODES = { '1x1': 2, '2x2': 4, '5x5': 10 };                      // режим -> число игроков
// Отдельная очередь на каждую лигу и каждый режим: PC и Phone не пересекаются
const Q = { pc: { '1x1': [], '2x2': [], '5x5': [] }, phone: { '1x1': [], '2x2': [], '5x5': [] } };
const rangeOf = e => 200 + 100 * Math.floor((now() - e.ts) / 10);    // ±200 Elo, +100 каждые 10 секунд ожидания
const teamOf = i => (i % 4 === 0 || i % 4 === 3) ? 'A' : 'B';
const liveOf = id => db.prepare(`SELECT m.id FROM mp p JOIN matches m ON m.id=p.match_id WHERE p.user_id=? AND m.status IN('accept','ban','rounds','live') ORDER BY m.id DESC LIMIT 1`).get(id);
const unqueue = id => Object.values(Q).forEach(l => Object.values(l).forEach(a => { const i = a.findIndex(x => x.id === id); if (i > -1) a.splice(i, 1); }));
const queued = lg => Object.values(Q[lg]).reduce((n, a) => n + a.length, 0);

function tryMatch(lg, mode) {
  const a = Q[lg][mode], size = MODES[mode];
  for (let again = true; again;) {
    again = false;
    for (const anc of a.slice().sort((x, y) => x.ts - y.ts)) {       // сначала те, кто ждёт дольше
      const r = rangeOf(anc);
      const cand = a.filter(x => x !== anc && Math.abs(x.elo - anc.elo) <= r)
        .sort((x, y) => Math.abs(x.elo - anc.elo) - Math.abs(y.elo - anc.elo)).slice(0, size - 1);
      if (cand.length < size - 1) continue;
      const pick = [anc, ...cand].sort((x, y) => y.elo - x.elo);
      pick.forEach(p => a.splice(a.indexOf(p), 1));
      const flip = Math.random() < 0.5;   // какая сторона достанется лучшему по Elo — случайно
      db.transaction(() => {
        const m = db.prepare('INSERT INTO matches(league,mode,status,deadline,banned,created) VALUES(?,?,?,?,?,?)').run(lg, mode, 'accept', now() + DSEC, '[]', now());
        pick.forEach((p, i) => { const t = teamOf(i), t2 = flip ? (t === 'A' ? 'B' : 'A') : t;
          db.prepare('INSERT INTO mp(match_id,user_id,team,accepted) VALUES(?,?,?,0)').run(m.lastInsertRowid, p.id, t2); });
        // капитаны — два самых сильных по Elo (pick уже отсортирован по убыванию), они всегда в разных командах
        const tm = pick.slice(0, 2).map((p, i) => ({ id: p.id, t: flip ? (i ? 'A' : 'B') : (i ? 'B' : 'A') }));
        db.prepare('UPDATE matches SET cap_a=?,cap_b=? WHERE id=?').run(tm.find(x => x.t === 'A').id, tm.find(x => x.t === 'B').id, m.lastInsertRowid);
      })();
      again = true; break;
    }
  }
}
setInterval(() => { for (const lg in Q) for (const md in MODES) tryMatch(lg, md); }, 1000); // диапазон растёт со временем
app.post('/api/queue/join', auth, (q, s) => {
  const { league: lg, mode } = q.body || {};
  if (!Q[lg]) return bad(s, 400, 'Неизвестная лига');
  if (!MODES[mode]) return bad(s, 400, 'Неизвестный режим');
  if (lg !== device(q) && q.user.role !== 'admin') return bad(s, 403, lg === 'pc' ? 'PC League доступна только с компьютера' : 'Phone League доступна только с телефона');
  if (liveOf(q.user.id)) return bad(s, 409, 'Сначала заверши текущий матч');
  if ((q.user.q_ban || 0) > now()) return bad(s, 403, 'Блокировка поиска ещё ' + Math.ceil((q.user.q_ban - now()) / 60) + ' мин.: ты не принял найденный матч');
  unqueue(q.user.id);
  Q[lg][mode].push({ id: q.user.id, elo: q.user.elo, ts: now() });
  tryMatch(lg, mode); s.json({ ok: true });
});
app.post('/api/queue/leave', auth, (q, s) => { unqueue(q.user.id); s.json({ ok: true }); });
app.get('/api/queue/count', (q, s) => {   // сколько игроков сейчас ищут матч, по лигам и режимам
  const o = {}; for (const lg in Q) { o[lg] = {}; for (const md in Q[lg]) o[lg][md] = Q[lg][md].length; }
  s.json(o);
});
app.get('/api/queue/status', auth, (q, s) => {
  const m = liveOf(q.user.id); if (m) return s.json({ match: pad(m.id), phase: db.prepare('SELECT status FROM matches WHERE id=?').get(m.id).status });
  for (const lg in Q) for (const md in MODES) {
    const me = Q[lg][md].find(x => x.id === q.user.id);
    if (me) { const r = rangeOf(me), size = MODES[md]; return s.json({ searching: true, league: lg, mode: md, range: r, size,
      found: Math.min(size, 1 + Q[lg][md].filter(x => x !== me && Math.abs(x.elo - me.elo) <= r).length) }); }
  }
  s.json({ idle: true });
});

/* ---------- Драфт: принятие -> баны карт -> голосование за раунды ---------- */
const mget = id => db.prepare('SELECT * FROM matches WHERE id=?').get(id);
function cancelAccept(m) {   // не все приняли: матч отменяется; принявшие возвращаются в очередь, не принявшие — блокировка поиска на 5 минут
  db.prepare("UPDATE matches SET status='cancelled' WHERE id=?").run(m.id);
  for (const p of db.prepare('SELECT u.id,u.elo,x.accepted FROM mp x JOIN users u ON u.id=x.user_id WHERE x.match_id=?').all(m.id)) {
    if (!p.accepted) { db.prepare('UPDATE users SET q_ban=? WHERE id=?').run(now() + QBAN_SEC, p.id); continue; }
    if (Q[m.league] && Q[m.league][m.mode] && !liveOf(p.id)) { unqueue(p.id); Q[m.league][m.mode].push({ id: p.id, elo: p.elo, ts: now() }); }
  }
}
function startVote(id) { db.prepare("UPDATE matches SET status='rounds',deadline=? WHERE id=?").run(now() + VOTE_SEC, id); }
function finishVote(id) {   // побеждает формат с наибольшим числом голосов; ничья — случайный из лидеров. Дальше баны карт, первой банит АТАКА (Т)
  const v = Object.fromEntries(ROUNDS.map(r => [r, 0]));
  db.prepare('SELECT vote FROM mp WHERE match_id=? AND vote IS NOT NULL').all(id).forEach(x => { if (x.vote in v) v[x.vote]++; });
  const top = Math.max(...Object.values(v));
  db.prepare("UPDATE matches SET rounds=?,status='ban',banned='[]',turn='A',deadline=? WHERE id=?").run(+rnd(ROUNDS.filter(r => v[r] === top)), now() + BAN_SEC, id);
}
function doBan(m, map) {
  const b = JSON.parse(m.banned || '[]'); b.push(map);
  const left = MAPS.filter(x => !b.includes(x));
  if (left.length === 1) db.prepare("UPDATE matches SET banned=?,map=?,status='live',deadline=0 WHERE id=?").run(JSON.stringify(b), left[0], m.id);
  else db.prepare('UPDATE matches SET banned=?,turn=?,deadline=? WHERE id=?').run(JSON.stringify(b), m.turn === 'A' ? 'B' : 'A', now() + BAN_SEC, m.id);
}
function advance(id) {   // переход по таймеру
  const m = mget(id); if (!m || !DRAFT.includes(m.status) || now() < m.deadline) return;
  if (m.status === 'accept') cancelAccept(m);
  else if (m.status === 'rounds') finishVote(id);
  else doBan(m, rnd(MAPS.filter(x => !JSON.parse(m.banned || '[]').includes(x))));
}
setInterval(() => { for (const m of db.prepare("SELECT id FROM matches WHERE status IN('accept','ban','rounds') AND deadline<=?").all(now())) advance(m.id); }, 1000);
function inDraft(q, s) {   // матч в драфте + участник ли пользователь
  const id = +q.params.id, m = mget(id), p = m && db.prepare('SELECT * FROM mp WHERE match_id=? AND user_id=?').get(id, q.user.id);
  if (!m) { bad(s, 404, 'Матч не найден'); return null; }
  if (!p) { bad(s, 403, 'Ты не участвуешь в этом матче'); return null; }
  return { m, p };
}
app.get('/api/matches/:id/draft', auth, (q, s) => {
  const c = inDraft(q, s); if (!c) return; const { m, p } = c;
  const pl = db.prepare('SELECT u.id uid,u.nick,u.sid,u.elo,u.played,u.frame,u.ava_v,x.team,x.accepted,x.vote,x.cancel FROM mp x JOIN users u ON u.id=x.user_id WHERE x.match_id=? ORDER BY x.team,u.elo DESC').all(m.id);
  const stq = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN m.winner=p.team THEN 1 ELSE 0 END),0) w, COALESCE(AVG(p.k),0) avg, COALESCE(SUM(p.k),0) sk, COALESCE(SUM(p.d),0) sd FROM mp p JOIN matches m ON m.id=p.match_id WHERE p.user_id=? AND m.status='done'");
  const votes = Object.fromEntries(ROUNDS.map(r => [r, pl.filter(x => x.vote === r).length]));
  const capId = { A: m.cap_a, B: m.cap_b }, nickOf = id => (pl.find(x => x.uid === id) || {}).nick;
  const r1 = (n, k) => Math.round(n * k) / k;
  const teamOf2 = t => { const a = pl.filter(x => x.team === t); return { name: (nickOf(capId[t]) || '—') + '_Team', avg: a.length ? Math.round(a.reduce((z, x) => z + x.elo, 0) / a.length) : 0 }; };
  const host = pl.find(x => x.uid === capId.B) || pl[0], need = Math.max(1, Math.ceil(pl.length * 0.6));
  s.json({ id: pad(m.id), status: m.status, left: Math.max(0, (m.deadline || 0) - now()), maps: MAPS, banned: JSON.parse(m.banned || '[]'), map: m.map, rounds: m.rounds,
    turn: m.turn, turnNick: nickOf(capId[m.turn]) || '', team: p.team, accepted: !!p.accepted, myVote: p.vote || null, votes, roundsOpts: ROUNDS, region: 'Россия',
    isCap: capId[p.team] === q.user.id, myTurn: m.status === 'ban' && m.turn === p.team && capId[p.team] === q.user.id,
    total: pl.length, acceptedCount: pl.filter(x => x.accepted).length, uploads: db.prepare('SELECT COUNT(*) c FROM subs WHERE match_id=?').get(m.id).c,
    cancel: { marks: pl.filter(x => x.cancel).length, need, mine: !!p.cancel },
    teams: { A: teamOf2('A'), B: teamOf2('B') }, host: host && { nick: host.nick, sid: host.sid, uid: host.uid, frame: host.frame, ava: host.ava_v || 0 },
    players: pl.map(x => { const st = stq.get(x.uid);
      return { uid: x.uid, nick: x.nick, sid: x.sid, team: x.team, elo: x.elo, played: x.played, frame: x.frame, ava: x.ava_v || 0, accepted: !!x.accepted, voted: x.vote != null,
        cap: x.uid === capId[x.team], me: x.uid === q.user.id, n: st.n, wr: st.n ? r1(st.w / st.n * 100, 10) : 0, avg: r1(st.avg, 10), kd: st.sd ? r1(st.sk / st.sd, 100) : st.sk }; }),
    chat: db.prepare('SELECT id,nick,team,text,ts FROM draft_chat WHERE match_id=? AND id>? ORDER BY id LIMIT 100').all(m.id, parseInt(q.query.after) || 0) });
});
app.post('/api/matches/:id/cancel-mark', auth, (q, s) => {   // «отметка на отмену»: набрали 60% игроков — матч отменяется без изменения Elo
  const c = inDraft(q, s); if (!c) return;
  if (!['rounds', 'ban', 'live'].includes(c.m.status)) return bad(s, 409, 'Сейчас отметить отмену нельзя');
  db.prepare('UPDATE mp SET cancel=1-COALESCE(cancel,0) WHERE match_id=? AND user_id=?').run(c.m.id, q.user.id);
  const t = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(cancel),0) c FROM mp WHERE match_id=?').get(c.m.id);
  if (t.c >= Math.max(1, Math.ceil(t.n * 0.6))) db.prepare("UPDATE matches SET status='cancelled' WHERE id=?").run(c.m.id);
  s.json({ ok: true });
});
app.post('/api/matches/:id/accept', auth, (q, s) => {
  const c = inDraft(q, s); if (!c) return;
  if (c.m.status !== 'accept') return bad(s, 409, 'Приём матча уже закрыт');
  db.prepare('UPDATE mp SET accepted=1 WHERE match_id=? AND user_id=?').run(c.m.id, q.user.id);
  if (!db.prepare('SELECT 1 FROM mp WHERE match_id=? AND accepted=0').get(c.m.id)) startVote(c.m.id);
  s.json({ ok: true });
});
app.post('/api/matches/:id/ban', auth, (q, s) => {
  const c = inDraft(q, s); if (!c) return; const { m, p } = c, map = (q.body || {}).map;
  if (m.status !== 'ban') return bad(s, 409, 'Сейчас не этап банов');
  if (m.turn !== p.team || (p.team === 'A' ? m.cap_a : m.cap_b) !== q.user.id) return bad(s, 403, 'Сейчас не твой ход: банит капитан другой команды');
  if (!MAPS.includes(map) || JSON.parse(m.banned || '[]').includes(map)) return bad(s, 400, 'Эта карта недоступна');
  doBan(m, map); s.json({ ok: true });
});
app.post('/api/matches/:id/vote', auth, (q, s) => {
  const c = inDraft(q, s); if (!c) return; const r = parseInt((q.body || {}).rounds);
  if (c.m.status !== 'rounds') return bad(s, 409, 'Сейчас не этап выбора раундов');
  if (!ROUNDS.includes(r)) return bad(s, 400, 'Доступно: ' + ROUNDS.join(', '));
  db.prepare('UPDATE mp SET vote=? WHERE match_id=? AND user_id=?').run(r, c.m.id, q.user.id);
  if (!db.prepare('SELECT 1 FROM mp WHERE match_id=? AND vote IS NULL').get(c.m.id)) finishVote(c.m.id);   // все проголосовали — не ждём таймер
  s.json({ ok: true });
});
app.post('/api/matches/:id/chat', auth, (q, s) => {
  const c = inDraft(q, s); if (!c) return; const text = String((q.body || {}).text || '').trim().slice(0, 200);
  if (!text) return bad(s, 400, 'Пустое сообщение');
  if (db.prepare('SELECT COUNT(*) c FROM draft_chat WHERE match_id=? AND nick=? AND ts>?').get(c.m.id, q.user.nick, now() - 5).c >= 5) return bad(s, 429, 'Слишком часто');
  db.prepare('INSERT INTO draft_chat(match_id,nick,team,text,ts) VALUES(?,?,?,?,?)').run(c.m.id, q.user.nick, c.p.team, text, now()); s.json({ ok: true });
});

/* ---------- Матчи и результаты ---------- */
const matchView = (id, meId) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(id); if (!m) return null;
  const pl = db.prepare(`SELECT u.id uid,u.nick,u.sid,p.team,p.k,p.d,p.a,p.elo_delta,
    (SELECT COUNT(*) FROM praises z WHERE z.match_id=p.match_id AND z.to_id=u.id) praises,
    (SELECT COUNT(*) FROM praises z WHERE z.match_id=p.match_id AND z.to_id=u.id AND z.from_id=?) mine
    FROM mp p JOIN users u ON u.id=p.user_id WHERE p.match_id=? ORDER BY p.team, p.k DESC`).all(meId || 0, id);
  let mvp = null; // MVP — лучший по киллам в победившей команде
  if (m.status === 'done' && m.winner) { const w = pl.filter(x => x.team === m.winner && x.k > 0).sort((a, b) => b.k - a.k || a.d - b.d)[0]; mvp = w ? w.nick : null; }
  const inMatch = pl.some(x => x.uid === meId);
  return { ...m, id: pad(m.id), mvp, canPraise: inMatch && m.status === 'done',
    players: pl.map(({ uid, mine, ...x }) => ({ ...x, mine: !!mine, me: uid === meId })) };
};
// Мои матчи (страница «Отправка результата» и список матчей). Маршрут должен стоять ДО /api/matches/:id
app.get('/api/matches/mine', auth, (q, s) => s.json(db.prepare(`SELECT m.id,m.league,m.mode,m.map,m.status,m.winner,m.created,
  (SELECT x.status FROM subs x WHERE x.match_id=m.id AND x.user_id=p.user_id) sub
  FROM mp p JOIN matches m ON m.id=p.match_id WHERE p.user_id=? AND m.status IN('live','pending','review','done') ORDER BY m.id DESC LIMIT 50`)
  .all(q.user.id).map(x => ({ ...x, id: pad(x.id) }))));
app.get('/api/matches/:id', auth, (q, s) => {
  const v = matchView(+q.params.id, q.user.id); if (!v) return bad(s, 404, 'Матч не найден');
  if (!v.players.some(p => p.nick === q.user.nick) && RANK[q.user.role] < 1) return bad(s, 403, 'forbidden');
  s.json(v);
});

// Калибровка (первые 10 матчей): победа +50 к скрытому Elo, поражение 0. После: ±25.
function applyElo(uid, win) {
  const u = db.prepare('SELECT played FROM users WHERE id=?').get(uid);
  const dl = u.played < 10 ? (win ? 50 : 0) : (win ? 25 : -25);
  db.prepare('UPDATE users SET elo=MAX(100,elo+?),played=played+1,points=points+? WHERE id=?').run(dl, win ? 50 : 20, uid);
  return dl;
}
const finalize = db.transaction((id, winner, actor) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  if (!m || m.status === 'done' || m.status === 'cancelled') return false;
  for (const p of db.prepare('SELECT * FROM mp WHERE match_id=?').all(id)) {
    const win = p.team === winner, dl = applyElo(p.user_id, win);
    db.prepare('UPDATE mp SET elo_delta=? WHERE match_id=? AND user_id=?').run(dl, id, p.user_id);
  }
  db.prepare("UPDATE subs SET status='approved' WHERE match_id=? AND status='pending'").run(id);
  const sc = db.prepare('SELECT score_a,score_b FROM subs WHERE match_id=? AND winner=? AND score_a IS NOT NULL AND score_b IS NOT NULL ORDER BY id LIMIT 1').get(id, winner) || {};
  db.prepare("UPDATE matches SET status='done',winner=?,score_a=?,score_b=? WHERE id=?").run(winner, sc.score_a ?? null, sc.score_b ?? null, id);
  audit(actor, 'finalize', pad(id), 'winner ' + winner); return true;
});
function autoConfirm(id) { // авто-подтверждение: обе команды прислали одинаковый победитель
  const rows = db.prepare(`SELECT s.winner,p.team FROM subs s JOIN mp p ON p.match_id=s.match_id AND p.user_id=s.user_id WHERE s.match_id=? AND s.status='pending'`).all(id);
  for (const w of ['A', 'B']) {
    const ag = rows.filter(r => r.winner === w);
    if (ag.length === rows.length && ag.some(r => r.team === 'A') && ag.some(r => r.team === 'B')) return finalize(id, w, 'auto');
  }
  if (rows.some(r => r.winner !== rows[0].winner)) db.prepare("UPDATE matches SET status='review' WHERE id=?").run(id);
}
const scoreOf = v => { const n = parseInt(v); return Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : null; }; // счёт раундов (необязательно)
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const up = multer({
  storage: multer.diskStorage({ destination: UP, filename: (q, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (EXT[f.mimetype] || '.bad')) }),
  limits: { fileSize: 5e6, files: 1 }, fileFilter: (q, f, cb) => cb(null, !!EXT[f.mimetype])
});
// Номер матча берётся из URL; чужой матч отправить нельзя — проверяется состав (mp).
app.post('/api/matches/:id/result', auth, up.single('screenshot'), (q, s) => {
  const id = +q.params.id, drop = () => q.file && fs.unlink(q.file.path, () => {});
  const p = db.prepare('SELECT * FROM mp WHERE match_id=? AND user_id=?').get(id, q.user.id);
  if (!p) { drop(); return bad(s, 403, 'Тебя не было в этом матче'); }
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  if (!['live', 'pending', 'review'].includes(m.status)) { drop(); return bad(s, 409, 'Матч уже закрыт'); }
  if (!q.file) return bad(s, 400, 'Нужен скриншот (png/jpg/webp до 5 МБ)');
  const winner = q.body.winner, [k, d, a] = ['k', 'd', 'a'].map(x => Math.max(0, Math.min(99, parseInt(q.body[x]) || 0)));
  if (!['A', 'B'].includes(winner)) { drop(); return bad(s, 400, 'Укажи победившую команду: A или B'); }
  try {
    db.prepare('INSERT INTO subs(match_id,user_id,winner,k,d,a,file,status,created,score_a,score_b) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, q.user.id, winner, k, d, a, q.file.filename, 'pending', now(), scoreOf(q.body.sa), scoreOf(q.body.sb));
  } catch { drop(); return bad(s, 409, 'Ты уже отправлял результат этого матча'); }
  db.prepare('UPDATE mp SET k=?,d=?,a=? WHERE match_id=? AND user_id=?').run(k, d, a, id, q.user.id);
  db.prepare("UPDATE matches SET status='pending' WHERE id=? AND status='live'").run(id);
  pgsync.saveFile(q.file.filename).catch(e => console.error('PG: скриншот не сохранён:', e.message));
  autoConfirm(id); s.json({ status: 'Result Pending' });
});

app.post('/api/matches/:id/praise', auth, (q, s) => {
  const id = +q.params.id, m = db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  if (!m) return bad(s, 404, 'Матч не найден');
  if (m.status !== 'done') return bad(s, 409, 'Похвалить можно после завершения матча');
  const inM = uid => db.prepare('SELECT 1 FROM mp WHERE match_id=? AND user_id=?').get(id, uid);
  if (!inM(q.user.id)) return bad(s, 403, 'Ты не участвовал в этом матче');
  const t = byNick((q.body || {}).nick); if (!t || t.id === q.user.id) return bad(s, 400, 'Нельзя похвалить себя');
  if (!inM(t.id)) return bad(s, 404, 'Этот игрок не из матча');
  try { db.prepare('INSERT INTO praises VALUES(?,?,?)').run(id, q.user.id, t.id); } catch { return bad(s, 409, 'Ты уже похвалил этого игрока'); }
  s.json({ ok: true });
});

/* ---------- Друзья ---------- */
const byNick = n => db.prepare('SELECT id,nick,sid,seen FROM users WHERE nick=?').get(String(n || ''));
app.get('/api/friends', auth, (q, s) => {
  const me = q.user.id, v = r => ({ nick: r.nick, sid: r.sid, online: now() - r.seen < 120 });
  const rows = db.prepare(`SELECT f.a,f.b,f.status,u.nick,u.sid,u.seen FROM friends f JOIN users u ON u.id=CASE WHEN f.a=? THEN f.b ELSE f.a END WHERE f.a=? OR f.b=?`).all(me, me, me);
  s.json({ friends: rows.filter(r => r.status === 'ok').map(v), incoming: rows.filter(r => r.status === 'pending' && r.b === me).map(v), outgoing: rows.filter(r => r.status === 'pending' && r.a === me).map(v) });
});
app.get('/api/friends/search', auth, (q, s) => {
  const t = String(q.query.q || '').trim();
  s.json({ user: db.prepare('SELECT nick,sid FROM users WHERE (nick=? OR sid=?) AND id!=?').get(t, t, q.user.id) || null });
});
app.post('/api/friends/request', auth, (q, s) => {
  const t = byNick(q.body.nick); if (!t || t.id === q.user.id) return bad(s, 404, 'Игрок не найден');
  const ex = db.prepare('SELECT * FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').get(q.user.id, t.id, t.id, q.user.id);
  if (ex && ex.status === 'ok') return bad(s, 409, 'Уже в друзьях');
  if (ex && ex.a === t.id) { db.prepare("UPDATE friends SET status='ok' WHERE a=? AND b=?").run(t.id, q.user.id); return s.json({ status: 'ok' }); }
  if (ex) return bad(s, 409, 'Заявка уже отправлена');
  db.prepare("INSERT INTO friends VALUES(?,?,'pending')").run(q.user.id, t.id); s.json({ status: 'pending' });
});
app.post('/api/friends/accept', auth, (q, s) => {
  const t = byNick(q.body.nick); if (!t) return bad(s, 404, 'Игрок не найден');
  const r = db.prepare("UPDATE friends SET status='ok' WHERE a=? AND b=? AND status='pending'").run(t.id, q.user.id);
  r.changes ? s.json({ ok: true }) : bad(s, 404, 'Заявки нет');
});
app.delete('/api/friends/:nick', auth, (q, s) => {
  const t = byNick(q.params.nick); if (t) db.prepare('DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').run(q.user.id, t.id, t.id, q.user.id);
  s.json({ ok: true });
});

/* ---------- Ежедневные миссии ---------- */
const MIS = [{ key: 'streak2', title: '2 победы подряд', need: 2, reward: 45 }, { key: 'play3', title: 'Сыграть 3 матча', need: 3, reward: 40 }, { key: 'mvp3', title: '3 MVP за день', need: 3, reward: 75 }];
const dayKey = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // сутки по МСК
function progress(id) {
  const t = Date.parse(dayKey() + 'T00:00:00+03:00') / 1000;
  const ms = db.prepare(`SELECT m.id,m.winner,p.team,p.k FROM mp p JOIN matches m ON m.id=p.match_id WHERE p.user_id=? AND m.status='done' AND m.created>=? ORDER BY m.id`).all(id, t);
  let st = 0, best = 0, mvp = 0;
  for (const m of ms) {
    if (m.winner === m.team) { st++; best = Math.max(best, st); const top = db.prepare('SELECT MAX(k) mk FROM mp WHERE match_id=?').get(m.id).mk; if (m.k > 0 && m.k >= top) mvp++; } else st = 0;
  }
  return { streak2: best, play3: ms.length, mvp3: mvp };
}
app.get('/api/missions', auth, (q, s) => {
  const pr = progress(q.user.id), done = db.prepare('SELECT key FROM claims WHERE user_id=? AND day=?').all(q.user.id, dayKey()).map(x => x.key);
  s.json(MIS.map(m => ({ ...m, progress: Math.min(pr[m.key], m.need), claimed: done.includes(m.key) })));
});
app.post('/api/missions/:key/claim', auth, (q, s) => {
  const m = MIS.find(x => x.key === q.params.key); if (!m) return bad(s, 404, 'Нет такой миссии');
  if (progress(q.user.id)[m.key] < m.need) return bad(s, 409, 'Миссия не выполнена');
  try { db.prepare('INSERT INTO claims VALUES(?,?,?)').run(q.user.id, m.key, dayKey()); } catch { return bad(s, 409, 'Награда уже получена'); }
  db.prepare('UPDATE users SET points=points+? WHERE id=?').run(m.reward, q.user.id); s.json({ reward: m.reward });
});

/* ---------- Магазин ---------- */
const SHOP = { blue: 300, mechanic: 750, holographic: 500, wings: 1000, demon: 666, diamond: 700 };
const RUB = ['crystall', 'space', 'strike', 'golden', 'rocket', 'minecraft']; // платные: нужна платёжка (ЮKassa и т.п.)
app.get('/api/shop', auth, (q, s) => s.json({ points: q.user.points, items: Object.entries(SHOP).map(([id, price]) => ({ id, price, cur: 'IP' }))
  .concat(RUB.map(id => ({ id, price: 39, cur: 'RUB' }))), owned: db.prepare('SELECT item FROM owned WHERE user_id=?').all(q.user.id).map(x => x.item) }));
app.post('/api/shop/buy', auth, (q, s) => {
  const id = q.body.id; if (RUB.includes(id)) return bad(s, 402, 'Оплата в рублях ещё не подключена');
  const price = SHOP[id]; if (!price) return bad(s, 404, 'Нет такого товара');
  const r = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM owned WHERE user_id=? AND item=?').get(q.user.id, id)) return 'owned';
    if (!db.prepare('UPDATE users SET points=points-? WHERE id=? AND points>=?').run(price, q.user.id, price).changes) return 'poor';
    db.prepare('INSERT INTO owned VALUES(?,?)').run(q.user.id, id); return 'ok';
  })();
  r === 'ok' ? s.json({ ok: true }) : bad(s, 409, r === 'poor' ? 'Недостаточно Ink Points' : 'Уже куплено');
});
app.post('/api/shop/equip', auth, (q, s) => {
  if (!db.prepare('SELECT 1 FROM owned WHERE user_id=? AND item=?').get(q.user.id, q.body.id)) return bad(s, 403, 'Не куплено');
  db.prepare('UPDATE users SET frame=? WHERE id=?').run(q.body.id, q.user.id); s.json({ ok: true });
});

/* ---------- Репорты ---------- */
const REASONS = { cheat: 'Читы', bug: 'Багоюз', league: 'Игра не в своей лиге', toxic: 'Токсичность', ruin: 'Руин игры' };
app.post('/api/reports', auth, (q, s) => {
  const { nick, reason, match, comment } = q.body || {};
  const t = byNick(nick); if (!t) return bad(s, 404, 'Игрок не найден');
  if (t.id === q.user.id) return bad(s, 400, 'Нельзя пожаловаться на себя');
  if (!REASONS[reason]) return bad(s, 400, 'Выбери причину');
  if (db.prepare('SELECT COUNT(*) c FROM reports WHERE reporter_id=? AND created>?').get(q.user.id, now() - 86400).c >= 5) return bad(s, 429, 'Лимит: 5 жалоб в сутки');
  if (db.prepare("SELECT 1 FROM reports WHERE reporter_id=? AND target_id=? AND reason=? AND status='open'").get(q.user.id, t.id, reason)) return bad(s, 409, 'Такая жалоба уже ждёт проверки');
  db.prepare('INSERT INTO reports(reporter_id,reporter,target_id,target,reason,match_id,comment,created) VALUES(?,?,?,?,?,?,?,?)')
    .run(q.user.id, q.user.nick, t.id, t.nick, reason, String(match || '').replace(/\D/g, '').slice(0, 6), String(comment || '').slice(0, 300), now());
  s.json({ ok: true });
});
app.get('/api/reports/mine', auth, (q, s) => s.json(db.prepare('SELECT target,reason,match_id,status,note,created FROM reports WHERE reporter_id=? ORDER BY id DESC LIMIT 20').all(q.user.id).map(r => ({ ...r, label: REASONS[r.reason] }))));

/* ---------- Админ / модерация ---------- */
const A = [auth, need('moderator')];
const target = (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+q.params.id);
  if (!u) { bad(s, 404, 'Игрок не найден'); return null; }
  if (RANK[u.role] >= RANK[q.user.role]) { bad(s, 403, 'Нельзя применять к равному или старшему по роли'); return null; }
  return u;
};
app.get('/api/admin/overview', A, (q, s) => s.json({
  me: pub(q.user), pending: db.prepare("SELECT COUNT(*) c FROM subs WHERE status='pending'").get().c,
  review: db.prepare("SELECT COUNT(*) c FROM matches WHERE status='review'").get().c,
  banned: db.prepare('SELECT COUNT(*) c FROM users WHERE banned_until>?').get(now()).c,
  reports: db.prepare("SELECT COUNT(*) c FROM reports WHERE status='open'").get().c, queue: { pc: queued('pc'), phone: queued('phone') } }));
app.get('/api/admin/users', A, (q, s) => {
  const t = '%' + String(q.query.q || '').replace(/[%_]/g, '') + '%';
  s.json(db.prepare('SELECT id,nick,sid,role,elo,played,points,banned_until,ban_reason,seen FROM users WHERE nick LIKE ? OR sid LIKE ? ORDER BY id DESC LIMIT 50').all(t, t));
});
app.post('/api/admin/users/:id/ban', A, (q, s) => {
  const u = target(q, s); if (!u) return;
  const h = +q.body.hours || 0, reason = String(q.body.reason || '').slice(0, 200);
  db.prepare('UPDATE users SET banned_until=?,ban_reason=? WHERE id=?').run(h > 0 ? now() + h * 3600 : 4102444800, reason, u.id);
  unqueue(u.id); audit(q.user.nick, 'ban', u.nick, `${reason} / ${h > 0 ? h + 'ч' : 'навсегда'}`); s.json({ ok: true });
});
app.post('/api/admin/users/:id/unban', A, (q, s) => {
  const u = target(q, s); if (!u) return;
  db.prepare('UPDATE users SET banned_until=0,ban_reason=NULL WHERE id=?').run(u.id); audit(q.user.nick, 'unban', u.nick); s.json({ ok: true });
});
app.post('/api/admin/users/:id/adjust', auth, need('admin'), (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+q.params.id); if (!u) return bad(s, 404, 'Игрок не найден');
  const p = parseInt(q.body.points) || 0, e = parseInt(q.body.elo) || 0;
  db.prepare('UPDATE users SET points=MAX(0,points+?),elo=MAX(100,elo+?) WHERE id=?').run(p, e, u.id);
  audit(q.user.nick, 'adjust', u.nick, `points ${p}, elo ${e}`); s.json({ ok: true });
});
app.post('/api/admin/users/:id/edit', auth, need('admin'), (q, s) => {   // смена ника (логина), StandKnife ID и пароля игрока
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+q.params.id); if (!u) return bad(s, 404, 'Игрок не найден');
  const b = q.body || {}, nick = String(b.nick || '').trim() || u.nick, sid = String(b.sid || '').trim() || u.sid, pw = String(b.password || '');
  if (!/^[\wа-яА-ЯёЁ-]{3,16}$/.test(nick)) return bad(s, 400, 'Ник: 3–16 символов');
  if (!/^\d{6,12}$/.test(sid)) return bad(s, 400, 'Некорректный StandKnife ID (6–12 цифр)');
  if (pw && pw.length < 8) return bad(s, 400, 'Пароль минимум 8 символов');
  try { db.prepare('UPDATE users SET nick=?, sid=?, pass=? WHERE id=?').run(nick, sid, pw ? bcrypt.hashSync(pw, 10) : u.pass, u.id); }
  catch (e) { if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return bad(s, 409, 'Ник или StandKnife ID уже заняты'); throw e; }
  audit(q.user.nick, 'edit-user', u.nick, [nick !== u.nick && `ник ${u.nick} -> ${nick}`, sid !== u.sid && `sid ${u.sid} -> ${sid}`, pw && 'пароль изменён'].filter(Boolean).join('; ') || 'без изменений');
  s.json({ ok: true });
});
app.delete('/api/admin/users/:id/avatar', A, (q, s) => {   // модерация: убрать неподходящую аватарку
  const u = db.prepare('SELECT nick FROM users WHERE id=?').get(+q.params.id); if (!u) return bad(s, 404, 'Игрок не найден');
  db.prepare('UPDATE users SET avatar=NULL, ava_v=0 WHERE id=?').run(+q.params.id); audit(q.user.nick, 'avatar-clear', u.nick, ''); s.json({ ok: true });
});
app.post('/api/admin/users/:id/role', auth, need('admin'), (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+q.params.id), role = q.body.role;
  if (!u) return bad(s, 404, 'Игрок не найден'); if (!(role in RANK)) return bad(s, 400, 'Неверная роль');
  if (u.role === 'admin' && role !== 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c <= 1) return bad(s, 409, 'Нельзя убрать последнего админа');
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id); audit(q.user.nick, 'role', u.nick, `${u.role} -> ${role}`); s.json({ ok: true });
});
app.get('/api/admin/subs', A, (q, s) => s.json(db.prepare(`SELECT s.id,s.match_id,s.winner,s.k,s.d,s.a,s.file,s.status,s.created,u.nick,p.team,m.status mstatus
  FROM subs s JOIN users u ON u.id=s.user_id JOIN mp p ON p.match_id=s.match_id AND p.user_id=s.user_id JOIN matches m ON m.id=s.match_id
  WHERE s.status=? ORDER BY s.id DESC LIMIT 100`).all(q.query.status || 'pending').map(x => ({ ...x, match: pad(x.match_id) }))));
app.get('/api/admin/shot/:file', A, async (q, s) => { const f = path.basename(q.params.file); try { await pgsync.ensureFile(f); } catch {} s.sendFile(path.join(UP, f), e => e && !s.headersSent && bad(s, 404, 'Файл не найден')); });
app.post('/api/admin/subs/:id/approve', A, (q, s) => {
  const sub = db.prepare('SELECT * FROM subs WHERE id=?').get(+q.params.id); if (!sub) return bad(s, 404, 'Заявка не найдена');
  const w = ['A', 'B'].includes(q.body.winner) ? q.body.winner : sub.winner;
  finalize(sub.match_id, w, q.user.nick) ? s.json({ ok: true }) : bad(s, 409, 'Матч уже закрыт');
});
app.post('/api/admin/subs/:id/reject', A, (q, s) => {
  const sub = db.prepare('SELECT * FROM subs WHERE id=?').get(+q.params.id); if (!sub) return bad(s, 404, 'Заявка не найдена');
  db.prepare("UPDATE subs SET status='rejected' WHERE id=?").run(sub.id);
  db.prepare("UPDATE matches SET status='live' WHERE id=? AND status IN('pending','review') AND NOT EXISTS(SELECT 1 FROM subs WHERE match_id=? AND status='pending')").run(sub.match_id, sub.match_id);
  audit(q.user.nick, 'reject_sub', pad(sub.match_id), sub.file); s.json({ ok: true });
});
app.get('/api/admin/matches', A, (q, s) => {
  const L = db.prepare("SELECT id,league,mode,map,status,winner,created FROM matches WHERE (?='' OR status=?) ORDER BY id DESC LIMIT 100")
    .all(q.query.status || '', q.query.status || '');
  const pq = db.prepare('SELECT u.nick,u.sid,p.team,p.k,p.d,p.a FROM mp p JOIN users u ON u.id=p.user_id WHERE p.match_id=? ORDER BY p.team,p.k DESC');
  s.json(L.map(x => ({ ...x, players: pq.all(x.id), id: pad(x.id) })));
});
app.post('/api/admin/matches/:id/cancel', A, (q, s) => {
  db.prepare("UPDATE matches SET status='cancelled' WHERE id=? AND status!='done'").run(+q.params.id);
  audit(q.user.nick, 'cancel_match', pad(+q.params.id)); s.json({ ok: true });
});
app.post('/api/admin/matches/:id/finalize', A, (q, s) => {
  if (!['A', 'B'].includes(q.body.winner)) return bad(s, 400, 'winner: A или B');
  finalize(+q.params.id, q.body.winner, q.user.nick) ? s.json({ ok: true }) : bad(s, 409, 'Матч уже закрыт');
});
app.get('/api/admin/reports', A, (q, s) => s.json(db.prepare(`SELECT r.*,(SELECT COUNT(*) FROM reports x WHERE x.target_id=r.target_id) total FROM reports r WHERE r.status=? ORDER BY r.id DESC LIMIT 100`)
  .all(q.query.status || 'open').map(r => ({ ...r, label: REASONS[r.reason] }))));
app.post('/api/admin/reports/:id/resolve', A, (q, s) => {
  const st = q.body.action === 'rejected' ? 'rejected' : 'resolved';
  db.prepare('UPDATE reports SET status=?,note=?,handler=? WHERE id=?').run(st, String(q.body.note || '').slice(0, 200), q.user.nick, +q.params.id);
  audit(q.user.nick, 'report_' + st, '#' + q.params.id, q.body.note); s.json({ ok: true });
});
// --- только admin: калибровка, накрутка матчей, удаление матчей и аккаунтов ---
const adminOnly = [auth, need('admin')];
const getUser = (q, s) => { const u = db.prepare('SELECT * FROM users WHERE id=?').get(+q.params.id); if (!u) bad(s, 404, 'Игрок не найден'); return u; };
app.post('/api/admin/users/:id/calibration', adminOnly, (q, s) => {
  const u = getUser(q, s); if (!u) return;
  if (q.body.action === 'reset') db.prepare('UPDATE users SET played=0,elo=100 WHERE id=?').run(u.id);
  else { const e = parseInt(q.body.elo); db.prepare('UPDATE users SET played=MAX(played,10),elo=MAX(100,?) WHERE id=?').run(Number.isFinite(e) ? e : u.elo, u.id); }
  audit(q.user.nick, 'calibration_' + (q.body.action === 'reset' ? 'reset' : 'skip'), u.nick, String(q.body.elo || '')); s.json({ ok: true });
});
app.post('/api/admin/users/:id/addmatch', adminOnly, (q, s) => {
  const u = getUser(q, s); if (!u) return;
  const n = Math.max(1, Math.min(20, parseInt(q.body.count) || 1)), win = !!q.body.win;
  const [k, d, a] = ['k', 'd', 'a'].map(x => Math.max(0, Math.min(99, parseInt(q.body[x]) || 0)));
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const m = db.prepare("INSERT INTO matches(league,mode,map,status,winner,created) VALUES('admin','admin',?,'done',?,?)").run(rnd(MAPS), win ? 'A' : 'B', now());
      db.prepare('INSERT INTO mp(match_id,user_id,team,k,d,a,elo_delta) VALUES(?,?,?,?,?,?,?)').run(m.lastInsertRowid, u.id, 'A', k, d, a, applyElo(u.id, win));
    }
  })();
  audit(q.user.nick, 'addmatch', u.nick, `${n}x ${win ? 'W' : 'L'} ${k}/${d}/${a}`); s.json({ ok: true });
});
app.get('/api/admin/users/:id/matches', A, (q, s) => s.json(db.prepare(`SELECT m.id,m.league,m.mode,m.map,m.status,m.winner,p.team,p.k,p.d,p.a,p.elo_delta FROM mp p JOIN matches m ON m.id=p.match_id WHERE p.user_id=? ORDER BY m.id DESC LIMIT 100`)
  .all(+q.params.id).map(x => ({ ...x, id: pad(x.id) }))));
const deleteMatch = db.transaction(id => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(id); if (!m) return false;
  if (m.status === 'done') for (const p of db.prepare('SELECT * FROM mp WHERE match_id=?').all(id)) // откатываем Elo, калибровку и очки
    db.prepare('UPDATE users SET elo=MAX(100,elo-?),played=MAX(0,played-1),points=MAX(0,points-?) WHERE id=?').run(p.elo_delta, p.team === m.winner ? 50 : 20, p.user_id);
  db.prepare('SELECT file FROM subs WHERE match_id=?').all(id).forEach(f => fs.unlink(path.join(UP, path.basename(f.file)), () => {}));
  db.prepare('DELETE FROM subs WHERE match_id=?').run(id); db.prepare('DELETE FROM mp WHERE match_id=?').run(id); db.prepare('DELETE FROM matches WHERE id=?').run(id);
  return true;
});
app.delete('/api/admin/matches/:id', adminOnly, (q, s) => {
  deleteMatch(+q.params.id) ? (audit(q.user.nick, 'delete_match', pad(+q.params.id)), s.json({ ok: true })) : bad(s, 404, 'Матч не найден');
});
app.delete('/api/admin/users/:id', adminOnly, (q, s) => {
  const u = getUser(q, s); if (!u) return;
  if (u.id === q.user.id) return bad(s, 400, 'Нельзя удалить себя');
  if (u.role === 'admin') return bad(s, 403, 'Сначала понизь роль админа');
  unqueue(u.id);
  db.transaction(() => {
    db.prepare('SELECT match_id id FROM mp WHERE user_id=? AND (SELECT COUNT(*) FROM mp x WHERE x.match_id=mp.match_id)=1').all(u.id).forEach(m => deleteMatch(m.id));
    db.prepare('SELECT file FROM subs WHERE user_id=?').all(u.id).forEach(f => fs.unlink(path.join(UP, path.basename(f.file)), () => {}));
    for (const t of ['subs', 'mp', 'owned', 'claims']) db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u.id);
    db.prepare('DELETE FROM friends WHERE a=? OR b=?').run(u.id, u.id);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  })();
  audit(q.user.nick, 'delete_user', u.nick); s.json({ ok: true });
});
app.get('/api/admin/audit', A, (q, s) => s.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all()));

/* ---------- Статика ---------- */
app.get('/admin', (q, s) => s.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use('/api', (q, s) => bad(s, 404, 'Нет такого метода API'));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));
app.use('/img', express.static(path.join(__dirname, 'public', 'IMG')));   // на GitHub папка может называться IMG
app.use(express.static(path.join(__dirname, 'public'))); // сюда кладётся сайт: public/index.html
// Проверка структуры проекта: частая ошибка — скопировать не тот файл или положить его не в public/
for (const f of ['index.html', 'admin.html']) {
  try { if (!fs.readFileSync(path.join(__dirname, 'public', f), 'utf8').slice(0, 300).toLowerCase().includes('<!doctype html')) console.error(`ВНИМАНИЕ: public/${f} — это не страница сайта (в него скопирован другой файл). Замени его настоящим ${f}.`); }
  catch { console.error(`ВНИМАНИЕ: нет файла public/${f}. Файлы сайта должны лежать в папке public.`); }
}
app.use((e, q, s, n) => { if (e.code && String(e.code).startsWith('LIMIT')) return bad(s, 400, 'Файл слишком большой (до 5 МБ)'); console.error(e); bad(s, 500, 'Ошибка сервера'); });

// Матчи, зависшие в live > 3 часов, отменяются
setInterval(() => db.prepare("UPDATE matches SET status='cancelled' WHERE status='live' AND created<?").run(now() - 3 * 3600), 10 * 60e3);
app.listen(PORT, () => console.log('InkPlatform: http://localhost:' + PORT + '  админка: /admin'));
pgsync.start(db);
for (const f of ['logo.png', 'lvl1.png', 'lvl10.png', 'lvq.png', 'favicon.png']) if (!fs.existsSync(path.join(__dirname, 'public', 'img', f)) && !fs.existsSync(path.join(__dirname, 'public', 'IMG', f))) console.error(`ВНИМАНИЕ: нет файла public/img/${f}: картинки не загрузятся. Проверь, что папка public/img залита в репозиторий.`);
// В Termux не даём Android усыплять процесс в фоне (если установлен termux-wake-lock)
require('child_process').execFile('termux-wake-lock', () => {});
