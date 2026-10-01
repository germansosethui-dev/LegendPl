const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'legendpl-data.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

/* =========================================================
   UPLOADS
========================================================= */

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),

  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

/* =========================================================
   DATA
========================================================= */

let users = {};
let parties = {};
let clans = {};
let chatMessages = [];
let privateMessages = [];
let matches = [];
let bans = {};
let mutes = {};

const queues = {
  '1v1_unranked': [],
  '1v1_ranked': [],

  '2v2_unranked': [],
  '2v2_ranked': [],

  '5v5_unranked': [],
  '5v5_ranked': []
};

const userSockets = {};
const socketUsers = {};

const activeMatches = new Map();

const ADMIN_LOGINS = [
  'q',
  'bogpvp',
  'admin',
  'Smirkycarp34119'
];

const MAPS = [
  'Sandstone',
  'Rust',
  'Province',
  'Dune',
  'Breeze'
];

/* =========================================================
   HELPERS
========================================================= */

function hashPassword(password) {
  return crypto
    .createHash('sha256')
    .update(String(password))
    .digest('hex');
}

function generateId(length = 8) {
  return crypto
    .randomBytes(length)
    .toString('hex');
}

function generateUserId() {
  let id;

  do {
    id = String(Math.floor(Math.random() * 1000000))
      .padStart(6, '0');
  } while (users[id]);

  return id;
}

function generatePartyId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).substring(2, 8)
  ).toUpperCase();
}

function defaultModeStats() {
  return {
    mmr: 1000,
    matches: 0,
    wins: 0,
    losses: 0,
    streak: 0,
    bestStreak: 0,
    kills: 0,
    deaths: 0,
    unrankedMatches: 0,
    unrankedWins: 0,
    rankedMatches: 0,
    rankedWins: 0
  };
}

function defaultStats() {
  return {
    '1v1': defaultModeStats(),
    '2v2': defaultModeStats(),
    '5v5': defaultModeStats(),

    totalMatches: 0,
    totalWins: 0,
    totalLosses: 0,
    streak: 0,
    bestStreak: 0,

    avatar: ''
  };
}

function normalizeUser(user) {
  if (!user) return;

  if (!user.stats) {
    user.stats = defaultStats();
  }

  for (const mode of ['1v1', '2v2', '5v5']) {
    if (!user.stats[mode]) {
      user.stats[mode] = defaultModeStats();
    }

    user.stats[mode] = {
      ...defaultModeStats(),
      ...user.stats[mode]
    };
  }

  user.stats.totalMatches ??= 0;
  user.stats.totalWins ??= 0;
  user.stats.totalLosses ??= 0;
  user.stats.streak ??= 0;
  user.stats.bestStreak ??= 0;
  user.stats.avatar ??= '';

  user.friends ||= [];
  user.pendingRequests ||= [];
  user.clanId ||= null;
  user.isAdmin = !!user.isAdmin;
}

function safeUser(id) {
  const user = users[id];

  if (!user) return null;

  normalizeUser(user);

  return {
    id,

    username: user.username,
    inGameNick: user.inGameNick,
    inGameId: user.inGameId,

    avatar: user.stats.avatar || '',

    friends: user.friends || [],
    pendingRequests: user.pendingRequests || [],

    isAdmin: !!user.isAdmin,
    clanId: user.clanId || null,

    stats: user.stats
  };
}

function saveData() {
  try {
    const data = {
      users,
      parties,
      clans,
      chatMessages,
      privateMessages,
      matches,
      bans,
      mutes
    };

    const temp = DATA_FILE + '.tmp';

    fs.writeFileSync(
      temp,
      JSON.stringify(data, null, 2),
      'utf8'
    );

    fs.renameSync(temp, DATA_FILE);
  } catch (err) {
    console.error('Ошибка сохранения:', err);
  }
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, 'utf8')
    );

    users = data.users || {};
    parties = data.parties || {};
    clans = data.clans || {};
    chatMessages = data.chatMessages || [];
    privateMessages = data.privateMessages || [];
    matches = data.matches || [];
    bans = data.bans || {};
    mutes = data.mutes || {};

    for (const user of Object.values(users)) {
      if (
        user.password &&
        !/^[a-f0-9]{64}$/i.test(user.password)
      ) {
        user.password = hashPassword(user.password);
      }

      normalizeUser(user);
    }

    console.log(
      `Загружено пользователей: ${Object.keys(users).length}`
    );
  } catch (err) {
    console.error('Ошибка загрузки:', err);
  }
}

loadData();

setInterval(saveData, 15000);

process.on('SIGINT', () => {
  saveData();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveData();
  process.exit(0);
});

/* =========================================================
   BAN / MUTE
========================================================= */

function isBanned(id) {
  const ban = bans[id];

  if (!ban) return false;

  if (ban.until > Date.now()) {
    return true;
  }

  delete bans[id];
  saveData();

  return false;
}

function isMuted(id) {
  const mute = mutes[id];

  if (!mute) return false;

  if (mute.until > Date.now()) {
    return true;
  }

  delete mutes[id];
  saveData();

  return false;
}

/* =========================================================
   RANKED
========================================================= */

function canPlayRanked(userId, mode) {
  const user = users[userId];

  if (!user) return false;

  normalizeUser(user);

  /*
    Для рейтингового режима нужны
    минимум 3 обычные победы именно
    в этом режиме.
  */

  return user.stats[mode].unrankedWins >= 3;
}

/* =========================================================
   QUEUE
========================================================= */

function getNeeded(mode) {
  if (mode === '1v1') return 2;
  if (mode === '2v2') return 4;
  return 10;
}

function queueKey(mode, ranked) {
  return `${mode}_${ranked ? 'ranked' : 'unranked'}`;
}

function broadcastQueues() {
  io.emit('queueUpdate', queues);
}

function removeUserFromAllQueues(userId) {
  for (const key of Object.keys(queues)) {
    queues[key] = queues[key].filter(
      item => item.userId !== userId
    );
  }

  broadcastQueues();
}

function removePartyFromQueue(partyId, mode, ranked) {
  const party = parties[partyId];

  if (!party) return;

  const key = queueKey(mode, ranked);

  queues[key] = queues[key].filter(
    item => !party.members.includes(item.userId)
  );
}

function makeMatch(mode, ranked, participantIds) {
  const matchId = generateId(10);

  const match = {
    id: matchId,

    mode,
    ranked,

    map: MAPS[Math.floor(Math.random() * MAPS.length)],

    participants: participantIds,

    accepted: [],

    status: 'waiting_accept',

    createdAt: Date.now(),

    acceptDeadline: Date.now() + 20000,

    teamA: [],
    teamB: []
  };

  matches.push(match);
  activeMatches.set(matchId, match);

  saveData();

  return match;
}

function emitToUser(userId, event, data) {
  const socketId = userSockets[userId];

  if (!socketId) return;

  io.to(socketId).emit(event, data);
}

function emitToMatch(match, event, data) {
  for (const userId of match.participants) {
    emitToUser(userId, event, data);
  }
}

function createTeams(match) {
  const shuffled = [...match.participants];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [shuffled[i], shuffled[j]] =
      [shuffled[j], shuffled[i]];
  }

  const half = Math.ceil(shuffled.length / 2);

  match.teamA = shuffled.slice(0, half);
  match.teamB = shuffled.slice(half);
}

function publicMatch(match) {
  return {
    matchId: match.id,

    mode: match.mode,
    ranked: match.ranked,

    map: match.map,

    participants: match.participants,

    accepted: match.accepted,

    status: match.status,

    teamA: match.teamA,
    teamB: match.teamB,

    acceptDeadline: match.acceptDeadline
  };
}

/* =========================================================
   AUTH
========================================================= */

app.post('/api/register', (req, res) => {
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
      message: 'Заполните все поля'
    });
  }

  if (
    Object.values(users).some(
      user => user.username.toLowerCase() ===
        username.toLowerCase()
    )
  ) {
    return res.status(400).json({
      success: false,
      message: 'Такой логин уже существует'
    });
  }

  const id = generateUserId();

  users[id] = {
    username,
    password: hashPassword(password),

    inGameNick,
    inGameId,

    friends: [],
    pendingRequests: [],

    isAdmin: ADMIN_LOGINS.includes(username),

    clanId: null,

    stats: defaultStats(),

    createdAt: Date.now()
  };

  saveData();

  res.json({
    success: true,
    message: `Регистрация успешна. Ваш ID: ${id}`,
    userId: id
  });
});

app.post('/api/login', (req, res) => {
  const {
    username,
    password
  } = req.body;

  const hashed = hashPassword(password);

  const entry = Object.entries(users).find(
    ([, user]) =>
      user.username === username &&
      (
        user.password === hashed ||
        user.password === password
      )
  );

  if (!entry) {
    return res.status(401).json({
      success: false,
      message: 'Неверный логин или пароль'
    });
  }

  const [id, user] = entry;

  normalizeUser(user);

  if (isBanned(id)) {
    return res.status(403).json({
      success: false,
      message:
        `Вы заблокированы до ${new Date(
          bans[id].until
        ).toLocaleString()}. Причина: ${bans[id].reason}`
    });
  }

  res.json({
    success: true,
    userData: safeUser(id)
  });
});

app.get('/api/user/:id', (req, res) => {
  const user = safeUser(req.params.id);

  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Игрок не найден'
    });
  }

  res.json({
    success: true,
    userData: user
  });
});

/* =========================================================
   AVATAR
========================================================= */

app.post(
  '/api/upload-avatar',
  upload.single('avatar'),
  (req, res) => {
    const { userId } = req.body;

    if (!users[userId]) {
      return res.status(404).json({
        success: false,
        message: 'Игрок не найден'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Файл не выбран'
      });
    }

    const url = `/uploads/${req.file.filename}`;

    users[userId].stats.avatar = url;

    saveData();

    res.json({
      success: true,
      avatarUrl: url
    });
  }
);

/* =========================================================
   NICK
========================================================= */

app.post('/api/change-nick', (req, res) => {
  const {
    userId,
    newNick
  } = req.body;

  if (!users[userId]) {
    return res.status(404).json({
      success: false,
      message: 'Игрок не найден'
    });
  }

  const nick = String(newNick || '').trim();

  if (!nick) {
    return res.status(400).json({
      success: false,
      message: 'Ник не может быть пустым'
    });
  }

  if (nick.length > 24) {
    return res.status(400).json({
      success: false,
      message: 'Максимум 24 символа'
    });
  }

  users[userId].inGameNick = nick;

  saveData();

  res.json({
    success: true,
    userData: safeUser(userId)
  });
});

/* =========================================================
   FRIENDS
========================================================= */

app.post('/api/send-friend-request', (req, res) => {
  const {
    fromUserId,
    toUserId
  } = req.body;

  const from = users[fromUserId];
  const target = users[toUserId];

  if (!from || !target) {
    return res.status(404).json({
      success: false,
      message: 'Игрок не найден'
    });
  }

  if (fromUserId === toUserId) {
    return res.status(400).json({
      success: false,
      message: 'Нельзя добавить себя'
    });
  }

  if (from.friends.includes(toUserId)) {
    return res.status(400).json({
      success: false,
      message: 'Вы уже друзья'
    });
  }

  if (target.pendingRequests.includes(fromUserId)) {
    return res.status(400).json({
      success: false,
      message: 'Заявка уже отправлена'
    });
  }

  target.pendingRequests.push(fromUserId);

  saveData();

  emitToUser(
    toUserId,
    'friendRequest',
    {
      from: fromUserId,
      fromName: from.inGameNick
    }
  );

  res.json({ success: true });
});

app.post('/api/accept-friend', (req, res) => {
  const {
    userId,
    friendId
  } = req.body;

  const user = users[userId];
  const friend = users[friendId];

  if (!user || !friend) {
    return res.status(404).json({
      success: false
    });
  }

  user.pendingRequests =
    user.pendingRequests.filter(
      id => id !== friendId
    );

  if (!user.friends.includes(friendId)) {
    user.friends.push(friendId);
  }

  if (!friend.friends.includes(userId)) {
    friend.friends.push(userId);
  }

  saveData();

  emitToUser(
    friendId,
    'friendAdded',
    userId
  );

  res.json({ success: true });
});

app.post('/api/reject-friend', (req, res) => {
  const {
    userId,
    friendId
  } = req.body;

  if (!users[userId]) {
    return res.status(404).json({
      success: false
    });
  }

  users[userId].pendingRequests =
    users[userId].pendingRequests.filter(
      id => id !== friendId
    );

  saveData();

  res.json({ success: true });
});

app.post('/api/remove-friend', (req, res) => {
  const {
    userId,
    friendId
  } = req.body;

  if (!users[userId] || !users[friendId]) {
    return res.status(404).json({
      success: false
    });
  }

  users[userId].friends =
    users[userId].friends.filter(
      id => id !== friendId
    );

  users[friendId].friends =
    users[friendId].friends.filter(
      id => id !== userId
    );

  saveData();

  res.json({ success: true });
});

app.get('/api/search-users', (req, res) => {
  const q = String(req.query.q || '')
    .trim()
    .toLowerCase();

  if (!q) {
    return res.json({
      success: true,
      users: []
    });
  }

  const result = Object.entries(users)
    .filter(([id, user]) =>
      id.toLowerCase().includes(q) ||
      String(user.inGameNick)
        .toLowerCase()
        .includes(q) ||
      String(user.inGameId)
        .toLowerCase()
        .includes(q) ||
      String(user.username)
        .toLowerCase()
        .includes(q)
    )
    .slice(0, 30)
    .map(([id]) => safeUser(id));

  res.json({
    success: true,
    users: result
  });
});

/* =========================================================
   PARTY
========================================================= */

function getUserParty(userId) {
  return Object.values(parties)
    .find(party =>
      party.members.includes(userId)
    );
}

app.get('/api/my-party', (req, res) => {
  const userId = req.query.userId;

  const party = getUserParty(userId);

  res.json({
    success: true,
    party: party || null
  });
});

app.post('/api/create-party', (req, res) => {
  const { leaderId } = req.body;

  if (!users[leaderId]) {
    return res.status(404).json({
      success: false,
      message: 'Игрок не найден'
    });
  }

  const oldParty = getUserParty(leaderId);

  if (oldParty) {
    return res.json({
      success: false,
      message: 'Вы уже в пати',
      party: oldParty
    });
  }

  const id = generatePartyId();

  parties[id] = {
    id,
    leaderId,
    members: [leaderId],
    createdAt: Date.now()
  };

  saveData();

  res.json({
    success: true,
    party: parties[id]
  });
});

app.post('/api/join-party', (req, res) => {
  const {
    partyId,
    userId
  } = req.body;

  const party = parties[partyId];

  if (!party) {
    return res.status(404).json({
      success: false,
      message: 'Пати не найдена'
    });
  }

  if (!users[userId]) {
    return res.status(404).json({
      success: false,
      message: 'Игрок не найден'
    });
  }

  const oldParty = getUserParty(userId);

  if (oldParty && oldParty.id !== partyId) {
    return res.status(400).json({
      success: false,
      message: 'Вы уже в другой пати'
    });
  }

  if (!party.members.includes(userId)) {
    if (party.members.length >= 5) {
      return res.status(400).json({
        success: false,
        message: 'Пати заполнена'
      });
    }

    party.members.push(userId);
  }

  saveData();

  for (const member of party.members) {
    emitToUser(
      member,
      'partyUpdate',
      party
    );
  }

  res.json({
    success: true,
    party
  });
});

app.post('/api/leave-party', (req, res) => {
  const {
    partyId,
    userId
  } = req.body;

  const party = parties[partyId];

  if (!party) {
    return res.status(404).json({
      success: false,
      message: 'Пати не найдена'
    });
  }

  party.members =
    party.members.filter(
      id => id !== userId
    );

  if (party.leaderId === userId) {
    party.leaderId =
      party.members[0] || null;
  }

  if (party.members.length === 0) {
    delete parties[partyId];
  } else {
    for (const member of party.members) {
      emitToUser(
        member,
        'partyUpdate',
        party
      );
    }
  }

  saveData();

  res.json({
    success: true
  });
});

/* =========================================================
   CLANS
========================================================= */

app.get('/api/clan-info', (req, res) => {
  const userId = req.query.userId;
  const user = users[userId];

  if (!user) {
    return res.status(404).json({
      success: false
    });
  }

  if (!user.clanId || !clans[user.clanId]) {
    return res.json({
      success: true,
      clan: null
    });
  }

  const clan = clans[user.clanId];

  res.json({
    success: true,

    clan: {
      id: clan.id,
      name: clan.name,
      tag: clan.tag,
      ownerId: clan.ownerId,
      maxMembers: clan.maxMembers,
      createdAt: clan.createdAt,

      members: clan.members
        .map(id => safeUser(id))
        .filter(Boolean)
    }
  });
});

app.post('/api/create-clan', (req, res) => {
  const {
    userId,
    clanTag,
    clanName
  } = req.body;

  const user = users[userId];

  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Игрок не найден'
    });
  }

  if (user.clanId) {
    return res.status(400).json({
      success: false,
      message: 'Вы уже состоите в клане'
    });
  }

  const tag = String(clanTag || '')
    .trim()
    .toUpperCase();

  const name = String(clanName || '')
    .trim();

  if (!tag || tag.length > 5) {
    return res.status(400).json({
      success: false,
      message: 'Тег: от 1 до 5 символов'
    });
  }

  if (!name || name.length > 32) {
    return res.status(400).json({
      success: false,
      message: 'Название: от 1 до 32 символов'
    });
  }

  const id = generateId(8);

  clans[id] = {
    id,
    tag,
    name,
    ownerId: userId,
    members: [userId],
    maxMembers: 50,
    createdAt: Date.now()
  };

  user.clanId = id;

  saveData();

  res.json({
    success: true,
    clanId: id
  });
});

app.post('/api/join-clan', (req, res) => {
  const {
    userId,
    clanId
  } = req.body;

  const user = users[userId];
  const clan = clans[clanId];

  if (!user || !clan) {
    return res.status(404).json({
      success: false,
      message: 'Клан не найден'
    });
  }

  if (user.clanId) {
    return res.status(400).json({
      success: false,
      message: 'Вы уже в клане'
    });
  }

  if (clan.members.length >= clan.maxMembers) {
    return res.status(400).json({
      success: false,
      message: 'Клан заполнен'
    });
  }

  clan.members.push(userId);
  user.clanId = clanId;

  saveData();

  res.json({
    success: true
  });
});

app.post('/api/leave-clan', (req, res) => {
  const { userId } = req.body;

  const user = users[userId];

  if (!user || !user.clanId) {
    return res.status(400).json({
      success: false,
      message: 'Вы не состоите в клане'
    });
  }

  const clan = clans[user.clanId];

  if (clan) {
    clan.members =
      clan.members.filter(
        id => id !== userId
      );

    if (clan.ownerId === userId) {
      clan.ownerId =
        clan.members[0] || null;
    }

    if (clan.members.length === 0) {
      delete clans[clan.id];
    }
  }

  user.clanId = null;

  saveData();

  res.json({
    success: true
  });
});

/* =========================================================
   TOP
========================================================= */

app.get('/api/top-players', (req, res) => {
  const list = Object.entries(users)
    .map(([id]) => safeUser(id))
    .filter(Boolean)
    .sort((a, b) => {
      const aMmr =
        a.stats['1v1'].mmr +
        a.stats['2v2'].mmr +
        a.stats['5v5'].mmr;

      const bMmr =
        b.stats['1v1'].mmr +
        b.stats['2v2'].mmr +
        b.stats['5v5'].mmr;

      return bMmr - aMmr;
    })
    .slice(0, 50);

  res.json({
    success: true,
    players: list
  });
});

/* =========================================================
   CHAT
========================================================= */

app.get('/api/chat-history', (req, res) => {
  res.json({
    success: true,
    messages: chatMessages.slice(-100)
  });
});

/* =========================================================
   MATCH RESULT
========================================================= */

app.post('/api/finish-match', (req, res) => {
  const {
    matchId,
    winnerTeam
  } = req.body;

  const match = activeMatches.get(matchId);

  if (!match) {
    return res.status(404).json({
      success: false,
      message: 'Матч не найден'
    });
  }

  if (match.status !== 'lobby') {
    return res.status(400).json({
      success: false,
      message: 'Матч уже завершён или ещё не начался'
    });
  }

  if (!['A', 'B'].includes(winnerTeam)) {
    return res.status(400).json({
      success: false,
      message: 'Неверная команда'
    });
  }

  const winners =
    winnerTeam === 'A'
      ? match.teamA
      : match.teamB;

  const losers =
    winnerTeam === 'A'
      ? match.teamB
      : match.teamA;

  for (const id of match.participants) {
    const user = users[id];

    if (!user) continue;

    const modeStats = user.stats[match.mode];

    const won = winners.includes(id);

    modeStats.matches++;

    if (match.ranked) {
      modeStats.rankedMatches++;
    } else {
      modeStats.unrankedMatches++;
    }

    if (won) {
      modeStats.wins++;

      if (match.ranked) {
        modeStats.rankedWins++;
      } else {
        modeStats.unrankedWins++;
      }

      modeStats.streak++;
      modeStats.bestStreak =
        Math.max(
          modeStats.bestStreak,
          modeStats.streak
        );

      modeStats.mmr += match.ranked ? 25 : 10;

      user.stats.totalWins++;
      user.stats.streak++;
      user.stats.bestStreak =
        Math.max(
          user.stats.bestStreak,
          user.stats.streak
        );
    } else {
      modeStats.losses++;

      modeStats.streak = 0;

      modeStats.mmr =
        Math.max(
          0,
          modeStats.mmr -
            (match.ranked ? 20 : 5)
        );

      user.stats.totalLosses++;
      user.stats.streak = 0;
    }

    user.stats.totalMatches++;

    user.stats.matchHistory ||= [];

    user.stats.matchHistory.unshift({
      matchId,
      mode: match.mode,
      ranked: match.ranked,
      map: match.map,
      result: won ? 'Победа' : 'Поражение',
      date: new Date().toLocaleString()
    });

    user.stats.matchHistory =
      user.stats.matchHistory.slice(0, 100);
  }

  match.status = 'finished';

  activeMatches.delete(matchId);

  emitToMatch(
    match,
    'matchFinished',
    {
      matchId,
      winnerTeam
    }
  );

  saveData();

  res.json({
    success: true
  });
});

/* =========================================================
   ADMIN
========================================================= */

app.get('/api/check-admin', (req, res) => {
  const id = req.query.userId;

  res.json({
    success: true,
    isAdmin: !!users[id]?.isAdmin
  });
});

app.get('/api/admin/users', (req, res) => {
  const adminId = req.query.adminId;

  if (!users[adminId]?.isAdmin) {
    return res.status(403).json({
      success: false,
      message: 'Нет доступа'
    });
  }

  const list = Object.entries(users)
    .map(([id, user]) => ({
      id,
      username: user.username,
      inGameNick: user.inGameNick,
      inGameId: user.inGameId,
      avatar: user.stats?.avatar || '',
      isAdmin: !!user.isAdmin,
      banned: isBanned(id),
      muted: isMuted(id),
      stats: user.stats
    }));

  res.json({
    success: true,
    users: list
  });
});

app.post('/api/admin-action', (req, res) => {
  const {
    adminId,
    targetUserId,
    action,
    durationHours,
    reason
  } = req.body;

  if (!users[adminId]?.isAdmin) {
    return res.status(403).json({
      success: false,
      message: 'Нет доступа'
    });
  }

  if (!users[targetUserId]) {
    return res.status(404).json({
      success: false,
      message: 'Игрок не найден'
    });
  }

  if (
    users[targetUserId].isAdmin &&
    adminId !== targetUserId
  ) {
    return res.status(403).json({
      success: false,
      message: 'Нельзя применять это действие к администратору'
    });
  }

  const hours =
    Math.max(
      1,
      Number(durationHours) || 1
    );

  const until =
    Date.now() +
    hours * 60 * 60 * 1000;

  if (action === 'ban') {
    bans[targetUserId] = {
      until,
      reason: reason || 'Без причины'
    };

    emitToUser(
      targetUserId,
      'banned',
      bans[targetUserId]
    );
  }

  else if (action === 'mute') {
    mutes[targetUserId] = {
      until,
      reason: reason || 'Без причины'
    };

    emitToUser(
      targetUserId,
      'muted',
      mutes[targetUserId]
    );
  }

  else if (action === 'unban') {
    delete bans[targetUserId];
  }

  else if (action === 'unmute') {
    delete mutes[targetUserId];
  }

  else {
    return res.status(400).json({
      success: false,
      message: 'Неизвестное действие'
    });
  }

  saveData();

  res.json({
    success: true
  });
});

/* =========================================================
   SOCKET.IO
========================================================= */

io.on('connection', socket => {

  console.log(
    'Socket подключён:',
    socket.id
  );

  socket.on('auth', userId => {

    if (!users[userId]) return;

    if (isBanned(userId)) {
      socket.emit(
        'banned',
        bans[userId]
      );

      socket.disconnect();

      return;
    }

    socketUsers[socket.id] = userId;
    userSockets[userId] = socket.id;

    normalizeUser(users[userId]);

    socket.emit(
      'queueUpdate',
      queues
    );

    socket.emit(
      'chatHistory',
      chatMessages.slice(-100)
    );

    socket.emit(
      'privateHistory',
      privateMessages.filter(
        m =>
          m.from === userId ||
          m.to === userId
      ).slice(-100)
    );

    const party =
      getUserParty(userId);

    if (party) {
      socket.emit(
        'partyUpdate',
        party
      );
    }

    for (const match of activeMatches.values()) {
      if (
        match.participants.includes(userId) &&
        (
          match.status === 'waiting_accept' ||
          match.status === 'lobby'
        )
      ) {
        socket.emit(
          match.status === 'waiting_accept'
            ? 'matchFound'
            : 'lobbyOpen',
          match.status === 'waiting_accept'
            ? publicMatch(match)
            : publicMatch(match)
        );
      }
    }
  });

  /* ================= QUEUE ================= */

  socket.on(
    'joinQueue',
    ({
      mode,
      ranked,
      partyId
    }) => {

      const userId =
        socketUsers[socket.id];

      if (!userId) return;

      if (!['1v1', '2v2', '5v5'].includes(mode)) {
        return;
      }

      if (isMuted(userId)) {
        socket.emit(
          'queueError',
          {
            message:
              'Вы не можете вставать в очередь во время мута'
          }
        );

        return;
      }

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
              `Для рангового ${mode} нужны 3 победы в обычном режиме ${mode}.`
          }
        );

        return;
      }

      const key =
        queueKey(mode, ranked);

      const party =
        partyId &&
        parties[partyId] &&
        parties[partyId].members.includes(userId)
          ? parties[partyId]
          : null;

      const members =
        party
          ? [...party.members]
          : [userId];

      const needed =
        getNeeded(mode);

      if (members.length > needed) {
        socket.emit(
          'queueError',
          {
            message:
              'В пати слишком много игроков для этого режима'
          }
        );

        return;
      }

      for (const id of members) {
        if (!queues[key].some(
          item => item.userId === id
        )) {
          queues[key].push({
            userId: id,
            partyId: party?.id || null
          });
        }
      }

      broadcastQueues();

      if (queues[key].length >= needed) {

        const selected =
          queues[key].splice(
            0,
            needed
          );

        const participantIds =
          selected.map(
            item => item.userId
          );

        const match =
          makeMatch(
            mode,
            !!ranked,
            participantIds
          );

        broadcastQueues();

        const payload =
          publicMatch(match);

        for (
          const participantId
          of participantIds
        ) {
          emitToUser(
            participantId,
            'matchFound',
            payload
          );
        }

        /*
          РОВНО 20 секунд.
        */

        setTimeout(() => {

          const current =
            activeMatches.get(
              match.id
            );

          if (
            !current ||
            current.status !== 'waiting_accept'
          ) {
            return;
          }

          current.status =
            'cancelled';

          activeMatches.delete(
            current.id
          );

          emitToMatch(
            current,
            'matchCancelled',
            {
              matchId: current.id,
              reason:
                'Не все игроки приняли матч'
            }
          );

          saveData();

        }, 20000);
      }
    }
  );

  socket.on(
    'leaveQueue',
    ({
      mode,
      ranked
    }) => {

      const userId =
        socketUsers[socket.id];

      if (!userId) return;

      const key =
        queueKey(mode, ranked);

      queues[key] =
        queues[key].filter(
          item =>
            item.userId !== userId
        );

      broadcastQueues();
    }
  );

  /* ================= MATCH ACCEPT ================= */

  socket.on(
    'acceptMatch',
    ({ matchId }) => {

      const userId =
        socketUsers[socket.id];

      const match =
        activeMatches.get(matchId);

      if (!match) return;

      if (
        match.status !== 'waiting_accept'
      ) {
        return;
      }

      if (
        Date.now() >
        match.acceptDeadline
      ) {
        return;
      }

      if (
        !match.participants.includes(
          userId
        )
      ) {
        return;
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

      emitToMatch(
        match,
        'matchAcceptanceUpdate',
        {
          matchId,
          accepted:
            match.accepted.length,
          total:
            match.participants.length
        }
      );

      if (
        match.accepted.length ===
        match.participants.length
      ) {

        match.status =
          'lobby';

        createTeams(match);

        emitToMatch(
          match,
          'lobbyOpen',
          publicMatch(match)
        );

        saveData();
      }
    }
  );

  socket.on(
    'declineMatch',
    ({ matchId }) => {

      const userId =
        socketUsers[socket.id];

      const match =
        activeMatches.get(matchId);

      if (!match) return;

      if (
        !match.participants.includes(
          userId
        )
      ) return;

      if (
        match.status !==
        'waiting_accept'
      ) return;

      match.status =
        'cancelled';

      activeMatches.delete(
        matchId
      );

      emitToMatch(
        match,
        'matchCancelled',
        {
          matchId,
          reason:
            'Игрок отклонил матч'
        }
      );

      saveData();
    }
  );

  /* ================= LOBBY CHAT ================= */

  socket.on(
    'lobbyChat',
    ({
      matchId,
      text
    }) => {

      const userId =
        socketUsers[socket.id];

      const match =
        activeMatches.get(matchId);

      if (!match) return;

      if (match.status !== 'lobby') {
        return;
      }

      if (isMuted(userId)) {
        socket.emit(
          'queueError',
          {
            message:
              'Вы замьючены'
          }
        );

        return;
      }

      const user =
        users[userId];

      const message = {
        userId,
        username:
          user.inGameNick,
        text:
          String(text || '').slice(
            0,
            500
          ),
        date:
          new Date().toLocaleString()
      };

      emitToMatch(
        match,
        'lobbyMessage',
        message
      );
    }
  );

  /* ================= GLOBAL CHAT ================= */

  socket.on(
    'chatMessage',
    text => {

      const userId =
        socketUsers[socket.id];

      if (!userId) return;

      if (isMuted(userId)) {
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

      const cleanText =
        String(text || '')
          .trim()
          .slice(0, 500);

      if (!cleanText) return;

      const message = {
        userId,

        username:
          String(user.inGameNick),

        text:
          cleanText,

        avatar:
          user.stats.avatar || '',

        date:
          new Date().toLocaleString(),

        timestamp:
          Date.now()
      };

      chatMessages.push(message);

      if (chatMessages.length > 100) {
        chatMessages.shift();
      }

      io.emit(
        'chatMessage',
        message
      );

      saveData();
    }
  );

  /* ================= PRIVATE CHAT ================= */

  socket.on(
    'privateMessage',
    ({
      toUserId,
      text
    }) => {

      const fromUserId =
        socketUsers[socket.id];

      if (
        !fromUserId ||
        !users[toUserId]
      ) return;

      if (isMuted(fromUserId)) {
        socket.emit(
          'queueError',
          {
            message:
              'Вы замьючены'
          }
        );

        return;
      }

      const message = {
        from:
          fromUserId,

        to:
          toUserId,

        text:
          String(text || '').slice(
            0,
            500
          ),

        date:
          new Date().toLocaleString()
      };

      privateMessages.push(
        message
      );

      if (privateMessages.length > 1000) {
        privateMessages.shift();
      }

      emitToUser(
        toUserId,
        'privateMessage',
        message
      );

      emitToUser(
        fromUserId,
        'privateMessage',
        message
      );

      saveData();
    }
  );

  /* ================= PARTY INVITES ================= */

  socket.on(
    'inviteToParty',
    ({
      partyId,
      targetUserId
    }) => {

      const fromUserId =
        socketUsers[socket.id];

      const party =
        parties[partyId];

      if (!party) return;

      if (
        !party.members.includes(
          fromUserId
        )
      ) return;

      const target =
        users[targetUserId];

      if (!target) return;

      emitToUser(
        targetUserId,
        'partyInvite',
        {
          partyId,
          fromUserId,
          fromName:
            users[fromUserId].inGameNick
        }
      );
    }
  );

  socket.on(
    'acceptPartyInvite',
    ({ partyId }) => {

      const userId =
        socketUsers[socket.id];

      const party =
        parties[partyId];

      if (!party) return;

      if (
        getUserParty(userId)
      ) return;

      if (
        party.members.length >= 5
      ) return;

      party.members.push(
        userId
      );

      saveData();

      for (
        const id
        of party.members
      ) {
        emitToUser(
          id,
          'partyUpdate',
          party
        );
      }
    }
  );

  /* ================= DISCONNECT ================= */

  socket.on(
    'disconnect',
    () => {

      const userId =
        socketUsers[socket.id];

      if (!userId) return;

      /*
        ВАЖНО:
        пати НЕ удаляем при обновлении страницы.
        Именно это исправляет исчезновение пати.
      */

      if (
        userSockets[userId] ===
        socket.id
      ) {
        delete userSockets[userId];
      }

      delete socketUsers[socket.id];

      /*
        Из очереди пользователя
        удаляем только при отключении.
      */

      removeUserFromAllQueues(
        userId
      );

      console.log(
        'Отключён:',
        userId
      );
    }
  );
});

/* =========================================================
   DEFAULT ROUTE
========================================================= */

app.get('*', (req, res) => {
  res.sendFile(
    path.join(
      PUBLIC_DIR,
      'index.html'
    )
  );
});

/* =========================================================
   START
========================================================= */

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  () => {
    console.log(
      `Legend Pl запущен на порту ${PORT}`
    );
  }
);