const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DATA_FILE = path.join(DATA_DIR, "legendpl-data.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

/* =========================================================
   UPLOADS
========================================================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || ".jpg");
    const name =
      Date.now() +
      "-" +
      crypto.randomBytes(5).toString("hex") +
      ext;

    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 8 * 1024 * 1024
  }
});

/* =========================================================
   DATA
========================================================= */

let users = {};
let parties = {};
let pendingMatches = [];
let chatMessages = [];
let privateMessages = [];
let clans = {};
let reports = [];
let matchHistory = [];

const queues = {
  "1v1_unranked": [],
  "1v1_ranked": [],
  "2v2_unranked": [],
  "2v2_ranked": [],
  "5v5_unranked": [],
  "5v5_ranked": []
};

const userSockets = {};
const socketUsers = {};

/* =========================================================
   CONSTANTS
========================================================= */

const ADMIN_LOGINS = [
  "ыж"
];

const MODES = {
  "1v1": 2,
  "2v2": 4,
  "5v5": 10
};

const MAPS = [
  "Sandstone",
  "Breeze",
  "Province",
  "Rust",
  "Dune",
  "Hanami",
  "Prison"
];

const ROUND_OPTIONS = [8, 10, 13, 16];

/* =========================================================
   PASSWORD
========================================================= */

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password))
    .digest("hex");
}

/* =========================================================
   DEFAULT STATS
========================================================= */

function defaultModeStats() {
  return {
    elo: 100,
    level: 1,
    matches: 0,
    wins: 0,
    losses: 0,
    streak: 0,
    bestStreak: 0,
    kills: 0,
    deaths: 0,
    kd: 0
  };
}

function getDefaultStats() {
  return {
    avatar: "",
    sticker: "",

    "1v1": defaultModeStats(),
    "2v2": defaultModeStats(),
    "5v5": defaultModeStats(),

    totalWins: 0,
    totalLosses: 0,

    unrankedWins1v1: 0,
    unrankedWins2v2: 0,
    unrankedWins5v5: 0,

    matchHistory: [],

    unrankedMatches1v1: 0,
    unrankedMatches2v2: 0,
    unrankedMatches5v5: 0
  };
}

/* =========================================================
   LEVEL
========================================================= */

function getLevel(elo) {
  elo = Number(elo) || 100;

  if (elo >= 2001) return 10;
  if (elo >= 1751) return 9;
  if (elo >= 1531) return 8;
  if (elo >= 1351) return 7;
  if (elo >= 1201) return 6;
  if (elo >= 1051) return 5;
  if (elo >= 901) return 4;
  if (elo >= 751) return 3;
  if (elo >= 501) return 2;

  return 1;
}

function levelName(elo) {
  return `Уровень ${getLevel(elo)}`;
}

/* =========================================================
   MIGRATION
========================================================= */

function normalizeStats(old) {
  const base = getDefaultStats();

  if (!old || typeof old !== "object") {
    return base;
  }

  base.avatar = old.avatar || "";

  base.sticker = old.sticker || "";

  for (const mode of ["1v1", "2v2", "5v5"]) {
    const oldElo =
      old[`mmr_${mode}`] ??
      old[`${mode}_elo`] ??
      old[mode]?.elo ??
      100;

    const oldMatches =
      old[`matches_${mode}`] ??
      old[mode]?.matches ??
      0;

    const oldWins =
      old[`wins_${mode}`] ??
      old[mode]?.wins ??
      0;

    const oldLosses =
      old[`losses_${mode}`] ??
      old[mode]?.losses ??
      0;

    base[mode] = {
      elo: Math.max(100, Number(oldElo) || 100),
      level: getLevel(Number(oldElo) || 100),
      matches: Number(oldMatches) || 0,
      wins: Number(oldWins) || 0,
      losses: Number(oldLosses) || 0,
      streak: old[mode]?.streak || 0,
      bestStreak: old[mode]?.bestStreak || 0,
      kills: old[mode]?.kills || 0,
      deaths: old[mode]?.deaths || 0,
      kd: old[mode]?.kd || 0
    };
  }

  base.totalWins =
    Number(old.totalWins) ||
    Object.values(base).reduce(
      (n, v) => n + (v && typeof v === "object" ? Number(v.wins || 0) : 0),
      0
    );

  base.totalLosses =
    Number(old.totalLosses) ||
    Object.values(base).reduce(
      (n, v) => n + (v && typeof v === "object" ? Number(v.losses || 0) : 0),
      0
    );

  base.unrankedWins1v1 = Number(old.unrankedWins1v1) || 0;
  base.unrankedWins2v2 = Number(old.unrankedWins2v2) || 0;
  base.unrankedWins5v5 = Number(old.unrankedWins5v5) || 0;
  base.unrankedMatches1v1 = Number(old.unrankedMatches1v1) || 0;
  base.unrankedMatches2v2 = Number(old.unrankedMatches2v2) || 0;
  base.unrankedMatches5v5 = Number(old.unrankedMatches5v5) || 0;

  base.matchHistory =
    Array.isArray(old.matchHistory)
      ? old.matchHistory
      : [];

  return base;
}

/* =========================================================
   PERSISTENCE
========================================================= */

function saveData() {
  try {
    const snapshot = {
      users,
      parties,
      pendingMatches,
      chatMessages,
      privateMessages,
      clans,
      reports,
      matchHistory,
      queues
    };

    const tmp = DATA_FILE + ".tmp";

    fs.writeFileSync(
      tmp,
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );

    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error(
      "Ошибка сохранения:",
      err.message
    );
  }
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }

    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    users = data.users || {};
    parties = data.parties || {};
    pendingMatches = data.pendingMatches || [];
    chatMessages = data.chatMessages || [];
    privateMessages = data.privateMessages || [];
    clans = data.clans || {};
    reports = data.reports || [];
    matchHistory = data.matchHistory || [];

    if (data.queues && typeof data.queues === "object") {
      for (const key of Object.keys(queues)) {
        queues[key] = Array.isArray(data.queues[key]) ? data.queues[key] : [];
      }
    }

    for (const [id, user] of Object.entries(users)) {
      user.friends ||= [];
      user.pendingRequests ||= [];
      user.clanId ||= null;
      user.isAdmin = Boolean(user.isAdmin);

      user.stats = normalizeStats(user.stats);
      if (typeof user.password === "string" && user.password.length !== 64) {
        user.password = hashPassword(user.password);
      }

      if (
        ADMIN_LOGINS.includes(
          String(user.username).toLowerCase()
        )
      ) {
        user.isAdmin = true;
      }
    }

    console.log(
      `Загружено пользователей: ${Object.keys(users).length}`
    );
  } catch (err) {
    console.error(
      "Ошибка загрузки данных:",
      err.message
    );
  }
}

loadData();

/* =========================================================
   AUTH / SESSION API
========================================================= */

app.post("/api/register", (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const inGameNick = String(req.body?.inGameNick || "").trim();
    const inGameId = String(req.body?.inGameId || "").trim();

    if (!username || !password || !inGameNick || !inGameId) {
      return res.status(400).json({
        success: false,
        message: "Заполните все поля."
      });
    }

    if (username.length < 3 || username.length > 24) {
      return res.status(400).json({
        success: false,
        message: "Логин должен содержать от 3 до 24 символов."
      });
    }

    if (password.length < 4 || password.length > 128) {
      return res.status(400).json({
        success: false,
        message: "Пароль должен содержать от 4 до 128 символов."
      });
    }

    if (inGameNick.length > 32) {
      return res.status(400).json({
        success: false,
        message: "Ник в игре: максимум 32 символа."
      });
    }

    if (inGameId.length > 64) {
      return res.status(400).json({
        success: false,
        message: "ID в игре: максимум 64 символа."
      });
    }

    const normalized = username.toLowerCase();
    const exists = Object.values(users).some(
      user => String(user.username || "").toLowerCase() === normalized
    );

    if (exists) {
      return res.status(409).json({
        success: false,
        message: "Такой логин уже занят."
      });
    }

    const id = generateUserId();
    const user = {
      username,
      password: hashPassword(password),
      inGameNick,
      inGameId,
      friends: [],
      pendingRequests: [],
      clanId: null,
      isAdmin: ADMIN_LOGINS.includes(normalized),
      stats: getDefaultStats(),
      createdAt: Date.now()
    };

    users[id] = user;
    saveData();

    return res.status(201).json({
      success: true,
      message: "Регистрация успешна. Теперь войдите.",
      user: safeUser(id)
    });
  } catch (err) {
    console.error("Ошибка регистрации:", err);
    return res.status(500).json({
      success: false,
      message: "Не удалось зарегистрировать аккаунт."
    });
  }
});

app.post("/api/login", (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Введите логин и пароль."
      });
    }

    const normalized = username.toLowerCase();
    const entry = Object.entries(users).find(
      ([, user]) => String(user.username || "").toLowerCase() === normalized
    );

    if (!entry) {
      return res.status(401).json({
        success: false,
        message: "Неверный логин или пароль."
      });
    }

    const [id, user] = entry;

    if (isBanned(id)) {
      const left = Math.max(1, Math.ceil((user.ban.until - Date.now()) / 60000));
      return res.status(403).json({
        success: false,
        message: `Аккаунт заблокирован. Осталось примерно ${left} мин.`
      });
    }

    const hash = hashPassword(password);
    if (String(user.password || "") !== hash) {
      return res.status(401).json({
        success: false,
        message: "Неверный логин или пароль."
      });
    }

    if (normalized === ADMIN_LOGINS[0]) {
      user.isAdmin = true;
      saveData();
    }

    return res.json({
      success: true,
      message: "Вход выполнен.",
      user: safeUser(id),
      party: getPartyForUser(id)
    });
  } catch (err) {
    console.error("Ошибка входа:", err);
    return res.status(500).json({
      success: false,
      message: "Не удалось выполнить вход."
    });
  }
});

app.get("/api/me", (req, res) => {
  const userId = String(req.query.userId || "");

  if (!userId || !users[userId]) {
    return res.status(401).json({
      success: false,
      message: "Сессия недействительна. Войдите снова."
    });
  }

  if (isBanned(userId)) {
    return res.status(403).json({
      success: false,
      message: "Аккаунт заблокирован."
    });
  }

  return res.json({
    success: true,
    user: safeUser(userId),
    party: getPartyForUser(userId)
  });
});

// Восстанавливаем таймеры активных матчей после перезапуска сервера.
setTimeout(() => {
  for (const match of pendingMatches) {
    if (match.status === "waiting_accept") {
      const left = Math.max(0, 20000 - (Date.now() - Number(match.createdAt || Date.now())));
      setTimeout(() => checkMatchTimeout(match.id), left);
    } else if (match.status === "draft") {
      scheduleDraft(match);
    }
  }
}, 0);

setInterval(saveData, 10000);

process.on("SIGINT", () => {
  saveData();
  process.exit(0);
});

process.on("SIGTERM", () => {
  saveData();
  process.exit(0);
});

/* =========================================================
   HELPERS
========================================================= */

function generateId(length = 8) {
  return crypto
    .randomBytes(length)
    .toString("hex");
}

function generateUserId() {
  let id;

  do {
    id = Math.floor(
      100000 + Math.random() * 900000
    ).toString();
  } while (users[id]);

  return id;
}

function generatePartyId() {
  return (
    "LP-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    generateId(3).toUpperCase()
  );
}

function generateMatchId() {
  const date = new Date()
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");

  return (
    "LP-" +
    date +
    "-" +
    generateId(4).toUpperCase()
  );
}

function safeUser(id) {
  const user = users[id];

  if (!user) return null;

  const stats = normalizeStats(user.stats);

  return {
    id,
    username: user.username,
    inGameNick: user.inGameNick,
    inGameId: user.inGameId,

    isAdmin: Boolean(user.isAdmin),

    clanId: user.clanId || null,

    avatar: stats.avatar || "",
    sticker: stats.sticker || "",

    stats
  };
}

function getPartyForUser(userId) {
  for (const [partyId, party] of Object.entries(parties)) {
    if (party.members.includes(userId)) {
      return buildParty(partyId);
    }
  }

  return null;
}

function buildParty(partyId) {
  const party = parties[partyId];

  if (!party) return null;

  return {
    id: partyId,
    code: party.code,
    leaderId: party.leaderId,
    members: party.members
      .map(safeUser)
      .filter(Boolean)
  };
}

function sendUser(userId, event, data) {
  const socketId = userSockets[userId];

  if (socketId) {
    io.to(socketId).emit(event, data);
  }
}

function sendMatchToParticipants(match, event, data) {
  for (const userId of match.participants) {
    sendUser(userId, event, data);
  }
}

function broadcastParty(partyId) {
  const party = buildParty(partyId);

  if (!party) return;

  for (const userId of parties[partyId].members) {
    sendUser(userId, "partyUpdate", party);
  }
}

function queueSize(mode, ranked) {
  const key =
    `${mode}_${ranked ? "ranked" : "unranked"}`;

  return queues[key].reduce((total, entry) => total + (Array.isArray(entry.userIds) ? entry.userIds.length : 0), 0);
}

function queueState() {
  const result = {
    "1v1": {
      unranked: queueSize("1v1", false),
      ranked: queueSize("1v1", true)
    },

    "2v2": {
      unranked: queueSize("2v2", false),
      ranked: queueSize("2v2", true)
    },

    "5v5": {
      unranked: queueSize("5v5", false),
      ranked: queueSize("5v5", true)
    }
  };

  return result;
}

function broadcastQueue() {
  io.emit("queueUpdate", queueState());
}

function isBanned(userId) {
  const user = users[userId];

  return Boolean(
    user?.ban &&
    user.ban.until > Date.now()
  );
}

function isMuted(userId) {
  const user = users[userId];

  return Boolean(
    user?.mute &&
    user.mute.until > Date.now()
  );
}

/* =========================================================
   RANKED RESTRICTION
========================================================= */

function rankedAllowed(userId, mode) {
  const stats = users[userId]?.stats;
  if (!stats) return false;
  if (mode === "1v1") return Number(stats.unrankedMatches1v1 || 0) >= 3;
  if (mode === "2v2") return Number(stats.unrankedMatches2v2 || 0) >= 3;
  if (mode === "5v5") return Number(stats.unrankedMatches5v5 || 0) >= 3;
  return false;
}

/* =========================================================
   MATCHMAKING
========================================================= */

function removeUserFromQueues(userId) {
  for (const key of Object.keys(queues)) {
    queues[key] = queues[key].filter(
      entry => !entry.userIds.includes(userId)
    );
  }
}

function findMatch(mode, ranked) {
  const key =
    `${mode}_${ranked ? "ranked" : "unranked"}`;

  const queue = queues[key];

  const needed = MODES[mode];

  if (!queue.length) return null;

  const groups = [...queue];

  if (!ranked) {
    let selected = [];
    let total = 0;

    for (const group of groups) {
      if (total + group.userIds.length > needed) {
        continue;
      }

      selected.push(group);
      total += group.userIds.length;

      if (total === needed) {
        break;
      }
    }

    if (total !== needed) {
      return null;
    }

    const selectedIds = new Set(
      selected.flatMap(g => g.userIds)
    );

    queues[key] = queue.filter(
      g => !selectedIds.has(g.userIds[0])
    );

    return selected.flatMap(
      g => g.userIds
    );
  }

  groups.sort((a, b) => {
    const aElo =
      users[a.userIds[0]]?.stats?.[mode]?.elo || 100;

    const bElo =
      users[b.userIds[0]]?.stats?.[mode]?.elo || 100;

    return aElo - bElo;
  });

  for (let start = 0; start < groups.length; start++) {
    let selected = [];
    let total = 0;

    for (
      let i = start;
      i < groups.length;
      i++
    ) {
      const group = groups[i];

      if (
        total + group.userIds.length >
        needed
      ) {
        continue;
      }

      selected.push(group);
      total += group.userIds.length;

      if (total === needed) break;
    }

    if (total !== needed) continue;

    const allIds =
      selected.flatMap(g => g.userIds);

    const elos = allIds.map(
      id =>
        Number(
          users[id]?.stats?.[mode]?.elo || 100
        )
    );

    const min = Math.min(...elos);
    const max = Math.max(...elos);

    if (max - min > 200) {
      continue;
    }

    const selectedFirstIds = new Set(
      selected.map(g => g.userIds[0])
    );

    queues[key] = queue.filter(
      g => !selectedFirstIds.has(g.userIds[0])
    );

    return allIds;
  }

  return null;
}

function createMatch(mode, ranked, participants) {
  const shuffled = [...participants];

  for (
    let i = shuffled.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(Math.random() * (i + 1));

    [
      shuffled[i],
      shuffled[j]
    ] = [
      shuffled[j],
      shuffled[i]
    ];
  }

  const half = shuffled.length / 2;
  const teamA = shuffled.slice(0, half);
  const teamB = shuffled.slice(half);
  const captains = [teamA[0], teamB[0]];
  const rounds = ROUND_OPTIONS[Math.floor(Math.random() * ROUND_OPTIONS.length)];
  const map = MAPS[Math.floor(Math.random() * MAPS.length)];
  const lobbyCreatorId = shuffled[Math.floor(Math.random() * shuffled.length)];

  const match = {
    id: generateMatchId(),
    mode,
    ranked,
    map,
    rounds,
    maxMoney: 16000,
    participants,
    teamA,
    teamB,
    captains,
    lobbyCreatorId,
    accepted: [],
    screenshots: [],
    status: "waiting_accept",
    createdAt: Date.now(),
    resolved: false
  };

  pendingMatches.push(match);

  saveData();

  const publicMatch = {
    id: match.id,
    matchId: match.id,
    mode: match.mode,
    ranked: match.ranked,
    map: match.map,
    rounds: match.rounds,
    maxMoney: match.maxMoney,
    timeout: Math.max(1, Math.ceil((20000 - (Date.now() - match.createdAt)) / 1000)),
    accepted: match.accepted.length,
    total: match.participants.length,
    participants: match.participants.map(
      safeUser
    )
  };

  sendMatchToParticipants(
    match,
    "matchFound",
    publicMatch
  );

  setTimeout(() => {
    checkMatchTimeout(match.id);
  }, 20000);

  return match;
}

function checkMatchTimeout(matchId) {
  const match =
    pendingMatches.find(
      m => m.id === matchId
    );

  if (!match) return;

  if (
    match.status !== "waiting_accept"
  ) {
    return;
  }

  match.status = "cancelled";

  sendMatchToParticipants(
    match,
    "matchCancelled",
    {
      matchId,
      reason:
        "Не все игроки приняли матч за 20 секунд."
    }
  );

  saveData();
}

/* =========================================================
   FINISH MATCH
========================================================= */

function buildMatchLobbyPayload(match) {
  return {
    matchId: match.id,
    mode: match.mode,
    ranked: match.ranked,
    map: match.map,
    rounds: match.rounds,
    maxMoney: match.maxMoney,
    captains: (match.captains || []).map(safeUser),
    lobbyCreator: safeUser(match.lobbyCreatorId),
    teamA: match.teamA.map(safeUser),
    teamB: match.teamB.map(safeUser),
    screenshots: match.screenshots || []
  };
}

function finalizeDraft(match) {
  if (!match || match.status !== "draft") return;
  match.status = "awaiting_result";
  sendMatchToParticipants(match, "matchLobby", buildMatchLobbyPayload(match));
  saveData();
}

function scheduleDraft(match) {
  const elapsed = Date.now() - Number(match.draftStartedAt || Date.now());
  const left = Math.max(0, Number(match.draftDuration || 6000) - elapsed);
  if (left <= 0) return finalizeDraft(match);
  setTimeout(() => finalizeDraft(match), left);
}

function finishMatchForPlayers(match) {
  match.status = "draft";
  match.draftStartedAt = Date.now();
  match.draftDuration = 6000;

  sendMatchToParticipants(match, "matchDraft", {
    ...buildMatchLobbyPayload(match),
    draftSeconds: 6,
    message: "Драфт завершён: команды, капитаны, карта и параметры лобби определены сервером."
  });

  saveData();
  scheduleDraft(match);
}

function eloChange(winnerElo, loserElo) {
  const K = 25;

  const expected =
    1 /
    (
      1 +
      Math.pow(
        10,
        (loserElo - winnerElo) / 400
      )
    );

  return Math.max(
    10,
    Math.round(K * (1 - expected))
  );
}

function resolveMatch(match, winningTeam, eloChanges = {}) {
  if (match.resolved) return { success: false, message: "Матч уже обработан." };
  if (!match.screenshots || match.screenshots.length === 0) {
    return { success: false, message: "Сначала нужен хотя бы один скриншот результата." };
  }
  if (winningTeam !== "A" && winningTeam !== "B") {
    return { success: false, message: "Выберите победившую команду." };
  }

  const winners = winningTeam === "A" ? match.teamA : match.teamB;
  const losers = winningTeam === "A" ? match.teamB : match.teamA;

  for (const userId of match.participants) {
    const user = users[userId];
    if (!user) continue;
    const stats = user.stats[match.mode];
    const won = winners.includes(userId);
    stats.matches++;
    if (won) {
      stats.wins++;
      stats.streak++;
      stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
      user.stats.totalWins++;
    } else {
      stats.losses++;
      stats.streak = 0;
      user.stats.totalLosses++;
    }

    const rawDelta = eloChanges && Object.prototype.hasOwnProperty.call(eloChanges, userId)
      ? Number(eloChanges[userId]) : 0;
    const delta = Number.isFinite(rawDelta) ? Math.trunc(rawDelta) : 0;
    stats.elo = Math.max(100, Number(stats.elo || 100) + delta);
    stats.level = getLevel(stats.elo);

    if (!match.ranked) {
      // Counters live on stats root; keep them there.
      if (match.mode === "1v1") user.stats.unrankedMatches1v1 = Number(user.stats.unrankedMatches1v1 || 0) + 1;
      if (match.mode === "2v2") user.stats.unrankedMatches2v2 = Number(user.stats.unrankedMatches2v2 || 0) + 1;
      if (match.mode === "5v5") user.stats.unrankedMatches5v5 = Number(user.stats.unrankedMatches5v5 || 0) + 1;
      if (won) {
        if (match.mode === "1v1") user.stats.unrankedWins1v1++;
        if (match.mode === "2v2") user.stats.unrankedWins2v2++;
        if (match.mode === "5v5") user.stats.unrankedWins5v5++;
      }
    }

    user.stats.matchHistory ||= [];
    user.stats.matchHistory.unshift({
      matchId: match.id,
      mode: match.mode,
      ranked: match.ranked,
      map: match.map,
      rounds: match.rounds,
      winner: won,
      winnerTeam: winningTeam,
      eloDelta: delta,
      eloAfter: stats.elo,
      timestamp: Date.now()
    });
    user.stats.matchHistory = user.stats.matchHistory.slice(0, 100);
  }

  match.resolved = true;
  match.status = "resolved";
  match.winnerTeam = winningTeam;
  match.eloChanges = Object.fromEntries(match.participants.map(id => [id, Number(eloChanges[id] || 0)]));
  match.resolvedAt = Date.now();

  matchHistory.push({
    matchId: match.id,
    mode: match.mode,
    ranked: match.ranked,
    map: match.map,
    rounds: match.rounds,
    winnerTeam: winningTeam,
    eloChanges: match.eloChanges,
    timestamp: Date.now()
  });
  saveData();
  sendMatchToParticipants(match, "matchResolved", { matchId: match.id, winnerTeam: winningTeam, eloChanges: match.eloChanges });
  return { success: true };
}

app.post(
  "/api/upload-avatar",
  upload.single("avatar"),
  (req, res) => {
    const userId = req.body.userId;
    if (!users[userId]) return res.status(404).json({ success:false, message:"Пользователь не найден." });
    if (!req.file) return res.status(400).json({ success:false, message:"Файл не выбран." });
    users[userId].stats.avatar = `/uploads/${req.file.filename}`;
    saveData();
    sendUser(userId, "userUpdated", safeUser(userId));
    res.json({ success:true, avatar:users[userId].stats.avatar });
  }
);

/* =========================================================
   ADMIN STICKER
========================================================= */

app.post(
  "/api/admin/sticker",
  (req, res) => {
    const {
      adminId,
      sticker
    } = req.body;

    if (!users[adminId]?.isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Нет доступа."
      });
    }

    users[adminId].stats.sticker =
      String(sticker || "").slice(0, 20);

    saveData();

    res.json({
      success: true,
      user: safeUser(adminId)
    });
  }
);

/* =========================================================
   NICK
========================================================= */

app.post("/api/change-nick", (req, res) => {
  const {
    userId,
    newNick
  } = req.body;

  if (!users[userId]) {
    return res.status(404).json({
      success: false,
      message: "Пользователь не найден."
    });
  }

  const nick =
    String(newNick || "").trim();

  if (!nick) {
    return res.status(400).json({
      success: false,
      message: "Введите ник."
    });
  }

  if (nick.length > 24) {
    return res.status(400).json({
      success: false,
      message: "Максимум 24 символа."
    });
  }

  users[userId].inGameNick = nick;

  saveData();

  res.json({
    success: true,
    user: safeUser(userId)
  });
});

/* =========================================================
   PARTY
========================================================= */

app.post("/api/create-party", (req, res) => {
  const {
    userId
  } = req.body;

  if (!users[userId]) {
    return res.status(404).json({
      success: false,
      message: "Пользователь не найден."
    });
  }

  const existing =
    getPartyForUser(userId);

  if (existing) {
    return res.json({
      success: false,
      party: existing,
      message: "Вы уже в пати."
    });
  }

  const id = generatePartyId();

  parties[id] = {
    code: id,
    leaderId: userId,
    members: [userId],
    createdAt: Date.now()
  };

  saveData();

  const party = buildParty(id);

  sendUser(
    userId,
    "partyUpdate",
    party
  );

  res.json({
    success: true,
    party
  });
});

app.post("/api/join-party", (req, res) => {
  const {
    userId,
    partyId
  } = req.body;

  const party = parties[partyId];

  if (!party) {
    return res.status(404).json({
      success: false,
      message: "Пати не найдена."
    });
  }

  if (party.members.includes(userId)) {
    return res.json({
      success: false,
      message: "Вы уже в пати."
    });
  }

  if (party.members.length >= 5) {
    return res.status(400).json({
      success: false,
      message: "Пати заполнена."
    });
  }

  party.members.push(userId);

  saveData();

  broadcastParty(partyId);

  res.json({
    success: true,
    party: buildParty(partyId)
  });
});

app.post("/api/leave-party", (req, res) => {
  const {
    userId,
    partyId
  } = req.body;

  const party = parties[partyId];

  if (!party) {
    return res.status(404).json({
      success: false
    });
  }

  party.members =
    party.members.filter(
      id => id !== userId
    );

  if (!party.members.length) {
    delete parties[partyId];
  } else {
    if (party.leaderId === userId) {
      party.leaderId =
        party.members[0];
    }

    broadcastParty(partyId);
  }

  saveData();

  res.json({
    success: true
  });
});

/* =========================================================
   FRIENDS
========================================================= */

app.get("/api/search-users", (req, res) => {
  const q =
    String(req.query.q || "")
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
      .filter(([id, user]) => {
        return (
          id.toLowerCase().includes(q) ||
          String(user.inGameNick)
            .toLowerCase()
            .includes(q) ||
          String(user.inGameId)
            .toLowerCase()
            .includes(q)
        );
      })
      .slice(0, 30)
      .map(([id]) => safeUser(id));

  res.json({
    success: true,
    users: result
  });
});

app.post("/api/friend-request", (req, res) => {
  const {
    fromUserId,
    toUserId
  } = req.body;

  const from = users[fromUserId];
  const to = users[toUserId];

  if (!from || !to) {
    return res.status(404).json({
      success: false,
      message: "Игрок не найден."
    });
  }

  if (fromUserId === toUserId) {
    return res.status(400).json({
      success: false,
      message: "Нельзя добавить себя."
    });
  }

  if (
    from.friends.includes(toUserId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Вы уже друзья."
    });
  }

  if (
    to.pendingRequests.includes(fromUserId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Заявка уже отправлена."
    });
  }

  to.pendingRequests.push(fromUserId);

  saveData();

  sendUser(
    toUserId,
    "friendRequest",
    {
      user: safeUser(fromUserId)
    }
  );

  res.json({
    success: true
  });
});

app.post("/api/friend-accept", (req, res) => {
  const {
    userId,
    friendId
  } = req.body;

  if (
    !users[userId] ||
    !users[friendId]
  ) {
    return res.status(404).json({
      success: false
    });
  }

  users[userId].pendingRequests =
    users[userId].pendingRequests.filter(
      id => id !== friendId
    );

  if (
    !users[userId].friends.includes(
      friendId
    )
  ) {
    users[userId].friends.push(friendId);
  }

  if (
    !users[friendId].friends.includes(
      userId
    )
  ) {
    users[friendId].friends.push(userId);
  }

  saveData();

  sendUser(
    friendId,
    "friendChanged",
    {}
  );

  res.json({
    success: true
  });
});

app.post("/api/friend-reject", (req, res) => {
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

  res.json({
    success: true
  });
});

app.get("/api/friends", (req, res) => {
  const userId = req.query.userId;
  const user = users[userId];

  if (!user) {
    return res.status(404).json({
      success: false
    });
  }

  res.json({
    success: true,

    friends:
      user.friends
        .map(safeUser)
        .filter(Boolean),

    requests:
      user.pendingRequests
        .map(safeUser)
        .filter(Boolean)
  });
});

/* =========================================================
   REPORTS
========================================================= */

app.post("/api/report", (req, res) => {
  const {
    reporterId,
    targetId,
    reason
  } = req.body;

  if (
    !users[reporterId] ||
    !users[targetId]
  ) {
    return res.status(404).json({
      success: false,
      message: "Игрок не найден."
    });
  }

  if (reporterId === targetId) {
    return res.status(400).json({
      success: false,
      message: "Нельзя пожаловаться на себя."
    });
  }

  const report = {
    id:
      "REP-" +
      Date.now().toString(36).toUpperCase() +
      "-" +
      generateId(2).toUpperCase(),

    reporterId,
    targetId,

    reason:
      String(reason || "Без причины")
        .slice(0, 500),

    status: "open",

    createdAt: Date.now()
  };

  reports.unshift(report);

  saveData();

  res.json({
    success: true,
    reportId: report.id
  });
});

/* =========================================================
   CLANS
========================================================= */

app.get("/api/clan", (req, res) => {
  const userId = req.query.userId;

  const user = users[userId];

  if (!user) {
    return res.status(404).json({
      success: false
    });
  }

  if (!user.clanId) {
    return res.json({
      success: true,
      clan: null
    });
  }

  const clan = clans[user.clanId];

  if (!clan) {
    user.clanId = null;

    return res.json({
      success: true,
      clan: null
    });
  }

  res.json({
    success: true,

    clan: {
      ...clan,

      members:
        clan.members
          .map(safeUser)
          .filter(Boolean)
    }
  });
});

app.post("/api/clan/create", (req, res) => {
  const {
    userId,
    name,
    tag
  } = req.body;

  const user = users[userId];

  if (!user) {
    return res.status(404).json({
      success: false
    });
  }

  if (user.clanId) {
    return res.status(400).json({
      success: false,
      message: "Вы уже в клане."
    });
  }

  if (!name || !tag) {
    return res.status(400).json({
      success: false,
      message: "Введите название и тег."
    });
  }

  const id =
    "CLAN-" +
    generateId(4).toUpperCase();

  clans[id] = {
    id,
    name: String(name).slice(0, 32),
    tag: String(tag).slice(0, 5),
    ownerId: userId,
    members: [userId],
    createdAt: Date.now()
  };

  user.clanId = id;

  saveData();

  res.json({
    success: true,
    clan: clans[id]
  });
});

/* =========================================================
   CHAT
========================================================= */

function broadcastChat(msg) {
  io.emit("chatMessage", msg);
}

io.on("connection", socket => {
  socket.on("auth", userId => {
    if (!users[userId]) return;

    if (isBanned(userId)) {
      socket.emit("banned");
      return;
    }

    socketUsers[socket.id] = userId;
    userSockets[userId] = socket.id;

    socket.emit(
      "queueUpdate",
      queueState()
    );

    socket.emit(
      "chatHistory",
      chatMessages.slice(-100)
    );

    socket.emit(
      "partyUpdate",
      getPartyForUser(userId)
    );

    const active =
      pendingMatches.filter(
        match =>
          match.participants.includes(userId) &&
          !match.resolved &&
          match.status !== "cancelled"
      );

    for (const match of active) {
      if (
        match.status === "waiting_accept"
      ) {
        socket.emit(
          "matchFound",
          {
            matchId: match.id,
            id: match.id,
            mode: match.mode,
            ranked: match.ranked,
            map: match.map,
            rounds: match.rounds,
            maxMoney: match.maxMoney,
            accepted: match.accepted.length,
            total: match.participants.length,
            timeout: Math.max(
              0,
              20 -
                Math.floor(
                  (Date.now() - match.createdAt) /
                    1000
                )
            ),
            participants:
              match.participants.map(
                safeUser
              )
          }
        );
      }

      if (match.status === "draft") {
        socket.emit("matchDraft", {
          ...buildMatchLobbyPayload(match),
          draftSeconds: Math.max(1, Math.ceil((Number(match.draftDuration || 6000) - (Date.now() - Number(match.draftStartedAt || Date.now()))) / 1000))
        });
        scheduleDraft(match);
      }

      if (
        match.status ===
        "awaiting_result"
      ) {
        socket.emit(
          "matchLobby",
          {
            matchId: match.id,
            mode: match.mode,
            ranked: match.ranked,
            map: match.map,
            rounds: match.rounds,
            maxMoney: match.maxMoney,
            captains: match.captains.map(safeUser),
            lobbyCreator: safeUser(match.lobbyCreatorId),
            teamA:
              match.teamA.map(safeUser),
            teamB:
              match.teamB.map(safeUser),
            screenshots:
              match.screenshots
          }
        );
      }
    }
  });

  /* =====================================================
     QUEUE
  ===================================================== */

  socket.on(
    "joinQueue",
    ({
      mode,
      ranked,
      partyId
    }) => {
      const userId =
        socketUsers[socket.id];

      if (!userId) return;

      if (!MODES[mode]) return;

      if (
        ranked &&
        !rankedAllowed(userId, mode)
      ) {
        socket.emit(
          "queueError",
          {
            message:
              `Для рангового ${mode} нужны 3 победы в обычном режиме ${mode}.`
          }
        );

        return;
      }

      let userIds = [userId];

      if (
        partyId &&
        parties[partyId] &&
        parties[partyId].members.includes(userId)
      ) {
        userIds = parties[partyId].members.slice();
      }

      if (ranked) {
        const blocked = userIds.find(id => !rankedAllowed(id, mode));
        if (blocked) {
          socket.emit("queueError", { message: "Все участники пати должны сыграть минимум 3 обычных матча в этом режиме." });
          return;
        }
      }

      const needed = MODES[mode];

      if (userIds.length > needed) {
        socket.emit(
          "queueError",
          {
            message:
              "Пати слишком большая для этого режима."
          }
        );

        return;
      }

      const key =
        `${mode}_${ranked ? "ranked" : "unranked"}`;

      const already =
        queues[key].some(
          entry =>
            entry.userIds.some(
              id => userIds.includes(id)
            )
        );

      if (!already) {
        queues[key].push({
          userIds,
          createdAt: Date.now()
        });
      }

      broadcastQueue();

      const participants =
        findMatch(mode, ranked);

      if (
        participants &&
        participants.length === needed
      ) {
        createMatch(
          mode,
          ranked,
          participants
        );

        broadcastQueue();
      }
    }
  );

  socket.on(
    "leaveQueue",
    ({
      mode,
      ranked
    }) => {
      const userId =
        socketUsers[socket.id];

      if (!userId) return;

      const key =
        `${mode}_${ranked ? "ranked" : "unranked"}`;

      queues[key] =
        queues[key].filter(
          entry =>
            !entry.userIds.includes(
              userId
            )
        );

      broadcastQueue();
    }
  );

  /* =====================================================
     MATCH ACCEPT
  ===================================================== */

  socket.on(
    "acceptMatch",
    ({ matchId }) => {
      const userId =
        socketUsers[socket.id];

      const match =
        pendingMatches.find(
          m => m.id === matchId
        );

      if (
        !match ||
        match.status !==
          "waiting_accept"
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
        match.accepted.push(userId);
      }

      sendMatchToParticipants(
        match,
        "matchAcceptedUpdate",
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
        finishMatchForPlayers(
          match
        );
      }
    }
  );

  socket.on(
    "declineMatch",
    ({ matchId }) => {
      const userId =
        socketUsers[socket.id];

      const match =
        pendingMatches.find(
          m => m.id === matchId
        );

      if (!match) return;

      if (
        !match.participants.includes(
          userId
        )
      ) {
        return;
      }

      match.status = "cancelled";

      sendMatchToParticipants(
        match,
        "matchCancelled",
        {
          matchId,
          reason:
            "Игрок отклонил матч."
        }
      );

      saveData();
    }
  );

  /* =====================================================
     CHAT
  ===================================================== */

  socket.on(
    "chatMessage",
    text => {
      const userId =
        socketUsers[socket.id];

      if (!userId) return;

      if (isMuted(userId)) {
        socket.emit(
          "chatError",
          {
            message:
              "Вы не можете писать в чат."
          }
        );

        return;
      }

      let message = text;

      if (
        typeof message === "object" &&
        message !== null
      ) {
        message =
          message.text ||
          message.message ||
          "";
      }

      message =
        String(message || "")
          .trim()
          .slice(0, 500);

      if (!message) return;

      const user =
        safeUser(userId);

      const msg = {
        id: generateId(5),
        userId,

        nickname:
          user.inGameNick,

        avatar:
          user.avatar,

        isAdmin:
          user.isAdmin,

        sticker:
          user.sticker,

        text: message,

        timestamp: Date.now()
      };

      chatMessages.push(msg);

      if (
        chatMessages.length > 300
      ) {
        chatMessages.shift();
      }

      saveData();

      broadcastChat(msg);
    }
  );

  /* =====================================================
     DISCONNECT
  ===================================================== */

  socket.on("disconnect", () => {
    const userId =
      socketUsers[socket.id];

    if (
      userId &&
      userSockets[userId] ===
        socket.id
    ) {
      delete userSockets[userId];
    }

    delete socketUsers[socket.id];

    /*
      ВАЖНО:
      ПАТИ НЕ УДАЛЯЕМ.
      Пользователь просто вышел с сайта.
    */

    broadcastQueue();
  });
});

/* =========================================================
   SCREENSHOT
========================================================= */

app.post(
  "/api/match/:matchId/screenshot",
  upload.single("screenshot"),
  (req, res) => {
    const match =
      pendingMatches.find(
        m =>
          m.id ===
          req.params.matchId
      );

    const userId =
      req.body.userId;

    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Матч не найден."
      });
    }

    if (
      !match.participants.includes(
        userId
      )
    ) {
      return res.status(403).json({
        success: false
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message:
          "Скриншот не выбран."
      });
    }

    const screenshot = {
      id: generateId(5),

      userId,

      nickname:
        users[userId]?.inGameNick ||
        "Игрок",

      url:
        `/uploads/${req.file.filename}`,

      timestamp: Date.now()
    };

    match.screenshots.push(
      screenshot
    );

    saveData();

    sendMatchToParticipants(
      match,
      "screenshotAdded",
      {
        matchId: match.id,
        screenshot
      }
    );

    res.json({
      success: true,
      screenshot
    });
  }
);

/* =========================================================
   ADMIN
========================================================= */

function requireAdmin(req, res) {
  const adminId =
    req.body.adminId ||
    req.query.adminId;

  if (
    !adminId ||
    !users[adminId]?.isAdmin
  ) {
    res.status(403).json({
      success: false,
      message:
        "Недостаточно прав."
    });

    return null;
  }

  return adminId;
}

app.get("/api/check-admin", (req, res) => {
  const userId = req.query.userId;
  res.json({ isAdmin: Boolean(userId && users[userId]?.isAdmin) });
});

app.post("/api/admin-action", (req, res) => {
  req.body = { ...req.body };
  const { adminId, targetUserId, action, durationHours, reason } = req.body;
  if (!users[adminId]?.isAdmin) return res.status(403).json({ success:false, message:"Недостаточно прав." });
  if (!users[targetUserId]) return res.status(404).json({ success:false, message:"Игрок не найден." });
  if (users[targetUserId].isAdmin) return res.status(400).json({ success:false, message:"Нельзя применить это действие к администратору." });
  const hours = Math.max(1, Number(durationHours || 1));
  if (action === "ban") users[targetUserId].ban = { until:Date.now()+hours*3600000, reason:String(reason||"").slice(0,300) };
  else if (action === "unban") delete users[targetUserId].ban;
  else if (action === "mute") users[targetUserId].mute = { until:Date.now()+hours*3600000, reason:String(reason||"").slice(0,300) };
  else if (action === "unmute") delete users[targetUserId].mute;
  else return res.status(400).json({ success:false, message:"Неизвестное действие." });
  saveData();
  res.json({ success:true, message:"Действие выполнено." });
});

app.get(
  "/api/admin/stats",
  (req, res) => {
    const adminId =
      requireAdmin(req, res);

    if (!adminId) return;

    res.json({
      success: true,

      online:
        Object.keys(userSockets)
          .length,

      users:
        Object.keys(users).length,

      matches:
        pendingMatches.length,

      reports:
        reports.filter(
          r => r.status === "open"
        ).length,

      queues:
        queueState()
    });
  }
);

app.get(
  "/api/admin/users",
  (req, res) => {
    const adminId =
      requireAdmin(req, res);

    if (!adminId) return;

    res.json({
      success: true,

      users:
        Object.entries(users).map(
          ([id]) =>
            safeUser(id)
        )
    });
  }
);

app.get(
  "/api/admin/matches",
  (req, res) => {
    const adminId =
      requireAdmin(req, res);

    if (!adminId) return;

    res.json({
      success: true,

      matches:
        pendingMatches
          .filter(
            m =>
              m.status !==
                "cancelled"
          )
          .map(match => ({
            ...match,

            participants:
              match.participants.map(
                safeUser
              ),

            teamA:
              match.teamA.map(
                safeUser
              ),

            teamB:
              match.teamB.map(
                safeUser
              )
          }))
    });
  }
);

app.get(
  "/api/admin/reports",
  (req, res) => {
    const adminId =
      requireAdmin(req, res);

    if (!adminId) return;

    res.json({
      success: true,

      reports:
        reports.map(report => ({
          ...report,

          reporter:
            safeUser(
              report.reporterId
            ),

          target:
            safeUser(
              report.targetId
            )
        }))
    });
  }
);

app.post(
  "/api/admin/report/:id",
  (req, res) => {
    const adminId =
      requireAdmin(req, res);

    if (!adminId) return;

    const report =
      reports.find(
        r => r.id === req.params.id
      );

    if (!report) {
      return res.status(404).json({
        success: false
      });
    }

    report.status =
      req.body.status === "closed"
        ? "closed"
        : "open";

    report.adminId = adminId;

    report.adminComment =
      String(
        req.body.comment || ""
      ).slice(0, 500);

    saveData();

    res.json({
      success: true
    });
  }
);

app.post(
  "/api/admin/match/:id/resolve",
  (req, res) => {
    const adminId =
      requireAdmin(req, res);

    if (!adminId) return;

    const match =
      pendingMatches.find(
        m =>
          m.id ===
          req.params.id
      );

    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Матч не найден."
      });
    }

    if (match.resolved) {
      return res.status(400).json({
        success: false,
        message:
          "Матч уже обработан."
      });
    }

    const result =
      resolveMatch(
        match,
        req.body.winnerTeam
      );

    if (!result.success) {
      return res.status(400).json(
        result
      );
    }

    res.json({
      success: true
    });
  }
);

app.post(
  "/api/admin/action",
  (req, res) => {
    const adminId =
      requireAdmin(req, res);

    if (!adminId) return;

    const {
      targetUserId,
      action,
      hours
    } = req.body;

    if (!users[targetUserId]) {
      return res.status(404).json({
        success: false
      });
    }

    if (
      users[targetUserId].isAdmin
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Нельзя применить это действие к администратору."
      });
    }

    if (action === "ban") {
      users[targetUserId].ban = {
        until:
          Date.now() +
          Number(hours || 1) *
            60 *
            60 *
            1000
      };
    }

    if (action === "unban") {
      delete users[targetUserId].ban;
    }

    if (action === "mute") {
      users[targetUserId].mute = {
        until:
          Date.now() +
          Number(hours || 1) *
            60 *
            60 *
            1000
      };
    }

    if (action === "unmute") {
      delete users[targetUserId].mute;
    }

    saveData();

    res.json({
      success: true
    });
  }
);

/* =========================================================
   TOP
========================================================= */

app.get("/api/top", (req, res) => {
  const mode =
    ["1v1", "2v2", "5v5"].includes(
      req.query.mode
    )
      ? req.query.mode
      : "1v1";

  const list =
    Object.entries(users)
      .map(([id]) => {
        const user =
          safeUser(id);

        return {
          ...user,

          elo:
            user.stats[mode].elo,

          level:
            getLevel(
              user.stats[mode].elo
            ),

          wins:
            user.stats[mode].wins
        };
      })
      .sort(
        (a, b) =>
          b.elo - a.elo
      )
      .slice(0, 100);

  res.json({
    success: true,
    users: list
  });
});

/* =========================================================
   SERVER
========================================================= */

const PORT =
  process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `Legend Pl запущен: http://localhost:${PORT}`
  );
});