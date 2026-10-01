const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================
// POSTGRESQL
// =====================================================

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

const DB_STATE_ID = 1;

// =====================================================
// FILE STORAGE
// =====================================================

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, 'data');

const DATA_FILE =
  path.join(DATA_DIR, 'standknife-data.json');

const UPLOADS_DIR =
  process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR));

// =====================================================
// MULTER
// =====================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = UPLOADS_DIR;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    cb(null, dir);
  },

  filename: (req, file, cb) => {
    cb(
      null,
      Date.now() + '-' + file.originalname
    );
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

// =====================================================
// MEMORY
// =====================================================

let users = {};
let parties = {};

const queues = {
  '1v1_unranked': [],
  '1v1_ranked': [],
  '2v2_unranked': [],
  '2v2_ranked': [],
  '5v5_unranked': [],
  '5v5_ranked': []
};

let pendingMatches = [];
let chatMessages = [];
let privateMessages = [];

const socketToUser = {};
const userSockets = {};

let bans = {};
let mutes = {};

let winHistory = [];

const leaderboardCache = {
  day: [],
  week: [],
  month: []
};

let lastLeaderboardUpdate = 0;

let clans = {};

const drafts = {};
const mapVotes = {};

// =====================================================
// PASSWORD
// =====================================================

function hashPassword(password) {
  return crypto
    .createHash('sha256')
    .update(String(password))
    .digest('hex');
}

// =====================================================
// DEFAULT STATS
// =====================================================

function getDefaultStats() {
  return {
    mmr_1v1: 100,
    matches_1v1: 0,
    wins_1v1: 0,
    losses_1v1: 0,
    placement_1v1: 0,

    mmr_2v2: 100,
    matches_2v2: 0,
    wins_2v2: 0,
    losses_2v2: 0,
    placement_2v2: 0,

    mmr_5v5: 100,
    matches_5v5: 0,
    wins_5v5: 0,
    losses_5v5: 0,
    placement_5v5: 0,

    totalRankedWins: 0,

    matchHistory: [],

    avatar: '',

    streak: 0
  };
}

// =====================================================
// POSTGRESQL DATABASE
// =====================================================

async function initDatabase() {
  if (!pool) {
    console.warn(
      'DATABASE_URL не задан. PostgreSQL отключён.'
    );
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log('PostgreSQL подключён');
}

// =====================================================
// CREATE SNAPSHOT
// =====================================================

function createSnapshot() {
  return {
    users,
    parties,
    pendingMatches,
    chatMessages,
    privateMessages,
    bans,
    mutes,
    winHistory,
    clans
  };
}

// =====================================================
// SAVE
// =====================================================

async function saveData() {
  try {
    const snapshot = createSnapshot();

    if (pool) {
      await pool.query(
        `
        INSERT INTO app_state
          (id, data, updated_at)
        VALUES
          ($1, $2::jsonb, NOW())

        ON CONFLICT (id)
        DO UPDATE SET
          data = EXCLUDED.data,
          updated_at = NOW()
        `,
        [
          DB_STATE_ID,
          JSON.stringify(snapshot)
        ]
      );

      return;
    }

    // Локальный fallback
    const tmp =
      DATA_FILE + '.tmp';

    fs.writeFileSync(
      tmp,
      JSON.stringify(
        snapshot,
        null,
        2
      ),
      'utf8'
    );

    fs.renameSync(
      tmp,
      DATA_FILE
    );

  } catch (err) {
    console.error(
      'Не удалось сохранить данные:',
      err.message
    );
  }
}

// =====================================================
// LOAD
// =====================================================

async function loadData() {
  try {
    let raw = null;
    let loadedFromFile = false;

    // Сначала PostgreSQL
    if (pool) {
      const result =
        await pool.query(
          'SELECT data FROM app_state WHERE id = $1',
          [DB_STATE_ID]
        );

      if (result.rows.length > 0) {
        raw = result.rows[0].data;

        console.log(
          'Данные загружены из PostgreSQL'
        );
      }
    }

    // Если PostgreSQL пустая,
    // пробуем старый JSON
    if (
      !raw &&
      fs.existsSync(DATA_FILE)
    ) {
      raw = JSON.parse(
        fs.readFileSync(
          DATA_FILE,
          'utf8'
        )
      );

      loadedFromFile = true;

      console.log(
        'Найдены старые данные JSON'
      );
    }

    if (!raw) {
      console.log(
        'Сохранённых данных нет. Создаём новую базу.'
      );

      return;
    }

    users =
      raw.users || {};

    parties =
      raw.parties || {};

    pendingMatches =
      raw.pendingMatches || [];

    chatMessages =
      raw.chatMessages || [];

    privateMessages =
      raw.privateMessages || [];

    bans =
      raw.bans || {};

    mutes =
      raw.mutes || {};

    winHistory =
      raw.winHistory || [];

    clans =
      raw.clans || {};

    // Исправление старых пользователей
    for (const user of Object.values(users)) {

      if (
        user.password &&
        !/^[a-f0-9]{64}$/i.test(
          user.password
        )
      ) {
        user.password =
          hashPassword(
            user.password
          );
      }

      user.friends ||= [];

      user.pendingRequests ||= [];

      user.stats ||=
        getDefaultStats();

      const defaults =
        getDefaultStats();

      for (
        const [key, value]
        of Object.entries(defaults)
      ) {
        if (
          user.stats[key] === undefined
        ) {
          user.stats[key] = value;
        }
      }
    }

    console.log(
      `Данные загружены: ${Object.keys(users).length} пользователей`
    );

    // Перенос старого JSON в PostgreSQL
    if (
      pool &&
      loadedFromFile
    ) {
      await saveData();

      console.log(
        'Старые данные перенесены в PostgreSQL'
      );
    }

  } catch (err) {
    console.error(
      'Не удалось загрузить данные:',
      err.message
    );
  }
}

// =====================================================
// HELPERS
// =====================================================

function generateUserId() {
  let id;

  do {
    id =
      Math.floor(
        Math.random() * 1000000
      )
        .toString()
        .padStart(6, '0');

  } while (users[id]);

  return id;
}

function generatePartyId() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .substr(2, 6)
  );
}

function getLevelByMmr(mmr) {
  if (mmr >= 2001) return 10;
  if (mmr >= 1751) return 9;
  if (mmr >= 1531) return 8;
  if (mmr >= 1351) return 7;
  if (mmr >= 1201) return 6;
  if (mmr >= 1051) return 5;
  if (mmr >= 901) return 4;
  if (mmr >= 751) return 3;
  if (mmr >= 501) return 2;

  return 1;
}

function canPlayRanked(
  userId,
  mode
) {
  const user =
    users[userId];

  if (!user) return false;

  const placementKey =
    `placement_${mode}`;

  return (
    user.stats[placementKey] >= 3
  );
}

// =====================================================
// MATCHMAKING
// =====================================================

function findMatchInQueue(
  mode,
  ranked
) {
  const key =
    `${mode}_${ranked ? 'ranked' : 'unranked'}`;

  const queue =
    queues[key];

  if (
    queue.length === 0
  ) {
    return null;
  }

  const needed =
    mode === '1v1'
      ? 2
      : mode === '2v2'
        ? 4
        : 10;

  if (!ranked) {

    if (
      queue.length >= needed
    ) {
      const participants =
        queue.splice(
          0,
          needed
        );

      return participants.map(
        p => p.userId
      );
    }

    return null;
  }

  const sorted =
    [...queue].sort(
      (a, b) =>
        users[a.userId].stats[
          `mmr_${mode}`
        ] -
        users[b.userId].stats[
          `mmr_${mode}`
        ]
    );

  for (
    let i = 0;
    i <= sorted.length - needed;
    i++
  ) {

    const group =
      sorted.slice(
        i,
        i + needed
      );

    const mmrs =
      group.map(
        p =>
          users[p.userId]
            .stats[`mmr_${mode}`]
      );

    const min =
      Math.min(...mmrs);

    const max =
      Math.max(...mmrs);

    if (
      max - min <= 100
    ) {

      const removed = [];

      for (
        const p of group
      ) {

        const idx =
          queue.findIndex(
            e =>
              e.userId ===
              p.userId
          );

        if (idx !== -1) {
          removed.push(
            ...queue.splice(
              idx,
              1
            )
          );
        }
      }

      return removed.map(
        p => p.userId
      );
    }
  }

  return null;
}

function broadcastQueueState() {
  io.emit(
    'queueUpdate',
    queues
  );
}

function broadcastChatMessage(msg) {
  io.emit(
    'chatMessage',
    msg
  );
}

function sendPrivateMessage(
  toUserId,
  fromUserId,
  text
) {
  const msg = {
    from: fromUserId,
    to: toUserId,
    text,
    timestamp: Date.now(),
    date:
      new Date().toLocaleString()
  };

  privateMessages.push(msg);

  if (
    privateMessages.length > 1000
  ) {
    privateMessages.shift();
  }

  const toSocketId =
    userSockets[toUserId];

  if (toSocketId) {
    io.to(toSocketId).emit(
      'privateMessage',
      {
        from: fromUserId,
        text,
        date: msg.date
      }
    );
  }
}

function isBanned(userId) {
  const ban =
    bans[userId];

  if (
    ban &&
    ban.until > Date.now()
  ) {
    return true;
  }

  if (
    ban &&
    ban.until <= Date.now()
  ) {
    delete bans[userId];
  }

  return false;
}

function isMuted(userId) {
  const mute =
    mutes[userId];

  if (
    mute &&
    mute.until > Date.now()
  ) {
    return true;
  }

  if (
    mute &&
    mute.until <= Date.now()
  ) {
    delete mutes[userId];
  }

  return false;
}

// =====================================================
// LEADERBOARD
// =====================================================

function updateLeaderboard() {
  const now =
    Date.now();

  const dayAgo =
    now -
    24 * 60 * 60 * 1000;

  const weekAgo =
    now -
    7 * 24 * 60 * 60 * 1000;

  const monthAgo =
    now -
    30 * 24 * 60 * 60 * 1000;

  const dayWins = {};
  const weekWins = {};
  const monthWins = {};

  winHistory.forEach(
    entry => {

      if (
        entry.timestamp >=
        dayAgo
      ) {
        dayWins[entry.userId] =
          (dayWins[entry.userId] || 0) + 1;
      }

      if (
        entry.timestamp >=
        weekAgo
      ) {
        weekWins[entry.userId] =
          (weekWins[entry.userId] || 0) + 1;
      }

      if (
        entry.timestamp >=
        monthAgo
      ) {
        monthWins[entry.userId] =
          (monthWins[entry.userId] || 0) + 1;
      }
    }
  );

  const sortFn =
    obj =>
      Object.entries(obj)
        .sort(
          (a, b) =>
            b[1] - a[1]
        )
        .slice(0, 10);

  leaderboardCache.day =
    sortFn(dayWins).map(
      ([uid, wins]) => ({
        userId: uid,
        wins,
        userData:
          users[uid]
      })
    );

  leaderboardCache.week =
    sortFn(weekWins).map(
      ([uid, wins]) => ({
        userId: uid,
        wins,
        userData:
          users[uid]
      })
    );

  leaderboardCache.month =
    sortFn(monthWins).map(
      ([uid, wins]) => ({
        userId: uid,
        wins,
        userData:
          users[uid]
      })
    );

  lastLeaderboardUpdate =
    now;
}

function addWinToHistory(
  userId
) {
  winHistory.push({
    userId,
    timestamp: Date.now()
  });

  if (
    winHistory.length > 10000
  ) {
    winHistory.splice(
      0,
      1000
    );
  }

  updateLeaderboard();

  saveData();
}

// =====================================================
// REGISTER
// =====================================================

app.post(
  '/api/register',
  (req, res) => {

    const {
      username,
      password,
      inGameNick,
      inGameId
    } = req.body;

    if (
      !username ||
      !password ||
      !inGameNick ||
      !inGameId
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Все поля обязательны'
      });
    }

    if (
      Object.values(users)
        .some(
          u =>
            u.username ===
            username
        )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Пользователь с таким логином уже существует'
      });
    }

    const userId =
      generateUserId();

    users[userId] = {
      username,
      password:
        hashPassword(password),
      inGameNick,
      inGameId,

      friends: [],

      pendingRequests: [],

      isAdmin: false,

      clanId: null,

      stats:
        getDefaultStats()
    };

    const adminLogins = [
      'q',
      'bogpvp',
      'admin',
      'Smirkycarp34119'
    ];

    if (
      adminLogins.includes(
        username
      )
    ) {
      users[userId].isAdmin =
        true;
    }

    saveData();

    res.json({
      success: true,
      message:
        `Регистрация успешна! Ваш ID: ${userId}`,
      userId
    });
  }
);

// =====================================================
// LOGIN
// =====================================================

app.post(
  '/api/login',
  (req, res) => {

    const {
      username,
      password
    } = req.body;

    const entry =
      Object.entries(users)
        .find(
          ([_, u]) =>
            u.username ===
              username &&
            (
              u.password ===
                hashPassword(password) ||
              u.password ===
                password
            )
        );

    if (!entry) {
      return res.status(400).json({
        success: false,
        message:
          'Неверный логин или пароль'
      });
    }

    const [
      userId,
      userData
    ] = entry;

    if (
      isBanned(userId)
    ) {
      return res.status(403).json({
        success: false,
        message:
          `Вы забанены до ${new Date(
            bans[userId].until
          ).toLocaleString()}. Причина: ${
            bans[userId].reason
          }`
      });
    }

    const {
      password: storedPassword,
      ...safeUser
    } = userData;

    res.json({
      success: true,
      userData: {
        id: userId,
        ...safeUser,
        stats:
          userData.stats
      }
    });
  }
);

// =====================================================
// USER
// =====================================================

app.get(
  '/api/user/:id',
  (req, res) => {

    const user =
      users[req.params.id];

    if (!user) {
      return res.status(404).json({
        success: false,
        message:
          'Пользователь не найден'
      });
    }

    const {
      password,
      ...safeUser
    } = user;

    res.json({
      success: true,
      userData: {
        id: req.params.id,
        ...safeUser,
        stats: user.stats
      }
    });
  }
);

app.get(
  '/api/user-by-gameid/:gameId',
  (req, res) => {

    const gameId =
      req.params.gameId;

    const entry =
      Object.entries(users)
        .find(
          ([_, u]) =>
            u.inGameId ===
            gameId
        );

    if (!entry) {
      return res.status(404).json({
        success: false,
        message:
          'Игрок не найден'
      });
    }

    const [
      userId,
      userData
    ] = entry;

    const {
      password,
      ...safeUser
    } = userData;

    res.json({
      success: true,
      userData: {
        id: userId,
        ...safeUser,
        stats:
          userData.stats
      }
    });
  }
);

// =====================================================
// STATS
// =====================================================

app.post(
  '/api/update-stats',
  (req, res) => {

    const {
      userId,
      stats
    } = req.body;

    if (!users[userId]) {
      return res.status(404).json({
        success: false
      });
    }

    users[userId].stats =
      stats;

    saveData();

    res.json({
      success: true
    });
  }
);

// =====================================================
// AVATAR
// =====================================================

app.post(
  '/api/upload-avatar',
  upload.single('avatar'),
  (req, res) => {

    const {
      userId
    } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false
      });
    }

    if (!users[userId]) {
      return res.status(404).json({
        success: false
      });
    }

    const avatarUrl =
      `/uploads/${req.file.filename}`;

    users[userId].stats.avatar =
      avatarUrl;

    saveData();

    res.json({
      success: true,
      avatarUrl
    });
  }
);

// =====================================================
// ADMIN
// =====================================================

app.get(
  '/api/check-admin',
  (req, res) => {

    const userId =
      req.query.userId;

    if (
      !userId ||
      !users[userId]
    ) {
      return res.status(401).json({
        isAdmin: false
      });
    }

    res.json({
      isAdmin:
        users[userId].isAdmin
    });
  }
);

app.post(
  '/api/admin-action',
  (req, res) => {

    const {
      adminId,
      targetUserId,
      action,
      reason,
      durationHours
    } = req.body;

    if (
      !users[adminId] ||
      !users[adminId].isAdmin
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Недостаточно прав'
      });
    }

    if (
      !users[targetUserId]
    ) {
      return res.status(404).json({
        success: false,
        message:
          'Целевой пользователь не найден'
      });
    }

    if (
      users[targetUserId].isAdmin &&
      action !== 'unmute' &&
      action !== 'unban'
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Нельзя банить/мутить другого администратора'
      });
    }

    const durationMs =
      Number(durationHours) *
      60 *
      60 *
      1000;

    const until =
      Date.now() +
      durationMs;

    if (action === 'mute') {

      mutes[targetUserId] = {
        until,
        reason
      };

      const sid =
        userSockets[targetUserId];

      if (sid) {
        io.to(sid).emit(
          'muted',
          {
            until,
            reason
          }
        );
      }

    } else if (
      action === 'ban'
    ) {

      bans[targetUserId] = {
        until,
        reason
      };

      const sid =
        userSockets[targetUserId];

      if (sid) {

        io.to(sid).emit(
          'banned',
          {
            until,
            reason
          }
        );

        io.sockets.sockets
          .get(sid)
          ?.disconnect();
      }

    } else if (
      action === 'unmute'
    ) {

      delete mutes[targetUserId];

    } else if (
      action === 'unban'
    ) {

      delete bans[targetUserId];

    } else {

      return res.status(400).json({
        success: false,
        message:
          'Неизвестное действие'
      });
    }

    saveData();

    const actionName =
      action === 'mute'
        ? 'Мут применён'
        : action === 'ban'
          ? 'Бан применён'
          : action === 'unmute'
            ? 'Мут снят'
            : 'Бан снят';

    res.json({
      success: true,
      message: actionName
    });
  }
);

// =====================================================
// CANCEL MATCH
// =====================================================

app.post(
  '/api/cancel-match',
  (req, res) => {

    const {
      adminId,
      matchId
    } = req.body;

    if (
      !users[adminId]?.isAdmin
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Недостаточно прав'
      });
    }

    const idx =
      pendingMatches.findIndex(
        m =>
          m.id === matchId
      );

    if (idx === -1) {
      return res.status(404).json({
        success: false,
        message:
          'Матч не найден'
      });
    }

    const match =
      pendingMatches[idx];

    const otherAdmins =
      match.participants.filter(
        pid =>
          pid !== adminId &&
          users[pid]?.isAdmin
      );

    if (
      otherAdmins.length
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Нельзя отменить матч, в котором участвует другой администратор'
      });
    }

    pendingMatches.splice(
      idx,
      1
    );

    match.participants.forEach(
      pid => {

        const sid =
          userSockets[pid];

        if (sid) {
          io.to(sid).emit(
            'matchCancelled',
            { matchId }
          );
        }
      }
    );

    saveData();

    res.json({
      success: true,
      message:
        'Матч отменён'
    });
  }
);

// =====================================================
// FRIENDS
// =====================================================

app.post(
  '/api/send-friend-request',
  (req, res) => {

    const {
      fromUserId,
      toInGameId
    } = req.body;

    const from =
      users[fromUserId];

    const targetEntry =
      Object.entries(users)
        .find(
          ([_, u]) =>
            u.inGameId ===
            toInGameId
        );

    if (
      !from ||
      !targetEntry
    ) {
      return res.status(404).json({
        success: false,
        message:
          'Пользователь не найден'
      });
    }

    const [
      targetId,
      target
    ] = targetEntry;

    if (
      targetId === fromUserId
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Нельзя добавить себя'
      });
    }

    if (
      from.friends.includes(
        targetId
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Вы уже друзья'
      });
    }

    if (
      target.pendingRequests.includes(
        fromUserId
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Заявка уже отправлена'
      });
    }

    target.pendingRequests.push(
      fromUserId
    );

    saveData();

    const sid =
      userSockets[targetId];

    if (sid) {
      io.to(sid).emit(
        'friendRequest',
        {
          from: fromUserId,
          fromName:
            from.inGameNick
        }
      );
    }

    res.json({
      success: true
    });
  }
);

app.post(
  '/api/accept-friend',
  (req, res) => {

    const {
      userId,
      friendId
    } = req.body;

    const user =
      users[userId];

    const friend =
      users[friendId];

    if (
      !user ||
      !friend
    ) {
      return res.status(404).json({
        success: false
      });
    }

    user.pendingRequests =
      user.pendingRequests.filter(
        id =>
          id !== friendId
      );

    if (
      !user.friends.includes(
        friendId
      )
    ) {
      user.friends.push(
        friendId
      );
    }

    if (
      !friend.friends.includes(
        userId
      )
    ) {
      friend.friends.push(
        userId
      );
    }

    saveData();

    const sid =
      userSockets[friendId];

    if (sid) {
      io.to(sid).emit(
        'friendAdded',
        userId
      );
    }

    res.json({
      success: true
    });
  }
);

app.post(
  '/api/reject-friend',
  (req, res) => {

    const {
      userId,
      friendId
    } = req.body;

    const user =
      users[userId];

    if (!user) {
      return res.status(404).json({
        success: false
      });
    }

    user.pendingRequests =
      user.pendingRequests.filter(
        id =>
          id !== friendId
      );

    saveData();

    res.json({
      success: true
    });
  }
);

app.post(
  '/api/remove-friend',
  (req, res) => {

    const {
      userId,
      friendId
    } = req.body;

    const user =
      users[userId];

    const friend =
      users[friendId];

    if (
      !user ||
      !friend
    ) {
      return res.status(404).json({
        success: false
      });
    }

    user.friends =
      user.friends.filter(
        id =>
          id !== friendId
      );

    friend.friends =
      friend.friends.filter(
        id =>
          id !== userId
      );

    saveData();

    res.json({
      success: true
    });
  }
);

// =====================================================
// SEARCH USERS
// =====================================================

app.get(
  '/api/search-users',
  (req, res) => {

    const q =
      String(
        req.query.q || ''
      )
        .trim()
        .toLowerCase();

    if (!q) {
      return res.json({
        success: true,
        users: []
      });
    }

    const result =
      Object.entries(users)
        .filter(
          ([id, u]) =>
            id
              .toLowerCase()
              .includes(q) ||
            String(
              u.inGameId || ''
            )
              .toLowerCase()
              .includes(q) ||
            String(
              u.inGameNick || ''
            )
              .toLowerCase()
              .includes(q)
        )
        .slice(0, 20)
        .map(
          ([id, u]) => ({
            id,
            inGameNick:
              u.inGameNick,
            inGameId:
              u.inGameId,
            avatar:
              u.stats?.avatar || '',
            isAdmin:
              !!u.isAdmin
          })
        );

    res.json({
      success: true,
      users: result
    });
  }
);

// =====================================================
// TOP PLAYERS
// =====================================================

app.get(
  '/api/top-players',
  (req, res) => {

    if (
      Date.now() -
        lastLeaderboardUpdate >
      5 * 60 * 1000
    ) {
      updateLeaderboard();
    }

    res.json({
      success: true,
      data:
        leaderboardCache
    });
  }
);

// =====================================================
// CHANGE NICK
// =====================================================

app.post(
  '/api/change-nick',
  (req, res) => {

    const {
      userId,
      newNick
    } = req.body;

    if (!users[userId]) {
      return res.status(404).json({
        success: false,
        message:
          'Пользователь не найден'
      });
    }

    if (
      !newNick ||
      newNick.trim().length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Ник не может быть пустым'
      });
    }

    users[userId].inGameNick =
      newNick;

    saveData();

    res.json({
      success: true
    });
  }
);

// =====================================================
// CLANS
// =====================================================

app.get(
  '/api/clan-info',
  (req, res) => {

    const {
      userId
    } = req.query;

    if (!users[userId]) {
      return res.status(404).json({
        success: false
      });
    }

    const clanId =
      users[userId].clanId;

    if (!clanId) {
      return res.json({
        success: true,
        clan: null
      });
    }

    const clan =
      clans[clanId];

    if (!clan) {
      return res.json({
        success: true,
        clan: null
      });
    }

    const membersData =
      clan.members.map(
        mid => {

          const m =
            users[mid];

          return {
            id: mid,
            username:
              m?.username,
            inGameNick:
              m?.inGameNick,
            avatar:
              m?.stats?.avatar
          };
        }
      );

    res.json({
      success: true,
      clan: {
        ...clan,
        members:
          membersData
      }
    });
  }
);

app.post(
  '/api/create-clan',
  (req, res) => {

    const {
      userId,
      clanTag,
      clanName
    } = req.body;

    const user =
      users[userId];

    if (!user) {
      return res.status(404).json({
        success: false,
        message:
          'Пользователь не найден'
      });
    }

    if (user.clanId) {
      return res.status(400).json({
        success: false,
        message:
          'Вы уже состоите в клане'
      });
    }

    if (
      !clanTag ||
      clanTag.length > 5
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Тег клана должен быть до 5 символов'
      });
    }

    if (
      !clanName ||
      clanName.length > 32
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Название клана должно быть до 32 символов'
      });
    }

    if (
      !user.isAdmin &&
      user.stats.totalRankedWins < 10
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Для создания клана необходимо 10 побед в рейтинговых матчах'
      });
    }

    const clanId =
      Date.now().toString(36) +
      Math.random()
        .toString(36)
        .substr(2, 6);

    clans[clanId] = {
      name: clanName,
      tag: clanTag,
      ownerId: userId,
      members: [userId],
      created: Date.now(),
      maxMembers: 50
    };

    user.clanId =
      clanId;

    saveData();

    res.json({
      success: true,
      clanId
    });
  }
);

app.post(
  '/api/join-clan',
  (req, res) => {

    const {
      userId,
      clanId
    } = req.body;

    const user =
      users[userId];

    if (!user) {
      return res.status(404).json({
        success: false,
        message:
          'Пользователь не найден'
      });
    }

    if (user.clanId) {
      return res.status(400).json({
        success: false,
        message:
          'Вы уже в клане'
      });
    }

    const clan =
      clans[clanId];

    if (!clan) {
      return res.status(404).json({
        success: false,
        message:
          'Клан не найден'
      });
    }

    if (
      clan.members.length >=
      clan.maxMembers
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Клан заполнен'
      });
    }

    clan.members.push(
      userId
    );

    user.clanId =
      clanId;

    saveData();

    res.json({
      success: true
    });
  }
);

app.post(
  '/api/leave-clan',
  (req, res) => {

    const {
      userId
    } = req.body;

    const user =
      users[userId];

    if (
      !user ||
      !user.clanId
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Вы не состоите в клане'
      });
    }

    const clan =
      clans[user.clanId];

    if (clan) {

      clan.members =
        clan.members.filter(
          mid =>
            mid !== userId
        );

      if (
        clan.members.length === 0
      ) {
        delete clans[
          user.clanId
        ];
      }
    }

    user.clanId = null;

    saveData();

    res.json({
      success: true
    });
  }
);

// =====================================================
// PARTY
// =====================================================

app.post(
  '/api/create-party',
  (req, res) => {

    const {
      leaderId
    } = req.body;

    if (
      Object.values(parties)
        .some(
          p =>
            p.members.includes(
              leaderId
            )
        )
    ) {
      return res.json({
        success: false,
        message:
          'Вы уже в пати'
      });
    }

    const partyId =
      generatePartyId();

    parties[partyId] = {
      leaderId,
      members: [
        leaderId
      ]
    };

    saveData();

    res.json({
      success: true,
      partyId
    });
  }
);

app.post(
  '/api/join-party',
  (req, res) => {

    const {
      partyId,
      userId
    } = req.body;

    const party =
      parties[partyId];

    if (!party) {
      return res.status(404).json({
        success: false,
        message:
          'Пати не найдена'
      });
    }

    if (
      party.members.includes(
        userId
      )
    ) {
      return res.json({
        success: false,
        message:
          'Уже в пати'
      });
    }

    party.members.push(
      userId
    );

    party.members.forEach(
      m => {

        const s =
          userSockets[m];

        if (s) {
          io.to(s).emit(
            'partyUpdate',
            party
          );
        }
      }
    );

    saveData();

    res.json({
      success: true
    });
  }
);

app.post(
  '/api/leave-party',
  (req, res) => {

    const {
      partyId,
      userId
    } = req.body;

    const party =
      parties[partyId];

    if (!party) {
      return res.status(404).json({
        success: false,
        message:
          'Пати не найдена'
      });
    }

    const idx =
      party.members.indexOf(
        userId
      );

    if (idx === -1) {
      return res.json({
        success: false,
        message:
          'Вы не в этой пати'
      });
    }

    party.members.splice(
      idx,
      1
    );

    if (
      party.members.length === 0
    ) {

      delete parties[
        partyId
      ];

    } else {

      if (
        party.leaderId ===
        userId
      ) {
        party.leaderId =
          party.members[0];
      }

      party.members.forEach(
        m => {

          const s =
            userSockets[m];

          if (s) {
            io.to(s).emit(
              'partyUpdate',
              party
            );
          }
        }
      );
    }

    saveData();

    res.json({
      success: true
    });
  }
);

// =====================================================
// SCREENSHOT
// =====================================================

app.post(
  '/api/upload-screenshot',
  upload.single('screenshot'),
  (req, res) => {

    const {
      matchId,
      userId
    } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message:
          'Файл не загружен'
      });
    }

    const match =
      pendingMatches.find(
        m =>
          m.id === matchId
      );

    if (
      !match ||
      !match.participants.includes(
        userId
      )
    ) {
      return res.status(404).json({
        success: false,
        message:
          'Матч не найден'
      });
    }

    match.screenshots ||=
      [];

    match.screenshots.push({
      userId,
      url:
        `/uploads/${req.file.filename}`,
      createdAt:
        Date.now()
    });

    saveData();

    res.json({
      success: true,
      screenshotUrl:
        `/uploads/${req.file.filename}`
    });
  }
);

// =====================================================
// ADMIN USERS
// =====================================================

app.get(
  '/api/admin/users',
  (req, res) => {

    const adminId =
      req.query.adminId;

    if (
      !users[adminId]?.isAdmin
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Недостаточно прав'
      });
    }

    const list =
      Object.entries(users)
        .map(
          ([id, u]) => ({
            id,
            inGameNick:
              u.inGameNick,
            inGameId:
              u.inGameId,
            isAdmin:
              !!u.isAdmin,
            banned:
              isBanned(id),
            muted:
              isMuted(id),
            stats:
              u.stats
          })
        );

    res.json({
      success: true,
      users: list
    });
  }
);

// =====================================================
// ADMIN MATCHES
// =====================================================

app.get(
  '/api/admin/matches',
  (req, res) => {

    const adminId =
      req.query.adminId;

    if (
      !users[adminId]?.isAdmin
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Недостаточно прав'
      });
    }

    const matches =
      pendingMatches.map(
        m => ({
          ...m,

          participants:
            m.participants.map(
              pid => ({
                id: pid,
                inGameNick:
                  users[pid]
                    ?.inGameNick,
                inGameId:
                  users[pid]
                    ?.inGameId,
                avatar:
                  users[pid]
                    ?.stats?.avatar ||
                  ''
              })
            )
        })
      );

    res.json({
      success: true,
      matches
    });
  }
);

// =====================================================
// SOCKET.IO
// =====================================================

io.on(
  'connection',
  socket => {

    console.log(
      'Клиент подключился:',
      socket.id
    );

    // ---------------------------------------------
    // AUTH
    // ---------------------------------------------

    socket.on(
      'auth',
      userId => {

        if (
          isBanned(userId)
        ) {

          socket.emit(
            'banned',
            {
              until:
                bans[userId]
                  .until,
              reason:
                bans[userId]
                  .reason
            }
          );

          socket.disconnect();

          return;
        }

        socketToUser[
          socket.id
        ] = userId;

        userSockets[
          userId
        ] = socket.id;

        console.log(
          `Пользователь ${userId} авторизован`
        );

        socket.emit(
          'queueUpdate',
          queues
        );

        socket.emit(
          'chatHistory',
          chatMessages.slice(-50)
        );

        const userPrivate =
          privateMessages.filter(
            m =>
              m.to === userId ||
              m.from === userId
          );

        socket.emit(
          'privateHistory',
          userPrivate.slice(-50)
        );

        const user =
          users[userId];

        if (user) {
          socket.emit(
            'friendList',
            {
              friends:
                user.friends,
              requests:
                user.pendingRequests
            }
          );
        }

        for (
          const pid in parties
        ) {

          if (
            parties[pid]
              .members
              .includes(userId)
          ) {

            socket.emit(
              'partyUpdate',
              parties[pid]
            );

            break;
          }
        }
      }
    );

    // ---------------------------------------------
    // JOIN QUEUE
    // ---------------------------------------------

    socket.on(
      'joinQueue',
      ({
        mode,
        ranked,
        partyId
      }) => {

        const userId =
          socketToUser[
            socket.id
          ];

        if (!userId) return;

        if (
          isMuted(userId)
        ) {
          socket.emit(
            'queueError',
            {
              message:
                'Вы замьючены и не можете встать в очередь'
            }
          );

          return;
        }

        const user =
          users[userId];

        if (!user) return;

        if (
          ranked &&
          !canPlayRanked(
            userId,
            mode
          )
        ) {

          socket.emit(
            'queueError',
            {
              message:
                `Вы не можете играть ранговый режим, пока не выиграете 3 матча в обычном ${mode}`
            }
          );

          return;
        }

        let participants = [
          userId
        ];

        if (
          partyId &&
          parties[partyId] &&
          parties[partyId]
            .members
            .includes(userId)
        ) {
          participants =
            parties[partyId]
              .members;
        }

        const key =
          `${mode}_${ranked ? 'ranked' : 'unranked'}`;

        const queue =
          queues[key];

        participants.forEach(
          pid => {

            if (
              !queue.some(
                entry =>
                  entry.userId ===
                  pid
              )
            ) {

              queue.push({
                userId: pid,
                mmr:
                  users[pid]
                    .stats[
                      `mmr_${mode}`
                    ]
              });
            }
          }
        );

        broadcastQueueState();

        const matchParticipants =
          findMatchInQueue(
            mode,
            ranked
          );

        const needed =
          mode === '1v1'
            ? 2
            : mode === '2v2'
              ? 4
              : 10;

        if (
          matchParticipants &&
          matchParticipants.length >=
            needed
        ) {

          const maps = [
            'Sandstone',
            'Rust',
            'Province',
            'Dune',
            'Breeze'
          ];

          const map =
            maps[
              Math.floor(
                Math.random() *
                  maps.length
              )
            ];

          const match = {
            id:
              Date.now().toString(),

            mode,

            ranked,

            map,

            participants:
              matchParticipants,

            timestamp:
              Date.now(),

            status:
              'waiting_accept'
          };

          pendingMatches.push(
            match
          );

          saveData();

          console.log(
            'Матч создан:',
            match.id,
            'участники:',
            matchParticipants
          );

          matchParticipants.forEach(
            pid => {

              const sid =
                userSockets[pid];

              if (sid) {
                io.to(sid).emit(
                  'matchFound',
                  {
                    matchId:
                      match.id,

                    mode,

                    ranked,

                    map,

                    participants:
                      matchParticipants,

                    timeout:
                      15000
                  }
                );
              }
            }
          );

          setTimeout(
            () => {

              const m =
                pendingMatches.find(
                  m =>
                    m.id ===
                    match.id
                );

              if (
                m &&
                m.status ===
                  'waiting_accept'
              ) {

                m.status =
                  'cancelled';

                const idx =
                  pendingMatches.findIndex(
                    m2 =>
                      m2.id ===
                      match.id
                  );

                if (
                  idx !== -1
                ) {
                  pendingMatches.splice(
                    idx,
                    1
                  );
                }

                matchParticipants.forEach(
                  pid => {

                    const sid =
                      userSockets[pid];

                    if (sid) {
                      io.to(sid).emit(
                        'matchCancelled',
                        {
                          matchId:
                            match.id
                        }
                      );
                    }
                  }
                );

                saveData();
              }

            },
            15000
          );
        }
      }
    );

    // ---------------------------------------------
    // LEAVE QUEUE
    // ---------------------------------------------

    socket.on(
      'leaveQueue',
      ({
        mode,
        ranked
      }) => {

        const userId =
          socketToUser[
            socket.id
          ];

        if (!userId) return;

        const key =
          `${mode}_${ranked ? 'ranked' : 'unranked'}`;

        const queue =
          queues[key];

        const idx =
          queue.findIndex(
            entry =>
              entry.userId ===
              userId
          );

        if (idx !== -1) {

          queue.splice(
            idx,
            1
          );

          broadcastQueueState();
        }
      }
    );

    // ---------------------------------------------
    // ACCEPT MATCH
    // ---------------------------------------------

    socket.on(
      'acceptMatch',
      ({ matchId }) => {

        const userId =
          socketToUser[
            socket.id
          ];

        const match =
          pendingMatches.find(
            m =>
              m.id ===
              matchId
          );

        if (
          !match ||
          match.status !==
            'waiting_accept'
        ) {
          return;
        }

        if (!match.accepted) {
          match.accepted = [];
        }

        if (
          !match.accepted.includes(
            userId
          )
        ) {
          match.accepted.push(
            userId
          );
        }

        const needed =
          match.mode === '1v1'
            ? 2
            : match.mode === '2v2'
              ? 4
              : 10;

        console.log(
          `Приняли матч ${matchId}: ${match.accepted.length}/${needed}`
        );

        if (
          match.accepted.length ===
          needed
        ) {

          match.status =
            'draft';

          const shuffled =
            [...match.participants];

          for (
            let i =
              shuffled.length - 1;
            i > 0;
            i--
          ) {

            const j =
              Math.floor(
                Math.random() *
                  (i + 1)
              );

            [
              shuffled[i],
              shuffled[j]
            ] = [
              shuffled[j],
              shuffled[i]
            ];
          }

          const captains = [
            shuffled[0],
            shuffled[1]
          ];

          drafts[match.id] = {
            captains,

            turn: 0,

            remainingPlayers:
              shuffled.slice(2),

            teamA: [
              captains[0]
            ],

            teamB: [
              captains[1]
            ]
          };

          match.participants.forEach(
            pid => {

              const sid =
                userSockets[pid];

              if (sid) {
                io.to(sid).emit(
                  'draftStart',
                  {
                    matchId,

                    captains,

                    remainingPlayers:
                      drafts[
                        match.id
                      ]
                        .remainingPlayers,

                    teamA:
                      drafts[
                        match.id
                      ].teamA,

                    teamB:
                      drafts[
                        match.id
                      ].teamB
                  }
                );
              }
            }
          );

          saveData();

        } else {

          socket.emit(
            'matchAccepted',
            { matchId }
          );
        }
      }
    );

    // ---------------------------------------------
    // DRAFT
    // ---------------------------------------------

    socket.on(
      'draftPick',
      ({
        matchId,
        pickedUserId
      }) => {

        const userId =
          socketToUser[
            socket.id
          ];

        const draft =
          drafts[matchId];

        if (!draft) return;

        const match =
          pendingMatches.find(
            m =>
              m.id ===
              matchId
          );

        if (
          !match ||
          match.status !==
            'draft'
        ) {
          return;
        }

        const currentCaptain =
          draft.captains[
            draft.turn % 2
          ];

        if (
          userId !==
          currentCaptain
        ) {
          return;
        }

        if (
          !draft.remainingPlayers.includes(
            pickedUserId
          )
        ) {
          return;
        }

        draft.remainingPlayers =
          draft.remainingPlayers.filter(
            pid =>
              pid !==
              pickedUserId
          );

        if (
          draft.turn % 2 === 0
        ) {
          draft.teamA.push(
            pickedUserId
          );
        } else {
          draft.teamB.push(
            pickedUserId
          );
        }

        draft.turn++;

        if (
          draft.remainingPlayers.length ===
          0
        ) {

          match.status =
            'map_vote';

          mapVotes[match.id] = {
            votes: {},
            totalVoters: 0
          };

          match.participants.forEach(
            pid => {

              const sid =
                userSockets[pid];

              if (sid) {
                io.to(sid).emit(
                  'mapVoteStart',
                  {
                    matchId,

                    maps: [
                      'Sandstone',
                      'Rust',
                      'Province',
                      'Dune',
                      'Breeze'
                    ]
                  }
                );
              }
            }
          );

        } else {

          match.participants.forEach(
            pid => {

              const sid =
                userSockets[pid];

              if (sid) {
                io.to(sid).emit(
                  'draftUpdate',
                  {
                    remainingPlayers:
                      draft.remainingPlayers,

                    teamA:
                      draft.teamA,

                    teamB:
                      draft.teamB,

                    nextCaptain:
                      draft.captains[
                        draft.turn % 2
                      ]
                  }
                );
              }
            }
          );
        }

        saveData();
      }
    );

    // ---------------------------------------------
    // MAP VOTE
    // ---------------------------------------------

    socket.on(
      'mapVote',
      ({
        matchId,
        mapName
      }) => {

        const userId =
          socketToUser[
            socket.id
          ];

        const match =
          pendingMatches.find(
            m =>
              m.id ===
              matchId
          );

        if (
          !match ||
          match.status !==
            'map_vote'
        ) {
          return;
        }

        const votes =
          mapVotes[match.id];

        if (!votes) return;

        // Один голос от одного игрока
        if (
          votes.votedUsers?.includes(
            userId
          )
        ) {
          return;
        }

        votes.votedUsers ||=
          [];

        votes.votedUsers.push(
          userId
        );

        votes.votes[mapName] =
          (votes.votes[mapName] || 0) +
          1;

        votes.totalVoters++;

        if (
          votes.totalVoters ===
          match.participants.length
        ) {

          let bestMap = null;
          let bestCount = 0;

          for (
            const [map, cnt]
            of Object.entries(
              votes.votes
            )
          ) {

            if (
              cnt >
              bestCount
            ) {
              bestCount =
                cnt;

              bestMap =
                map;
            }
          }

          const finalMap =
            bestMap ||
            'Sandstone';

          match.map =
            finalMap;

          match.status =
            'lobby';

          // Сохраняем команды ДО удаления draft
          const teamA =
            drafts[match.id]
              ?.teamA || [];

          const teamB =
            drafts[match.id]
              ?.teamB || [];

          delete drafts[
            match.id
          ];

          delete mapVotes[
            match.id
          ];

          match.teamA =
            teamA;

          match.teamB =
            teamB;

          match.participants.forEach(
            pid => {

              const sid =
                userSockets[pid];

              if (sid) {

                io.to(sid).emit(
                  'lobbyOpen',
                  {
                    matchId,

                    mode:
                      match.mode,

                    ranked:
                      match.ranked,

                    map:
                      finalMap,

                    participants:
                      match.participants,

                    teamA,

                    teamB
                  }
                );
              }
            }
          );

          saveData();
        }
      }
    );

    // ---------------------------------------------
    // DECLINE MATCH
    // ---------------------------------------------

    socket.on(
      'declineMatch',
      ({ matchId }) => {

        const match =
          pendingMatches.find(
            m =>
              m.id ===
              matchId
          );

        if (
          match &&
          match.status ===
            'waiting_accept'
        ) {

          match.status =
            'cancelled';

          const idx =
            pendingMatches.findIndex(
              m =>
                m.id ===
                matchId
            );

          if (idx !== -1) {
            pendingMatches.splice(
              idx,
              1
            );
          }

          match.participants.forEach(
            pid => {

              const sid =
                userSockets[pid];

              if (sid) {
                io.to(sid).emit(
                  'matchCancelled',
                  { matchId }
                );
              }
            }
          );

          saveData();
        }
      }
    );

    // ---------------------------------------------
    // LOBBY CHAT
    // ---------------------------------------------

    socket.on(
      'lobbyChat',
      ({
        matchId,
        text
      }) => {

        const userId =
          socketToUser[
            socket.id
          ];

        if (
          isMuted(userId)
        ) {
          socket.emit(
            'queueError',
            {
              message:
                'Вы замьючены и не можете писать в чат'
            }
          );

          return;
        }

        const match =
          pendingMatches.find(
            m =>
              m.id ===
              matchId
          );

        if (
          !match ||
          match.status !==
            'lobby'
        ) {
          return;
        }

        const user =
          users[userId];

        match.participants.forEach(
          pid => {

            const sid =
              userSockets[pid];

            if (sid) {
              io.to(sid).emit(
                'lobbyMessage',
                {
                  from:
                    user.inGameNick,

                  text,

                  date:
                    new Date()
                      .toLocaleString()
                }
              );
            }
          }
        );
      }
    );

    // ---------------------------------------------
    // GLOBAL CHAT
    // ---------------------------------------------

    socket.on(
      'chatMessage',
      text => {

        const userId =
          socketToUser[
            socket.id
          ];

        if (!userId) return;

        if (
          isMuted(userId)
        ) {
          socket.emit(
            'queueError',
            {
              message:
                'Вы замьючены и не можете писать в чат'
            }
          );

          return;
        }

        const user =
          users[userId];

        if (!user) return;

        const msg = {
          userId,

          username:
            user.inGameNick,

          inGameNick:
            user.inGameNick,

          avatar:
            user.stats.avatar,

          text,

          timestamp:
            Date.now(),

          date:
            new Date()
              .toLocaleString()
        };

        chatMessages.push(
          msg
        );

        if (
          chatMessages.length >
          100
        ) {
          chatMessages.shift();
        }

        broadcastChatMessage(
          msg
        );

        saveData();
      }
    );

    // ---------------------------------------------
    // PRIVATE MESSAGE
    // ---------------------------------------------

    socket.on(
      'privateMessage',
      ({
        toUserId,
        text
      }) => {

        const fromUserId =
          socketToUser[
            socket.id
          ];

        if (
          !fromUserId ||
          !users[toUserId]
        ) {
          return;
        }

        if (
          isMuted(fromUserId)
        ) {
          socket.emit(
            'queueError',
            {
              message:
                'Вы замьючены и не можете отправлять личные сообщения'
            }
          );

          return;
        }

        sendPrivateMessage(
          toUserId,
          fromUserId,
          text
        );

        saveData();
      }
    );

    // ---------------------------------------------
    // PARTY INVITE
    // ---------------------------------------------

    socket.on(
      'inviteToParty',
      ({
        partyId,
        targetUserId
      }) => {

        const fromUserId =
          socketToUser[
            socket.id
          ];

        if (!fromUserId)
          return;

        const party =
          parties[partyId];

        if (!party)
          return;

        const targetSocket =
          userSockets[
            targetUserId
          ];

        if (targetSocket) {
          io.to(
            targetSocket
          ).emit(
            'partyInvite',
            {
              fromUserId,

              fromName:
                users[
                  fromUserId
                ]
                  .inGameNick,

              partyId
            }
          );
        }
      }
    );

    // ---------------------------------------------
    // ACCEPT PARTY
    // ---------------------------------------------

    socket.on(
      'acceptPartyInvite',
      ({ partyId }) => {

        const userId =
          socketToUser[
            socket.id
          ];

        if (!userId)
          return;

        const party =
          parties[partyId];

        if (!party)
          return;

        if (
          !party.members.includes(
            userId
          )
        ) {

          party.members.push(
            userId
          );

          party.members.forEach(
            m => {

              const s =
                userSockets[m];

              if (s) {
                io.to(s).emit(
                  'partyUpdate',
                  party
                );
              }
            }
          );

          saveData();
        }
      }
    );

    // ---------------------------------------------
    // DISCONNECT
    // ---------------------------------------------

    socket.on(
      'disconnect',
      () => {

        const userId =
          socketToUser[
            socket.id
          ];

        if (userId) {

          delete userSockets[
            userId
          ];

          delete socketToUser[
            socket.id
          ];

          for (
            const key in queues
          ) {

            const idx =
              queues[key].findIndex(
                entry =>
                  entry.userId ===
                  userId
              );

            if (idx !== -1) {

              queues[key].splice(
                idx,
                1
              );
            }
          }

          broadcastQueueState();

          for (
            const pid in parties
          ) {

            const party =
              parties[pid];

            if (
              party.members.includes(
                userId
              )
            ) {

              party.members =
                party.members.filter(
                  id =>
                    id !==
                    userId
                );

              if (
                party.members.length ===
                0
              ) {

                delete parties[
                  pid
                ];

              } else {

                if (
                  party.leaderId ===
                  userId
                ) {
                  party.leaderId =
                    party.members[0];
                }

                party.members.forEach(
                  m => {

                    const s =
                      userSockets[m];

                    if (s) {
                      io.to(s).emit(
                        'partyUpdate',
                        party
                      );
                    }
                  }
                );
              }

              break;
            }
          }

          saveData();

          console.log(
            `Пользователь ${userId} отключился`
          );
        }
      }
    );
  }
);

// =====================================================
// START SERVER
// =====================================================

const PORT =
  process.env.PORT || 3000;

async function startServer() {
  try {

    await initDatabase();

    await loadData();

    setInterval(
      () => {
        saveData().catch(
          err =>
            console.error(
              'Ошибка автосохранения:',
              err.message
            )
        );
      },
      15000
    );

    process.on(
      'SIGTERM',
      async () => {

        await saveData();

        if (pool) {
          await pool.end();
        }

        process.exit(0);
      }
    );

    process.on(
      'SIGINT',
      async () => {

        await saveData();

        if (pool) {
          await pool.end();
        }

        process.exit(0);
      }
    );

    server.listen(
      PORT,
      () => {
        console.log(
          `Сервер запущен на порту ${PORT}`
        );
      }
    );

  } catch (err) {

    console.error(
      'Критическая ошибка запуска:',
      err
    );

    process.exit(1);
  }
}

startServer();
