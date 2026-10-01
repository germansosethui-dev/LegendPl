"use strict";

/*
=========================================================
StandKnife | Legend Pl
Frontend client

Основные функции:

- авторизация
- регистрация
- профиль
- друзья
- поиск игроков
- чат
- пати
- очередь
- матчмейкинг
- подтверждение матча 20 секунд
- профиль другого игрока
- админ-панель
- сохранение состояния после F5
=========================================================
*/


/* =====================================================
   SOCKET
===================================================== */

const socket = io({
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000
});


/* =====================================================
   STATE
===================================================== */

let currentUser = null;
let currentParty = null;
let currentMatch = null;

let matchTimerInterval = null;
let activeView = "play";

let isSocketReady = false;

let queueState = {
  "1v1": {
    unranked: 0,
    ranked: 0
  },
  "2v2": {
    unranked: 0,
    ranked: 0
  },
  "5v5": {
    unranked: 0,
    ranked: 0
  }
};

let currentQueue = null;

let chatMessages = [];
let friends = [];
let friendRequests = [];

let reconnectRestoreTimer = null;


/* =====================================================
   DOM HELPERS
===================================================== */

const $ = id => document.getElementById(id);

function q(selector) {
  return document.querySelector(selector);
}

function qa(selector) {
  return [...document.querySelectorAll(selector)];
}


/* =====================================================
   SAFE HELPERS
===================================================== */

function escapeHTML(value) {

  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function getObjectValue(obj, keys, fallback = "") {

  if (!obj || typeof obj !== "object") {
    return fallback;
  }

  for (const key of keys) {

    if (
      obj[key] !== undefined &&
      obj[key] !== null &&
      obj[key] !== ""
    ) {
      return obj[key];
    }

  }

  return fallback;
}


function normalizeUser(user) {

  if (!user) {
    return null;
  }

  /*
   ВАЖНО:
   Не превращаем объект пользователя в [object Object].
  */

  return {
    id: getObjectValue(
      user,
      ["id", "_id", "userId", "siteId"],
      ""
    ),

    username: getObjectValue(
      user,
      ["username", "login", "name", "nickname"],
      "Игрок"
    ),

    nickname: getObjectValue(
      user,
      [
        "inGameNick",
        "gameNick",
        "nickname",
        "nick",
        "username"
      ],
      "Игрок"
    ),

    gameId: getObjectValue(
      user,
      [
        "inGameId",
        "gameId",
        "gameID",
        "playerId"
      ],
      "—"
    ),

    avatar: getObjectValue(
      user,
      [
        "avatar",
        "avatarUrl",
        "photo",
        "image"
      ],
      "https://via.placeholder.com/80"
    ),

    rating: Number(
      getObjectValue(
        user,
        ["rating", "elo", "mmr"],
        0
      )
    ) || 0,

    wins: Number(
      getObjectValue(
        user,
        ["wins", "winCount"],
        0
      )
    ) || 0,

    losses: Number(
      getObjectValue(
        user,
        ["losses", "lossCount"],
        0
      )
    ) || 0,

    streak: Number(
      getObjectValue(
        user,
        ["streak", "winStreak"],
        0
      )
    ) || 0,

    isAdmin:
      user.isAdmin === true ||
      user.admin === true ||
      user.role === "admin" ||
      user.role === "administrator",

    online:
      user.online === true ||
      user.isOnline === true
  };
}


function normalizeUsers(value) {

  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(normalizeUser).filter(Boolean);
  }

  if (Array.isArray(value.users)) {
    return value.users.map(normalizeUser).filter(Boolean);
  }

  if (Array.isArray(value.players)) {
    return value.players.map(normalizeUser).filter(Boolean);
  }

  if (Array.isArray(value.members)) {
    return value.members.map(normalizeUser).filter(Boolean);
  }

  if (value.user) {
    const user = normalizeUser(value.user);
    return user ? [user] : [];
  }

  if (value.player) {
    const user = normalizeUser(value.player);
    return user ? [user] : [];
  }

  return [];
}


function userDisplayName(user) {

  const u = normalizeUser(user);

  if (!u) {
    return "Игрок";
  }

  return u.nickname || u.username || "Игрок";
}


function userAvatar(user) {

  const u = normalizeUser(user);

  if (!u || !u.avatar) {
    return "https://via.placeholder.com/80";
  }

  return u.avatar;
}


function isCurrentUser(user) {

  const u = normalizeUser(user);

  if (!u || !currentUser) {
    return false;
  }

  return String(u.id) === String(currentUser.id);
}


function showMessage(text, type = "info") {

  const el = $("authMessage");

  if (!el) {
    return;
  }

  el.textContent = String(text || "");

  el.className = "info";

  if (type === "success") {
    el.classList.add("success-text");
  }

  if (type === "error") {
    el.classList.add("error-text");
  }
}


function notify(text, type = "info") {

  console.log(`[${type}]`, text);

  /*
   Не используем alert постоянно,
   чтобы интерфейс не блокировался.
  */

  let notification = document.getElementById(
    "appNotification"
  );

  if (!notification) {

    notification = document.createElement("div");

    notification.id = "appNotification";

    notification.style.position = "fixed";
    notification.style.right = "15px";
    notification.style.bottom = "15px";
    notification.style.zIndex = "99999";
    notification.style.maxWidth = "350px";
    notification.style.padding = "12px 15px";
    notification.style.borderRadius = "10px";
    notification.style.background = "#1e293b";
    notification.style.border = "1px solid #334155";
    notification.style.boxShadow =
      "0 10px 30px rgba(0,0,0,.45)";
    notification.style.color = "#fff";

    document.body.appendChild(notification);
  }

  notification.textContent = String(text);

  if (type === "error") {
    notification.style.borderColor = "#ef4444";
  } else if (type === "success") {
    notification.style.borderColor = "#22c55e";
  } else {
    notification.style.borderColor = "#3b82f6";
  }

  clearTimeout(notification._timer);

  notification._timer = setTimeout(() => {

    if (notification) {
      notification.remove();
    }

  }, 3000);
}


/* =====================================================
   LOCAL STORAGE
===================================================== */

function saveSession() {

  if (!currentUser) {
    return;
  }

  try {

    localStorage.setItem(
      "standknife_user",
      JSON.stringify(currentUser)
    );

  } catch (error) {

    console.error(
      "Ошибка сохранения session:",
      error
    );

  }
}


function loadSession() {

  try {

    const raw =
      localStorage.getItem("standknife_user");

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    return normalizeUser(parsed);

  } catch (error) {

    console.error(
      "Ошибка чтения session:",
      error
    );

    return null;
  }
}


function clearSession() {

  try {
    localStorage.removeItem("standknife_user");
    localStorage.removeItem("standknife_party");
  } catch (error) {
    console.error(error);
  }

}


function savePartyLocal() {

  if (!currentParty) {
    return;
  }

  try {

    localStorage.setItem(
      "standknife_party",
      JSON.stringify(currentParty)
    );

  } catch (error) {
    console.error(error);
  }
}


function loadPartyLocal() {

  try {

    const raw =
      localStorage.getItem("standknife_party");

    if (!raw) {
      return null;
    }

    return JSON.parse(raw);

  } catch (error) {

    console.error(error);

    return null;
  }
}


function clearPartyLocal() {

  try {
    localStorage.removeItem("standknife_party");
  } catch (error) {
    console.error(error);
  }

}


/* =====================================================
   LOGIN / REGISTER
===================================================== */

function showLoginForm() {

  $("loginForm").style.display = "block";
  $("registerForm").style.display = "none";

  showMessage("");
}


function showRegisterForm() {

  $("loginForm").style.display = "none";
  $("registerForm").style.display = "block";

  showMessage("");
}


async function doLogin() {
  const username = $("loginUsername")?.value.trim();
  const password = $("loginPassword")?.value || "";

  if (!username || !password) {
    showMessage("Введите логин и пароль", "error");
    return;
  }

  const button = $("doLoginBtn");

  if (button) {
    button.disabled = true;
    button.textContent = "Вход...";
  }

  showMessage("Выполняется вход...");

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username,
        password
      })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      showMessage(
        data.message || "Неверный логин или пароль",
        "error"
      );

      return;
    }

    /*
     * Сервер возвращает пользователя именно в userData.
     */
    const user = normalizeUser(data.userData);

    if (!user || !user.id) {
      showMessage(
        "Сервер не вернул данные пользователя",
        "error"
      );

      return;
    }

    currentUser = user;

    saveSession();

    /*
     * Очень важно:
     * REST отвечает за вход,
     * Socket отвечает за онлайн-состояние,
     * очередь, пати, чат и матчмейкинг.
     */
    if (socket.connected) {
      socket.emit("auth", currentUser.id);
    } else {
      socket.once("connect", () => {
        if (currentUser?.id) {
          socket.emit("auth", currentUser.id);
        }
      });
    }

    enterMainScreen();

  } catch (error) {
    console.error("Ошибка входа:", error);

    showMessage(
      "Ошибка соединения с сервером",
      "error"
    );

  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Войти";
    }
  }
}


async function doRegister() {
  const username = $("regUsername")?.value.trim();
  const password = $("regPassword")?.value || "";
  const confirm = $("regPasswordConfirm")?.value || "";
  const inGameNick = $("regInGameNick")?.value.trim();
  const inGameId = $("regInGameId")?.value.trim();

  if (
    !username ||
    !password ||
    !confirm ||
    !inGameNick ||
    !inGameId
  ) {
    showMessage("Заполните все поля", "error");
    return;
  }

  if (password !== confirm) {
    showMessage("Пароли не совпадают", "error");
    return;
  }

  const button = $("doRegisterBtn");

  if (button) {
    button.disabled = true;
    button.textContent = "Регистрация...";
  }

  try {
    const response = await fetch("/api/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username,
        password,
        inGameNick,
        inGameId
      })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      showMessage(
        data.message || "Ошибка регистрации",
        "error"
      );
      return;
    }

    showMessage(
      data.message || "Регистрация успешна. Теперь войдите.",
      "success"
    );

    $("regPassword").value = "";
    $("regPasswordConfirm").value = "";

    setTimeout(() => {
      showLoginForm();

      $("loginUsername").value = username;
      $("loginPassword").focus();
    }, 700);

  } catch (error) {
    console.error("Ошибка регистрации:", error);

    showMessage(
      "Ошибка соединения с сервером",
      "error"
    );

  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Зарегистрироваться";
    }
  }
}


function logout() {

  socket.emit("logout");

  currentUser = null;
  currentParty = null;
  currentMatch = null;

  currentQueue = null;

  clearSession();
  clearPartyLocal();

  stopMatchTimer();

  $("mainScreen").style.display = "none";
  $("loginScreen").style.display = "flex";

  showLoginForm();
}


/* =====================================================
   LOGIN SOCKET EVENTS
===================================================== */

socket.on("loginSuccess", data => {

  const user =
    normalizeUser(
      data?.user || data
    );

  if (!user) {

    showMessage(
      "Сервер не вернул данные пользователя",
      "error"
    );

    return;
  }

  currentUser = user;

  saveSession();

  enterMainScreen();

});


socket.on("login_success", data => {

  const user =
    normalizeUser(
      data?.user || data
    );

  if (!user) {
    return;
  }

  currentUser = user;

  saveSession();

  enterMainScreen();

});


socket.on("loginError", message => {

  showMessage(
    getObjectValue(
      message,
      ["message", "error"],
      message || "Ошибка входа"
    ),
    "error"
  );

});


socket.on("login_error", message => {

  showMessage(
    getObjectValue(
      message,
      ["message", "error"],
      message || "Ошибка входа"
    ),
    "error"
  );

});


socket.on("registerSuccess", data => {

  showMessage(
    getObjectValue(
      data,
      ["message"],
      "Регистрация успешна. Теперь войдите."
    ),
    "success"
  );

  showLoginForm();

});


socket.on("register_success", data => {

  showMessage(
    getObjectValue(
      data,
      ["message"],
      "Регистрация успешна. Теперь войдите."
    ),
    "success"
  );

  showLoginForm();

});


socket.on("registerError", message => {

  showMessage(
    getObjectValue(
      message,
      ["message", "error"],
      message || "Ошибка регистрации"
    ),
    "error"
  );

});


socket.on("register_error", message => {

  showMessage(
    getObjectValue(
      message,
      ["message", "error"],
      message || "Ошибка регистрации"
    ),
    "error"
  );

});


/* =====================================================
   ENTER MAIN
===================================================== */

function enterMainScreen() {

  $("loginScreen").style.display = "none";
  $("mainScreen").style.display = "flex";

  renderCurrentUser();

  updateAdminButton();

  switchView("play");

  /*
   После входа обязательно просим сервер
   вернуть актуальное состояние.

   Это решает проблему:
   "после F5 пати исчезает,
   а сервер говорит что я уже в пати".
  */

  requestInitialState();

}


function requestInitialState() {

  socket.emit("getProfile");

  socket.emit("getMe");

  socket.emit("getQueueStats");

  socket.emit("getQueueState");

  socket.emit("getParty");

  socket.emit("getMyParty");

  socket.emit("getFriends");

  socket.emit("getFriendRequests");

  socket.emit("getChatHistory");

  socket.emit("getTop");

  socket.emit("getClan");

  if (currentUser?.isAdmin) {
    socket.emit("admin:getStats");
    socket.emit("admin:getUsers");
    socket.emit("admin:getQueues");
  }

  /*
   Если сервер использует событие restoreState,
   тоже отправляем.
  */

  socket.emit("restoreState");
  socket.emit("restoreSession");
}


/* =====================================================
   CURRENT USER
===================================================== */

function renderCurrentUser() {

  if (!currentUser) {
    return;
  }

  $("nickname").textContent =
    currentUser.nickname ||
    currentUser.username ||
    "Игрок";

  $("avatar").src =
    currentUser.avatar ||
    "https://via.placeholder.com/80";

  $("streakCount").textContent =
    currentUser.streak || 0;

  $("tooltipSiteId").textContent =
    currentUser.id || "—";

  $("tooltipSiteNick").textContent =
    currentUser.username || "—";

  $("tooltipGameId").textContent =
    currentUser.gameId || "—";

  $("tooltipGameNick").textContent =
    currentUser.nickname || "—";

}


function updateCurrentUser(data) {

  const normalized =
    normalizeUser(
      data?.user || data
    );

  if (!normalized) {
    return;
  }

  currentUser = {
    ...currentUser,
    ...normalized
  };

  saveSession();

  renderCurrentUser();

  updateAdminButton();
}


/* =====================================================
   PROFILE
===================================================== */

socket.on("profileData", data => {

  updateCurrentUser(data);

  renderProfile();

});


socket.on("profile", data => {

  updateCurrentUser(data);

  renderProfile();

});


socket.on("me", data => {

  updateCurrentUser(data);

  renderProfile();

});


function renderProfile() {

  if (!currentUser) {
    return;
  }

  const container =
    $("profileStats");

  if (!container) {
    return;
  }

  container.innerHTML = `

    <div class="stat-card">

      <h3>Основное</h3>

      <div class="stat-row">
        <span>Ник</span>
        <strong>
          ${escapeHTML(currentUser.nickname)}
        </strong>
      </div>

      <div class="stat-row">
        <span>ID игры</span>
        <strong>
          ${escapeHTML(currentUser.gameId)}
        </strong>
      </div>

      <div class="stat-row">
        <span>ID сайта</span>
        <strong>
          ${escapeHTML(currentUser.id)}
        </strong>
      </div>

    </div>


    <div class="stat-card">

      <h3>Статистика</h3>

      <div class="stat-row">
        <span>Рейтинг</span>
        <strong>
          ${currentUser.rating}
        </strong>
      </div>

      <div class="stat-row">
        <span>Победы</span>
        <strong>
          ${currentUser.wins}
        </strong>
      </div>

      <div class="stat-row">
        <span>Поражения</span>
        <strong>
          ${currentUser.losses}
        </strong>
      </div>

    </div>


    <div class="stat-card">

      <h3>Серия</h3>

      <div class="stat-row">
        <span>Текущий стрик</span>
        <strong>
          🔥 ${currentUser.streak}
        </strong>
      </div>

      <div class="stat-row">
        <span>Winrate</span>
        <strong>
          ${calculateWinrate(currentUser)}%
        </strong>
      </div>

    </div>

  `;

}


function calculateWinrate(user) {

  const wins =
    Number(user.wins || 0);

  const losses =
    Number(user.losses || 0);

  const total =
    wins + losses;

  if (!total) {
    return 0;
  }

  return Math.round(
    wins / total * 100
  );

}


function changeNickname() {

  const input =
    $("newNickInput");

  const nickname =
    input.value.trim();

  if (!nickname) {
    notify(
      "Введите новый ник",
      "error"
    );
    return;
  }

  socket.emit(
    "changeNickname",
    {
      nickname
    }
  );

  socket.emit(
    "changeNick",
    {
      nickname
    }
  );

}


/* =====================================================
   AVATAR
===================================================== */

function uploadAvatar(file) {

  if (!file) {
    return;
  }

  /*
   ВАЖНО:
   Если сервер принимает DataURL,
   отправляем DataURL.
  */

  const reader =
    new FileReader();

  reader.onload = () => {

    const avatar =
      reader.result;

    socket.emit(
      "changeAvatar",
      {
        avatar
      }
    );

    socket.emit(
      "updateAvatar",
      {
        avatar
      }
    );

  };

  reader.readAsDataURL(file);
}


socket.on("avatarUpdated", data => {

  updateCurrentUser(data);

  notify(
    "Аватар обновлён",
    "success"
  );

});


socket.on("avatar_updated", data => {

  updateCurrentUser(data);

  notify(
    "Аватар обновлён",
    "success"
  );

});


/* =====================================================
   NAVIGATION
===================================================== */

function switchView(viewName) {

  activeView = viewName;

  qa(".nav-btn").forEach(btn => {

    btn.classList.toggle(
      "active",
      btn.dataset.view === viewName
    );

  });


  qa(".view").forEach(view => {

    view.style.display = "none";
    view.classList.remove("active");

  });


  const view =
    $(`${viewName}View`);

  if (view) {

    view.style.display = "block";
    view.classList.add("active");

  }


  closeMobileMenu();


  if (viewName === "profile") {
    socket.emit("getProfile");
    renderProfile();
  }

  if (viewName === "history") {
    socket.emit("getMatchHistory");
    socket.emit("getHistory");
  }

  if (viewName === "friends") {
    socket.emit("getFriends");
    socket.emit("getFriendRequests");
  }

  if (viewName === "chat") {
    socket.emit("getChatHistory");
  }

  if (viewName === "top") {
    socket.emit("getTop");
    socket.emit("getLeaderboard");
  }

  if (viewName === "clan") {
    socket.emit("getClan");
  }

  if (viewName === "admin") {

    if (!currentUser?.isAdmin) {

      notify(
        "Нет доступа к админ-панели",
        "error"
      );

      switchView("play");

      return;
    }

    loadAdminData();
  }

}


/* =====================================================
   MOBILE MENU
===================================================== */

function openMobileMenu() {

  $("sidebar")
    .classList
    .add("mobile-open");

  $("mobileOverlay")
    .classList
    .add("open");

}


function closeMobileMenu() {

  $("sidebar")
    ?.classList
    .remove("mobile-open");

  $("mobileOverlay")
    ?.classList
    .remove("open");

}


/* =====================================================
   ADMIN
===================================================== */

function updateAdminButton() {

  const button =
    $("adminPanelBtn");

  if (!button) {
    return;
  }

  if (currentUser?.isAdmin) {

    button.style.display = "block";

  } else {

    button.style.display = "none";

  }

}


function loadAdminData() {

  if (!currentUser?.isAdmin) {
    return;
  }

  socket.emit("admin:getStats");
  socket.emit("admin:getUsers");
  socket.emit("admin:getQueues");

  /*
   Поддержка альтернативных названий
  */

  socket.emit("getAdminStats");
  socket.emit("getAdminUsers");
  socket.emit("getAdminQueues");

}


function renderAdminStats(data) {

  const box =
    $("adminServerStats");

  if (!box) {
    return;
  }

  const online =
    getObjectValue(
      data,
      ["online", "onlineUsers", "usersOnline"],
      0
    );

  const users =
    getObjectValue(
      data,
      ["users", "totalUsers"],
      0
    );

  const matches =
    getObjectValue(
      data,
      ["matches", "totalMatches"],
      0
    );

  box.innerHTML = `

    <div class="stat-row">
      <span>Онлайн</span>
      <strong>${escapeHTML(online)}</strong>
    </div>

    <div class="stat-row">
      <span>Пользователей</span>
      <strong>${escapeHTML(users)}</strong>
    </div>

    <div class="stat-row">
      <span>Матчей</span>
      <strong>${escapeHTML(matches)}</strong>
    </div>

  `;

}


socket.on("admin:stats", renderAdminStats);
socket.on("adminStats", renderAdminStats);


socket.on("admin:users", data => {

  const box =
    $("adminUsers");

  if (!box) {
    return;
  }

  const users =
    normalizeUsers(data);

  box.innerHTML = `
    <strong>
      Пользователей: ${users.length}
    </strong>
  `;

});


socket.on("admin:queues", data => {

  const box =
    $("adminQueues");

  if (!box) {
    return;
  }

  box.innerHTML =
    renderQueueAdmin(data);

});


function renderQueueAdmin(data) {

  if (!data) {
    return "Нет данных";
  }

  const source =
    data.queues ||
    data;

  let html = "";

  for (const mode of ["1v1", "2v2", "5v5"]) {

    const modeData =
      source[mode] || {};

    html += `

      <div class="stat-row">

        <span>
          ${mode} обычный
        </span>

        <strong>
          ${Number(
            modeData.unranked ||
            modeData.normal ||
            0
          )}
        </strong>

      </div>

      <div class="stat-row">

        <span>
          ${mode} ранговый
        </span>

        <strong>
          ${Number(
            modeData.ranked ||
            0
          )}
        </strong>

      </div>

    `;

  }

  return html;
}


/* =====================================================
   QUEUE
===================================================== */

function queueKey(mode, ranked) {

  return `${mode}-${ranked ? "ranked" : "unranked"}`;
}


function enterQueue(mode, ranked) {

  if (!currentUser) {

    notify(
      "Сначала войдите в аккаунт",
      "error"
    );

    return;
  }

  const payload = {
    mode,
    ranked: Boolean(ranked)
  };

  /*
   Основное событие
  */

  socket.emit(
    "joinQueue",
    payload
  );

  /*
   Альтернативное название
  */

  socket.emit(
    "join_queue",
    payload
  );

  currentQueue = payload;

  updateQueueButtonState();

}


function leaveQueue(mode, ranked) {

  const payload = {
    mode,
    ranked: Boolean(ranked)
  };

  socket.emit(
    "leaveQueue",
    payload
  );

  socket.emit(
    "leave_queue",
    payload
  );

  if (
    currentQueue &&
    currentQueue.mode === mode &&
    Boolean(currentQueue.ranked) === Boolean(ranked)
  ) {
    currentQueue = null;
  }

  updateQueueButtonState();

}


function updateQueueButtonState() {

  qa(".queue-mode-btn")
    .forEach(btn => {

      const mode =
        btn.dataset.mode;

      const ranked =
        btn.dataset.ranked === "true";

      const active =
        currentQueue &&
        currentQueue.mode === mode &&
        Boolean(currentQueue.ranked) === ranked;

      btn.classList.toggle(
        "in-queue",
        Boolean(active)
      );

    });


  qa(".leave-queue-btn")
    .forEach(btn => {

      const mode =
        btn.dataset.mode;

      const ranked =
        btn.dataset.ranked === "true";

      const active =
        currentQueue &&
        currentQueue.mode === mode &&
        Boolean(currentQueue.ranked) === ranked;

      btn.style.display =
        active ? "block" : "none";

    });

}


function updateQueueStats(data) {

  if (!data) {
    return;
  }

  const source =
    data.queues ||
    data;

  for (
    const mode of ["1v1", "2v2", "5v5"]
  ) {

    const modeData =
      source[mode];

    if (!modeData) {
      continue;
    }

    const unranked =
      Number(
        modeData.unranked ??
        modeData.normal ??
        modeData["false"] ??
        0
      );

    const ranked =
      Number(
        modeData.ranked ??
        modeData["true"] ??
        0
      );

    queueState[mode].unranked =
      unranked;

    queueState[mode].ranked =
      ranked;

  }

  renderQueueStats();

}


function renderQueueStats() {

  const sizes = {
    "1v1": 2,
    "2v2": 4,
    "5v5": 10
  };

  for (
    const mode of ["1v1", "2v2", "5v5"]
  ) {

    const size =
      sizes[mode];

    const unranked =
      queueState[mode].unranked;

    const ranked =
      queueState[mode].ranked;


    const unrankedCount =
      $(`queue-count-${mode}-unranked`);

    const rankedCount =
      $(`queue-count-${mode}-ranked`);

    if (unrankedCount) {

      unrankedCount.textContent =
        `${unranked}/${size}`;

    }

    if (rankedCount) {

      rankedCount.textContent =
        `${ranked}/${size}`;

    }


    const unrankedStatus =
      $(`queue-status-${mode}-unranked`);

    const rankedStatus =
      $(`queue-status-${mode}-ranked`);

    if (unrankedStatus) {

      unrankedStatus.textContent =
        getQueueStatus(
          mode,
          false
        );

    }

    if (rankedStatus) {

      rankedStatus.textContent =
        getQueueStatus(
          mode,
          true
        );

    }

  }

}


function getQueueStatus(mode, ranked) {

  if (
    currentQueue &&
    currentQueue.mode === mode &&
    Boolean(currentQueue.ranked) === Boolean(ranked)
  ) {
    return "Вы в очереди";
  }

  return "Не в очереди";
}


socket.on("queueStats", updateQueueStats);
socket.on("queue_stats", updateQueueStats);
socket.on("queueUpdate", updateQueueStats);
socket.on("queue_update", updateQueueStats);
socket.on("queueState", updateQueueStats);
socket.on("queue_state", updateQueueStats);


/* =====================================================
   QUEUE SUCCESS / ERROR
===================================================== */

function queueSuccess(data) {

  if (data?.mode) {

    currentQueue = {
      mode: data.mode,
      ranked: Boolean(data.ranked)
    };

  }

  notify(
    "Вы вошли в очередь",
    "success"
  );

  updateQueueButtonState();

}


socket.on("queueJoined", queueSuccess);
socket.on("queue_joined", queueSuccess);
socket.on("joinedQueue", queueSuccess);


function queueError(data) {

  notify(
    getObjectValue(
      data,
      ["message", "error"],
      "Ошибка очереди"
    ),
    "error"
  );

}


socket.on("queueError", queueError);
socket.on("queue_error", queueError);


socket.on("queueLeft", data => {

  if (
    currentQueue &&
    (
      !data ||
      data.mode === currentQueue.mode
    )
  ) {
    currentQueue = null;
  }

  updateQueueButtonState();

});


socket.on("queue_left", data => {

  if (
    currentQueue &&
    (
      !data ||
      data.mode === currentQueue.mode
    )
  ) {
    currentQueue = null;
  }

  updateQueueButtonState();

});


/* =====================================================
   PARTY
===================================================== */

function normalizeParty(data) {

  if (!data) {
    return null;
  }

  const party =
    data.party ||
    data;

  if (
    party.inParty === false ||
    party.exists === false
  ) {
    return null;
  }

  const members =
    normalizeUsers(
      party.members ||
      party.players ||
      party.users ||
      []
    );

  return {

    id:
      getObjectValue(
        party,
        ["id", "partyId"],
        ""
      ),

    code:
      getObjectValue(
        party,
        ["code", "partyCode"],
        ""
      ),

    ownerId:
      getObjectValue(
        party,
        ["ownerId", "leaderId", "hostId"],
        ""
      ),

    members

  };

}


function setParty(data) {

  const party =
    normalizeParty(data);

  if (!party) {

    currentParty = null;

    clearPartyLocal();

    renderParty();

    return;
  }

  currentParty = party;

  savePartyLocal();

  renderParty();

}


function renderParty() {

  const status =
    $("partyStatus");

  const membersBox =
    $("partyMembers");

  const membersList =
    $("partyMembersList");

  const createBtn =
    $("createPartyBtn");

  const joinArea =
    $("partyJoinArea");

  if (!status) {
    return;
  }

  if (!currentParty) {

    status.textContent =
      "Вы не состоите в пати";

    if (membersBox) {
      membersBox.style.display = "none";
    }

    if (createBtn) {
      createBtn.style.display = "block";
    }

    if (joinArea) {
      joinArea.style.display = "flex";
    }

    return;
  }


  status.innerHTML =
    `Вы в пати · <strong>${escapeHTML(
      currentParty.code || "—"
    )}</strong>`;


  if (createBtn) {
    createBtn.style.display = "none";
  }

  if (joinArea) {
    joinArea.style.display = "none";
  }

  if (membersBox) {
    membersBox.style.display = "block";
  }


  $("partyCode").textContent =
    currentParty.code || "—";


  if (!membersList) {
    return;
  }

  if (!currentParty.members.length) {

    membersList.innerHTML =
      "<p>Нет участников</p>";

    return;
  }


  membersList.innerHTML =
    currentParty.members
      .map(member => {

        const u =
          normalizeUser(member);

        const isOwner =
          String(u.id) ===
          String(currentParty.ownerId);

        return `

          <div class="party-member">

            <img
              src="${escapeHTML(
                userAvatar(u)
              )}"
              alt=""
              onclick="openPlayerProfile('${escapeHTML(
                u.id
              )}')"
            >

            <div class="party-member-info">

              <strong>
                ${escapeHTML(
                  userDisplayName(u)
                )}
              </strong>

              <small>
                ${isOwner ? "Создатель" : "Участник"}
              </small>

            </div>

          </div>

        `;

      })
      .join("");

}


function createParty() {

  if (!currentUser) {

    notify(
      "Сначала войдите в аккаунт",
      "error"
    );

    return;
  }

  if (currentParty) {

    notify(
      "Вы уже состоите в пати",
      "error"
    );

    /*
     Важно:
     не создаём вторую пати.
     Просто показываем текущую.
    */

    renderParty();

    return;
  }

  socket.emit("createParty");

}


function joinParty() {

  const code =
    $("joinPartyCode")
      .value
      .trim();

  if (!code) {

    notify(
      "Введите код пати",
      "error"
    );

    return;
  }

  socket.emit(
    "joinParty",
    {
      code
    }
  );

}


function leaveParty() {

  socket.emit("leaveParty");

}


socket.on("partyCreated", data => {

  setParty(data);

  notify(
    "Пати создано",
    "success"
  );

});


socket.on("party_created", data => {

  setParty(data);

});


socket.on("partyJoined", data => {

  setParty(data);

  notify(
    "Вы присоединились к пати",
    "success"
  );

});


socket.on("party_joined", data => {

  setParty(data);

});


socket.on("partyUpdate", data => {

  setParty(data);

});


socket.on("party_update", data => {

  setParty(data);

});


socket.on("partyData", data => {

  setParty(data);

});


socket.on("myParty", data => {

  setParty(data);

});


socket.on("partyState", data => {

  setParty(data);

});


socket.on("partyLeft", () => {

  currentParty = null;

  clearPartyLocal();

  renderParty();

  notify(
    "Вы покинули пати",
    "success"
  );

});


socket.on("partyError", data => {

  const message =
    getObjectValue(
      data,
      ["message", "error"],
      "Ошибка пати"
    );

  /*
   Если сервер говорит,
   что пользователь уже в пати,
   повторно получаем пати.
  */

  if (
    String(message)
      .toLowerCase()
      .includes("уже") &&
    String(message)
      .toLowerCase()
      .includes("пати")
  ) {

    socket.emit("getParty");
    socket.emit("getMyParty");

  }

  notify(
    message,
    "error"
  );

});


socket.on("party_error", data => {

  notify(
    getObjectValue(
      data,
      ["message", "error"],
      "Ошибка пати"
    ),
    "error"
  );

});


/* =====================================================
   MATCHMAKING
===================================================== */

function normalizeMatch(data) {

  if (!data) {
    return null;
  }

  const match =
    data.match ||
    data;

  const players =
    normalizeUsers(
      match.players ||
      match.participants ||
      match.users ||
      match.members ||
      []
    );

  return {

    id:
      getObjectValue(
        match,
        ["id", "matchId"],
        ""
      ),

    mode:
      getObjectValue(
        match,
        ["mode", "gameMode"],
        "1v1"
      ),

    ranked:
      Boolean(
        match.ranked
      ),

    players,

    accepted:
      match.accepted ||
      match.ready ||
      {},

    expiresAt:
      Number(
        getObjectValue(
          match,
          ["expiresAt", "deadline"],
          0
        )
      ) || 0

  };

}


function showMatchFound(data) {

  const match =
    normalizeMatch(data);

  if (!match) {
    return;
  }

  currentMatch = match;

  /*
   Матч найден всем участникам.
   Нельзя показывать окно только одному последнему игроку.
  */

  renderMatchFound();

  $("matchFoundModal").style.display =
    "flex";

  startMatchTimer(
    match.expiresAt
  );

}


function renderMatchFound() {

  if (!currentMatch) {
    return;
  }

  $("matchFoundMode").textContent =
    `${currentMatch.mode}${
      currentMatch.ranked
        ? " · Ранговый"
        : " · Обычный"
    }`;


  const list =
    $("participantsList");

  const players =
    currentMatch.players || [];


  if (!players.length) {

    list.innerHTML = `
      <div class="match-participant">
        <div class="match-participant-info">
          <strong>Ожидание игроков...</strong>
        </div>
      </div>
    `;

  } else {

    list.innerHTML =
      players
        .map(player => {

          const u =
            normalizeUser(player);

          const accepted =
            isPlayerAccepted(
              u
            );

          return `

            <div class="match-participant">

              <img
                src="${escapeHTML(
                  userAvatar(u)
                )}"
                alt=""
                onclick="openPlayerProfile('${escapeHTML(
                  u.id
                )}')"
              >

              <div class="match-participant-info">

                <strong>
                  ${escapeHTML(
                    userDisplayName(u)
                  )}
                </strong>

                <small>
                  ${
                    accepted
                      ? "✓ Принял"
                      : "Ожидает"
                  }
                </small>

              </div>

            </div>

          `;

        })
        .join("");

  }


  updateAcceptedText();

}


function isPlayerAccepted(player) {

  if (!currentMatch?.accepted) {
    return false;
  }

  const accepted =
    currentMatch.accepted;

  if (
    Array.isArray(accepted)
  ) {

    return accepted.some(
      id =>
        String(id) ===
        String(player.id)
    );

  }

  if (
    accepted &&
    typeof accepted === "object"
  ) {

    return Boolean(
      accepted[player.id]
    );

  }

  return false;
}


function acceptMatch() {

  if (!currentMatch) {
    return;
  }

  if (!currentUser) {
    return;
  }

  /*
   Отправляем ID матча.
   Это важно, чтобы сервер подтвердил
   именно этот матч.
  */

  const payload = {

    matchId:
      currentMatch.id,

    userId:
      currentUser.id

  };


  socket.emit(
    "acceptMatch",
    payload
  );

  socket.emit(
    "accept_match",
    payload
  );


  $("acceptMatchBtn").disabled =
    true;

  $("acceptMatchBtn")
    .classList
    .add("accepted");

  $("acceptMatchBtn")
    .textContent =
    "✓ МАТЧ ПРИНЯТ";

}


function startMatchTimer(expiresAt) {

  stopMatchTimer();

  /*
   Сервер должен передавать expiresAt.
   Если сервер не передал —
   ставим ровно 20 секунд.
  */

  let deadline =
    Number(expiresAt) || 0;

  if (
    !deadline ||
    deadline <
      Date.now() - 1000
  ) {

    deadline =
      Date.now() + 20000;

  }


  function tick() {

    const remaining =
      Math.max(
        0,
        deadline - Date.now()
      );


    const seconds =
      Math.ceil(
        remaining / 1000
      );


    $("matchTimer").textContent =
      seconds;


    const progress =
      Math.max(
        0,
        Math.min(
          1,
          remaining / 20000
        )
      );


    $("matchProgress")
      .style.transform =
      `scaleX(${progress})`;


    if (seconds <= 0) {

      stopMatchTimer();

      handleMatchExpired();

    }

  }


  tick();

  matchTimerInterval =
    setInterval(
      tick,
      100
    );

}


function stopMatchTimer() {

  if (matchTimerInterval) {

    clearInterval(
      matchTimerInterval
    );

    matchTimerInterval = null;

  }

}


function handleMatchExpired() {

  $("matchFoundModal").style.display =
    "none";

  currentMatch = null;

  notify(
    "Время принятия матча истекло",
    "error"
  );

}


function updateAcceptedText() {

  if (!currentMatch) {
    return;
  }

  const players =
    currentMatch.players || [];

  let acceptedCount = 0;

  players.forEach(player => {

    if (
      isPlayerAccepted(
        normalizeUser(player)
      )
    ) {
      acceptedCount++;
    }

  });


  const total =
    players.length;


  $("matchAcceptedText")
    .textContent =
    `Приняли: ${acceptedCount}/${total}`;


  if (
    currentUser &&
    isPlayerAccepted(currentUser)
  ) {

    $("acceptMatchBtn").disabled =
      true;

    $("acceptMatchBtn")
      .classList
      .add("accepted");

    $("acceptMatchBtn")
      .textContent =
      "✓ МАТЧ ПРИНЯТ";

  }

}


/* =====================================================
   MATCH EVENTS
===================================================== */

socket.on(
  "matchFound",
  showMatchFound
);

socket.on(
  "match_found",
  showMatchFound
);

socket.on(
  "matchReady",
  showMatchFound
);

socket.on(
  "match_ready",
  showMatchFound
);

socket.on(
  "matchConfirmation",
  showMatchFound
);

socket.on(
  "match_confirmation",
  showMatchFound
);


/*
   Сервер прислал обновление принятия.
*/

function handleMatchAcceptedUpdate(data) {

  if (!currentMatch) {
    return;
  }

  const match =
    normalizeMatch({
      ...currentMatch,
      ...(data?.match || data)
    });

  currentMatch = match;

  renderMatchFound();

  /*
   Если ВСЕ приняли —
   закрываем confirmation и
   открываем лобби.
  */

  const players =
    currentMatch.players || [];

  const allAccepted =
    players.length > 0 &&
    players.every(
      p =>
        isPlayerAccepted(
          normalizeUser(p)
        )
    );

  if (allAccepted) {

    stopMatchTimer();

    $("matchFoundModal").style.display =
      "none";

    openMatchLobby(
      currentMatch
    );

  }

}


socket.on(
  "matchAccepted",
  handleMatchAcceptedUpdate
);

socket.on(
  "match_accepted",
  handleMatchAcceptedUpdate
);

socket.on(
  "matchPlayerAccepted",
  handleMatchAcceptedUpdate
);

socket.on(
  "match_player_accepted",
  handleMatchAcceptedUpdate
);

socket.on(
  "matchUpdate",
  handleMatchAcceptedUpdate
);

socket.on(
  "match_update",
  handleMatchAcceptedUpdate
);


/* =====================================================
   MATCH START
===================================================== */

function openMatchLobby(data) {

  currentMatch =
    normalizeMatch(data) ||
    currentMatch;

  stopMatchTimer();

  $("matchFoundModal").style.display =
    "none";

  $("lobbyModal").style.display =
    "flex";

  renderLobbyPlayers();

  notify(
    "Матч подтверждён! Лобби создано.",
    "success"
  );

}


function renderLobbyPlayers() {

  const box =
    $("lobbyPlayers");

  if (!box || !currentMatch) {
    return;
  }

  box.innerHTML =
    (currentMatch.players || [])
      .map(player => {

        const u =
          normalizeUser(player);

        return `

          <div class="lobby-player">

            <img
              src="${escapeHTML(
                userAvatar(u)
              )}"
              alt=""
            >

            <strong>
              ${escapeHTML(
                userDisplayName(u)
              )}
            </strong>

          </div>

        `;

      })
      .join("");

}


socket.on(
  "matchStarted",
  data => {

    openMatchLobby(data);

  }
);

socket.on(
  "match_started",
  data => {

    openMatchLobby(data);

  }
);

socket.on(
  "matchCreated",
  data => {

    openMatchLobby(data);

  }
);

socket.on(
  "match_created",
  data => {

    openMatchLobby(data);

  }
);

socket.on(
  "lobbyCreated",
  data => {

    openMatchLobby(data);

  }
);

socket.on(
  "lobby_created",
  data => {

    openMatchLobby(data);

  }
);


/* =====================================================
   MATCH ERROR
===================================================== */

socket.on(
  "matchExpired",
  handleMatchExpired
);

socket.on(
  "match_expired",
  handleMatchExpired
);

socket.on(
  "matchCancelled",
  data => {

    stopMatchTimer();

    $("matchFoundModal").style.display =
      "none";

    currentMatch = null;

    notify(
      getObjectValue(
        data,
        ["message", "reason"],
        "Матч отменён"
      ),
      "error"
    );

  }
);

socket.on(
  "match_cancelled",
  data => {

    stopMatchTimer();

    $("matchFoundModal").style.display =
      "none";

    currentMatch = null;

    notify(
      getObjectValue(
        data,
        ["message", "reason"],
        "Матч отменён"
      ),
      "error"
    );

  }
);


/* =====================================================
   PROFILE OTHER PLAYER
===================================================== */

function openPlayerProfile(playerId) {

  if (!playerId) {
    return;
  }

  socket.emit(
    "getPlayerProfile",
    {
      userId: playerId
    }
  );

  socket.emit(
    "getUserProfile",
    {
      userId: playerId
    }
  );

  /*
   Если сервер не отвечает,
   можно использовать ID в модальном окне.
  */

  $("profileModal").style.display =
    "flex";

  $("playerProfileContent").innerHTML = `

    <div style="
      text-align:center;
      padding:30px;
      color:#94a3b8;
    ">
      Загрузка профиля...
    </div>

  `;

}


function renderPlayerProfile(data) {

  const user =
    normalizeUser(
      data?.user ||
      data?.player ||
      data
    );

  if (!user) {
    return;
  }

  $("profileModal").style.display =
    "flex";


  $("playerProfileContent").innerHTML = `

    <div class="player-profile-header">

      <img
        src="${escapeHTML(
          userAvatar(user)
        )}"
        alt=""
      >

      <div>

        <h2>
          ${escapeHTML(
            userDisplayName(user)
          )}
        </h2>

        <p style="color:#64748b;">
          ID игры:
          ${escapeHTML(user.gameId)}
        </p>

      </div>

    </div>


    <div class="player-profile-stats">

      <div class="player-profile-stat">

        <span>
          Рейтинг
        </span>

        <strong>
          ${user.rating}
        </strong>

      </div>


      <div class="player-profile-stat">

        <span>
          Победы
        </span>

        <strong>
          ${user.wins}
        </strong>

      </div>


      <div class="player-profile-stat">

        <span>
          Поражения
        </span>

        <strong>
          ${user.losses}
        </strong>

      </div>


      <div class="player-profile-stat">

        <span>
          Winrate
        </span>

        <strong>
          ${calculateWinrate(user)}%
        </strong>

      </div>


      <div class="player-profile-stat">

        <span>
          Стрик
        </span>

        <strong>
          🔥 ${user.streak}
        </strong>

      </div>

    </div>


    <div style="
      margin-top:15px;
      display:flex;
      gap:8px;
    ">

      <button
        class="primary-btn"
        onclick="sendFriendRequest('${escapeHTML(
          user.id
        )}')"
      >
        Добавить в друзья
      </button>

    </div>

  `;

}


socket.on(
  "playerProfile",
  renderPlayerProfile
);

socket.on(
  "player_profile",
  renderPlayerProfile
);

socket.on(
  "userProfile",
  renderPlayerProfile
);

socket.on(
  "user_profile",
  renderPlayerProfile
);


/* =====================================================
   FRIENDS
===================================================== */

function renderFriends(data) {

  friends =
    normalizeUsers(
      data?.friends ||
      data
    );

  const list =
    $("friendsList");

  if (!list) {
    return;
  }

  if (!friends.length) {

    list.innerHTML = `
      <p style="color:#64748b;">
        У вас пока нет друзей.
      </p>
    `;

    return;
  }


  list.innerHTML =
    friends
      .map(friend => {

        const u =
          normalizeUser(friend);

        return `

          <div class="friend-item">

            <img
              class="friend-avatar"
              src="${escapeHTML(
                userAvatar(u)
              )}"
              alt=""
              onclick="openPlayerProfile('${escapeHTML(
                u.id
              )}')"
            >

            <div class="friend-info">

              <strong>
                ${escapeHTML(
                  userDisplayName(u)
                )}
              </strong>

              <small>
                ID: ${escapeHTML(u.gameId)}
              </small>

            </div>

            <div class="friend-actions">

              <button
                onclick="openPlayerProfile('${escapeHTML(
                  u.id
                )}')"
              >
                Профиль
              </button>

              <button
                onclick="removeFriend('${escapeHTML(
                  u.id
                )}')"
              >
                Удалить
              </button>

            </div>

          </div>

        `;

      })
      .join("");

}


function renderFriendRequests(data) {

  friendRequests =
    normalizeUsers(
      data?.requests ||
      data?.friendRequests ||
      data
    );

  const list =
    $("friendRequests");

  const counter =
    $("friendRequestsCount");

  if (counter) {

    counter.textContent =
      friendRequests.length;

  }

  if (!list) {
    return;
  }

  if (!friendRequests.length) {

    list.innerHTML = `
      <p style="color:#64748b;">
        Новых заявок нет.
      </p>
    `;

    return;
  }


  list.innerHTML =
    friendRequests
      .map(request => {

        const u =
          normalizeUser(request);

        return `

          <div class="friend-item">

            <img
              class="friend-avatar"
              src="${escapeHTML(
                userAvatar(u)
              )}"
              alt=""
              onclick="openPlayerProfile('${escapeHTML(
                u.id
              )}')"
            >

            <div class="friend-info">

              <strong>
                ${escapeHTML(
                  userDisplayName(u)
                )}
              </strong>

              <small>
                Хочет добавить вас в друзья
              </small>

            </div>

            <div class="friend-actions">

              <button
                class="accept-request"
                onclick="acceptFriendRequest('${escapeHTML(
                  u.id
                )}')"
              >
                Принять
              </button>

              <button
                class="reject-request"
                onclick="rejectFriendRequest('${escapeHTML(
                  u.id
                )}')"
              >
                Отклонить
              </button>

            </div>

          </div>

        `;

      })
      .join("");

}


function sendFriendRequest(userId) {

  if (!userId) {
    return;
  }

  socket.emit(
    "sendFriendRequest",
    {
      userId
    }
  );

  socket.emit(
    "addFriend",
    {
      userId
    }
  );

}


function acceptFriendRequest(userId) {

  socket.emit(
    "acceptFriendRequest",
    {
      userId
    }
  );

}


function rejectFriendRequest(userId) {

  socket.emit(
    "rejectFriendRequest",
    {
      userId
    }
  );

}


function removeFriend(userId) {

  socket.emit(
    "removeFriend",
    {
      userId
    }
  );

}


socket.on(
  "friends",
  renderFriends
);

socket.on(
  "friendsList",
  renderFriends
);

socket.on(
  "friends_list",
  renderFriends
);

socket.on(
  "friendRequests",
  renderFriendRequests
);

socket.on(
  "friend_requests",
  renderFriendRequests
);


socket.on(
  "friendRequestSent",
  data => {

    notify(
      "Заявка отправлена",
      "success"
    );

  }
);


socket.on(
  "friend_request_sent",
  data => {

    notify(
      "Заявка отправлена",
      "success"
    );

  }
);


socket.on(
  "friendRequestReceived",
  data => {

    notify(
      "Новая заявка в друзья",
      "success"
    );

    socket.emit(
      "getFriendRequests"
    );

  }
);


socket.on(
  "friend_request_received",
  data => {

    notify(
      "Новая заявка в друзья",
      "success"
    );

    socket.emit(
      "getFriendRequests"
    );

  }
);


socket.on(
  "friendError",
  data => {

    notify(
      getObjectValue(
        data,
        ["message", "error"],
        "Ошибка друзей"
      ),
      "error"
    );

  }
);


/* =====================================================
   FRIEND SEARCH
===================================================== */

function searchFriends() {

  const query =
    $("friendSearchInput")
      .value
      .trim();

  if (!query) {

    notify(
      "Введите ник или ID",
      "error"
    );

    return;
  }

  socket.emit(
    "searchUsers",
    {
      query
    }
  );

  socket.emit(
    "searchFriends",
    {
      query
    }
  );

}


function renderSearchResults(data) {

  const results =
    normalizeUsers(
      data?.users ||
      data?.results ||
      data
    );

  const box =
    $("friendSearchResults");

  if (!box) {
    return;
  }

  if (!results.length) {

    box.innerHTML = `
      <p style="color:#64748b;">
        Игрок не найден.
      </p>
    `;

    return;
  }


  box.innerHTML =
    results
      .map(user => {

        const u =
          normalizeUser(user);

        if (isCurrentUser(u)) {
          return "";
        }

        return `

          <div class="friend-search-result">

            <img
              src="${escapeHTML(
                userAvatar(u)
              )}"
              alt=""
            >

            <div class="friend-search-result-info">

              <strong>
                ${escapeHTML(
                  userDisplayName(u)
                )}
              </strong>

              <div style="
                color:#64748b;
                font-size:12px;
              ">
                ID: ${escapeHTML(u.gameId)}
              </div>

            </div>

            <button
              class="primary-btn"
              onclick="sendFriendRequest('${escapeHTML(
                u.id
              )}')"
            >
              Добавить
            </button>

          </div>

        `;

      })
      .join("");

}


socket.on(
  "searchResults",
  renderSearchResults
);

socket.on(
  "search_results",
  renderSearchResults
);

socket.on(
  "usersFound",
  renderSearchResults
);


/* =====================================================
   CHAT
===================================================== */

function normalizeChatMessage(data) {

  if (!data) {
    return null;
  }

  /*
   Защита от Object object.
  */

  let message =
    data.message ||
    data.msg ||
    data;

  /*
   Если message сам объект,
   достаём текст из него.
  */

  if (
    message &&
    typeof message === "object"
  ) {

    const nested =
      getObjectValue(
        message,
        [
          "text",
          "content",
          "message",
          "body"
        ],
        ""
      );

    if (nested !== "") {
      message = nested;
    }

  }


  if (
    message === null ||
    message === undefined
  ) {

    message = "";

  }


  const sender =
    normalizeUser(
      data.user ||
      data.sender ||
      data.author ||
      (
        typeof data === "object"
          ? data
          : null
      )
    );


  return {

    id:
      getObjectValue(
        data,
        ["id", "messageId"],
        Date.now() + Math.random()
      ),

    text:
      String(message),

    user:
      sender,

    timestamp:
      getObjectValue(
        data,
        ["timestamp", "createdAt", "time"],
        Date.now()
      )

  };

}


function renderChat(data) {

  let messages =
    data?.messages ||
    data?.chat ||
    data;

  if (!Array.isArray(messages)) {

    const single =
      normalizeChatMessage(data);

    messages =
      single
        ? [single]
        : [];

  }


  chatMessages =
    messages
      .map(normalizeChatMessage)
      .filter(Boolean);


  renderChatMessages();

}


function renderChatMessages() {

  const box =
    $("chatMessages");

  if (!box) {
    return;
  }

  box.innerHTML =
    chatMessages
      .map(message => {

        const user =
          normalizeUser(
            message.user
          );

        const date =
          new Date(
            Number(
              message.timestamp
            ) || Date.now()
          );


        return `

          <div class="chat-message">

            <img
              class="chat-avatar"
              src="${escapeHTML(
                userAvatar(user)
              )}"
              alt=""
              onclick="openPlayerProfile('${escapeHTML(
                user.id
              )}')"
            >

            <div class="chat-message-body">

              <div class="chat-message-header">

                <strong
                  onclick="openPlayerProfile('${escapeHTML(
                    user.id
                  )}')"
                >
                  ${escapeHTML(
                    userDisplayName(user)
                  )}
                </strong>

                <small>
                  ${date.toLocaleTimeString(
                    [],
                    {
                      hour: "2-digit",
                      minute: "2-digit"
                    }
                  )}
                </small>

              </div>

              <div class="chat-message-text">
                ${escapeHTML(
                  message.text
                )}
              </div>

            </div>

          </div>

        `;

      })
      .join("");

  box.scrollTop =
    box.scrollHeight;

}


function sendChatMessage() {

  const input =
    $("chatInput");

  const text =
    input.value.trim();

  if (!text) {
    return;
  }

  socket.emit(
    "chatMessage",
    {
      message: text,
      text
    }
  );

  socket.emit(
    "sendMessage",
    {
      message: text,
      text
    }
  );

  input.value = "";

}


function receiveChatMessage(data) {

  const message =
    normalizeChatMessage(data);

  if (!message) {
    return;
  }

  /*
   Защита от двойной отправки,
   если сервер отвечает двумя событиями.
  */

  const exists =
    chatMessages.some(
      m =>
        String(m.id) ===
        String(message.id)
    );

  if (!exists) {

    chatMessages.push(
      message
    );

  }

  /*
   Ограничиваем память
  */

  if (chatMessages.length > 500) {

    chatMessages =
      chatMessages.slice(
        -500
      );

  }

  renderChatMessages();

}


socket.on(
  "chatHistory",
  renderChat
);

socket.on(
  "chat_history",
  renderChat
);

socket.on(
  "chatMessages",
  renderChat
);

socket.on(
  "chatMessage",
  receiveChatMessage
);

socket.on(
  "chat_message",
  receiveChatMessage
);

socket.on(
  "newMessage",
  receiveChatMessage
);

socket.on(
  "new_message",
  receiveChatMessage
);


/* =====================================================
   HISTORY
===================================================== */

function renderHistory(data) {

  const matches =
    data?.matches ||
    data?.history ||
    data;

  const list =
    $("matchList");

  if (!list) {
    return;
  }

  if (!Array.isArray(matches) || !matches.length) {

    list.innerHTML = `
      <p style="color:#64748b;">
        История матчей пуста.
      </p>
    `;

    return;
  }


  list.innerHTML =
    matches
      .map(match => {

        const mode =
          match.mode ||
          "Матч";

        const result =
          match.result ||
          match.outcome ||
          "—";

        const date =
          match.createdAt ||
          match.date ||
          match.timestamp;

        return `

          <div class="stat-card">

            <div class="stat-row">

              <span>
                Режим
              </span>

              <strong>
                ${escapeHTML(mode)}
              </strong>

            </div>

            <div class="stat-row">

              <span>
                Результат
              </span>

              <strong>
                ${escapeHTML(result)}
              </strong>

            </div>

            <div class="stat-row">

              <span>
                Дата
              </span>

              <strong>
                ${
                  date
                    ? new Date(date)
                        .toLocaleString()
                    : "—"
                }
              </strong>

            </div>

          </div>

        `;

      })
      .join("");

}


socket.on(
  "matchHistory",
  renderHistory
);

socket.on(
  "match_history",
  renderHistory
);

socket.on(
  "history",
  renderHistory
);


/* =====================================================
   TOP
===================================================== */

function renderTop(data) {

  const users =
    normalizeUsers(
      data?.users ||
      data?.players ||
      data?.top ||
      data
    );

  const box =
    $("topContent");

  if (!box) {
    return;
  }

  if (!users.length) {

    box.innerHTML = `
      <p style="color:#64748b;">
        Данные топа пока недоступны.
      </p>
    `;

    return;
  }


  box.innerHTML = `

    <table class="top-table">

      <thead>

        <tr>
          <th>#</th>
          <th>Игрок</th>
          <th>Рейтинг</th>
          <th>Победы</th>
        </tr>

      </thead>

      <tbody>

        ${users
          .map(
            (user, index) => {

              const u =
                normalizeUser(user);

              return `

                <tr>

                  <td>
                    ${index + 1}
                  </td>

                  <td>

                    <img
                      class="top-avatar"
                      src="${escapeHTML(
                        userAvatar(u)
                      )}"
                      alt=""
                    >

                    <span
                      onclick="openPlayerProfile('${escapeHTML(
                        u.id
                      )}')"
                      style="cursor:pointer;"
                    >
                      ${escapeHTML(
                        userDisplayName(u)
                      )}
                    </span>

                  </td>

                  <td>
                    ${u.rating}
                  </td>

                  <td>
                    ${u.wins}
                  </td>

                </tr>

              `;

            }
          )
          .join("")}

      </tbody>

    </table>

  `;

}


socket.on(
  "top",
  renderTop
);

socket.on(
  "topPlayers",
  renderTop
);

socket.on(
  "leaderboard",
  renderTop
);

socket.on(
  "leaderboardData",
  renderTop
);


/* =====================================================
   CLAN
===================================================== */

function renderClan(data) {

  const box =
    $("clanContent");

  if (!box) {
    return;
  }

  const clan =
    data?.clan ||
    data;

  if (
    !clan ||
    clan.exists === false
  ) {

    box.innerHTML = `
      <p style="color:#64748b;">
        Вы пока не состоите в клане.
      </p>
    `;

    return;
  }


  const name =
    getObjectValue(
      clan,
      ["name", "title"],
      "Клан"
    );

  const members =
    normalizeUsers(
      clan.members ||
      clan.players ||
      []
    );


  box.innerHTML = `

    <h3>
      🛡️ ${escapeHTML(name)}
    </h3>

    <p style="
      color:#64748b;
      margin:8px 0 15px;
    ">
      Участников: ${members.length}
    </p>

    ${
      members
        .map(user => {

          const u =
            normalizeUser(user);

          return `

            <div class="party-member">

              <img
                src="${escapeHTML(
                  userAvatar(u)
                )}"
                alt=""
              >

              <strong>
                ${escapeHTML(
                  userDisplayName(u)
                )}
              </strong>

            </div>

          `;

        })
        .join("")
    }

  `;

}


socket.on(
  "clan",
  renderClan
);

socket.on(
  "clanData",
  renderClan
);


/* =====================================================
   LOBBY CHAT
===================================================== */

function sendLobbyMessage() {

  const input =
    $("lobbyChatInput");

  const text =
    input.value.trim();

  if (!text) {
    return;
  }

  socket.emit(
    "lobbyChatMessage",
    {
      matchId:
        currentMatch?.id,
      message: text,
      text
    }
  );

  input.value = "";

}


function renderLobbyMessage(data) {

  const message =
    normalizeChatMessage(data);

  if (!message) {
    return;
  }

  const box =
    $("lobbyChat");

  if (!box) {
    return;
  }

  const user =
    normalizeUser(
      message.user
    );

  const item =
    document.createElement("div");

  item.style.padding =
    "5px 0";

  item.innerHTML = `

    <strong style="color:#60a5fa;">
      ${escapeHTML(
        userDisplayName(user)
      )}
    </strong>

    <span>
      ${escapeHTML(
        message.text
      )}
    </span>

  `;

  box.appendChild(item);

  box.scrollTop =
    box.scrollHeight;

}


socket.on(
  "lobbyChatMessage",
  renderLobbyMessage
);

socket.on(
  "lobby_chat_message",
  renderLobbyMessage
);

socket.on(
  "newLobbyMessage",
  renderLobbyMessage
);


/* =====================================================
   SOCKET CONNECTION
===================================================== */

socket.on(
  "connect",
  () => {

    isSocketReady = true;

    console.log(
      "Socket connected:",
      socket.id
    );

    /*
     После переподключения
     восстанавливаем состояние.
    */

    if (currentUser) {

      clearTimeout(
        reconnectRestoreTimer
      );

      reconnectRestoreTimer =
        setTimeout(
          requestInitialState,
          500
        );

    }

  }
);


socket.on(
  "disconnect",
  reason => {

    isSocketReady = false;

    console.log(
      "Socket disconnected:",
      reason
    );

  }
);


socket.on(
  "connect_error",
  error => {

    console.error(
      "Socket connection error:",
      error
    );

  }
);


/* =====================================================
   GENERAL ERROR
===================================================== */

socket.on(
  "error",
  data => {

    /*
     Не выводим [object Object].
    */

    const message =
      typeof data === "string"
        ? data
        : getObjectValue(
            data,
            ["message", "error"],
            "Произошла ошибка"
          );

    notify(
      message,
      "error"
    );

  }
);


/* =====================================================
   DOM EVENTS
===================================================== */

document.addEventListener(
  "DOMContentLoaded",
  () => {

    /*
     Login
    */

    $("doLoginBtn")
      ?.addEventListener(
        "click",
        doLogin
      );


    $("doRegisterBtn")
      ?.addEventListener(
        "click",
        doRegister
      );


    $("showRegisterLink")
      ?.addEventListener(
        "click",
        event => {

          event.preventDefault();

          showRegisterForm();

        }
      );


    $("showLoginLink")
      ?.addEventListener(
        "click",
        event => {

          event.preventDefault();

          showLoginForm();

        }
      );


    $("loginPassword")
      ?.addEventListener(
        "keydown",
        event => {

          if (
            event.key === "Enter"
          ) {

            doLogin();

          }

        }
      );


    $("regPasswordConfirm")
      ?.addEventListener(
        "keydown",
        event => {

          if (
            event.key === "Enter"
          ) {

            doRegister();

          }

        }
      );


    /*
     Logout
    */

    $("logoutBtn")
      ?.addEventListener(
        "click",
        logout
      );


    /*
     Navigation
    */

    qa(".nav-btn")
      .forEach(btn => {

        btn.addEventListener(
          "click",
          () => {

            const view =
              btn.dataset.view;

            if (view) {

              switchView(view);

            }

          }
        );

      });


    /*
     Mobile
    */

    $("mobileMenuBtn")
      ?.addEventListener(
        "click",
        openMobileMenu
      );


    $("mobileOverlay")
      ?.addEventListener(
        "click",
        closeMobileMenu
      );


    /*
     Profile
    */

    $("profileInfoIcon")
      ?.addEventListener(
        "click",
        event => {

          event.stopPropagation();

          const tooltip =
            $("profileTooltip");

          tooltip.style.display =
            tooltip.style.display ===
            "none"
              ? "block"
              : "none";

        }
      );


    $("changeAvatarBtn")
      ?.addEventListener(
        "click",
        () => {

          $("avatarUpload")
            ?.click();

        }
      );


    $("avatarUpload")
      ?.addEventListener(
        "change",
        event => {

          const file =
            event.target.files?.[0];

          uploadAvatar(file);

        }
      );


    $("changeNickBtn")
      ?.addEventListener(
        "click",
        changeNickname
      );


    /*
     Party
    */

    $("createPartyBtn")
      ?.addEventListener(
        "click",
        createParty
      );


    $("joinPartyBtn")
      ?.addEventListener(
        "click",
        joinParty
      );


    $("leavePartyBtn")
      ?.addEventListener(
        "click",
        leaveParty
      );


    $("copyPartyCodeBtn")
      ?.addEventListener(
        "click",
        () => {

          const code =
            currentParty?.code;

          if (!code) {
            return;
          }

          navigator.clipboard
            ?.writeText(code)
            .then(
              () =>
                notify(
                  "Код скопирован",
                  "success"
                )
            )
            .catch(
              () =>
                notify(
                  `Код: ${code}`,
                  "info"
                )
            );

        }
      );


    /*
     Queue
    */

    qa(".queue-mode-btn")
      .forEach(btn => {

        btn.addEventListener(
          "click",
          () => {

            enterQueue(
              btn.dataset.mode,
              btn.dataset.ranked ===
                "true"
            );

          }
        );

      });


    qa(".leave-queue-btn")
      .forEach(btn => {

        btn.addEventListener(
          "click",
          () => {

            leaveQueue(
              btn.dataset.mode,
              btn.dataset.ranked ===
                "true"
            );

          }
        );

      });


    /*
     Match
    */

    $("acceptMatchBtn")
      ?.addEventListener(
        "click",
        acceptMatch
      );


    /*
     Chat
    */

    $("chatForm")
      ?.addEventListener(
        "submit",
        event => {

          event.preventDefault();

          sendChatMessage();

        }
      );


    $("chatInput")
      ?.addEventListener(
        "keydown",
        event => {

          if (
            event.key === "Enter" &&
            !event.shiftKey
          ) {

            event.preventDefault();

            sendChatMessage();

          }

        }
      );


    /*
     Friends tabs
    */

    qa(".friends-tab")
      .forEach(tab => {

        tab.addEventListener(
          "click",
          () => {

            const target =
              tab.dataset.tab;

            qa(".friends-tab")
              .forEach(
                t =>
                  t.classList.remove(
                    "active"
                  )
              );

            tab.classList.add(
              "active"
            );


            $("friendsList")
              .style.display =
                target === "friends"
                  ? "flex"
                  : "none";


            $("friendRequests")
              .style.display =
                target === "requests"
                  ? "flex"
                  : "none";


            $("addFriends")
              .style.display =
                target === "search"
                  ? "block"
                  : "none";


            if (
              target === "friends"
            ) {

              socket.emit(
                "getFriends"
              );

            }

            if (
              target === "requests"
            ) {

              socket.emit(
                "getFriendRequests"
              );

            }

          }
        );

      });


    $("searchBtn")
      ?.addEventListener(
        "click",
        searchFriends
      );


    $("friendSearchInput")
      ?.addEventListener(
        "keydown",
        event => {

          if (
            event.key === "Enter"
          ) {

            event.preventDefault();

            searchFriends();

          }

        }
      );


    /*
     Close profile modal
    */

    $("closeProfileModal")
      ?.addEventListener(
        "click",
        () => {

          $("profileModal")
            .style.display =
            "none";

        }
      );


    /*
     Close lobby
    */

    $("closeLobbyBtn")
      ?.addEventListener(
        "click",
        () => {

          $("lobbyModal")
            .style.display =
            "none";

        }
      );


    /*
     Lobby chat
    */

    $("lobbyChatForm")
      ?.addEventListener(
        "submit",
        event => {

          event.preventDefault();

          sendLobbyMessage();

        }
      );


    /*
     Restore local session
    */

    const savedUser =
      loadSession();

    if (savedUser) {

      currentUser =
        savedUser;

      enterMainScreen();

    }

  }
);


/* =====================================================
   CLOSE MODALS ON BACKDROP
===================================================== */

$("profileModal")
  ?.addEventListener(
    "click",
    event => {

      if (
        event.target ===
        $("profileModal")
      ) {

        $("profileModal")
          .style.display =
          "none";

      }

    }
  );


$("lobbyModal")
  ?.addEventListener(
    "click",
    event => {

      if (
        event.target ===
        $("lobbyModal")
      ) {

        $("lobbyModal")
          .style.display =
          "none";

      }

    }
  );


/* =====================================================
   GLOBAL FUNCTIONS
===================================================== */

window.openPlayerProfile =
  openPlayerProfile;

window.sendFriendRequest =
  sendFriendRequest;

window.acceptFriendRequest =
  acceptFriendRequest;

window.rejectFriendRequest =
  rejectFriendRequest;

window.removeFriend =
  removeFriend;


/* =====================================================
   INITIAL QUEUE RENDER
===================================================== */

renderQueueStats();
updateQueueButtonState();


/* =====================================================
   INITIAL LOCAL PARTY
===================================================== */

const savedParty =
  loadPartyLocal();

if (savedParty) {

  currentParty =
    savedParty;

}


/* =====================================================
   PERIODIC QUEUE REFRESH
===================================================== */

setInterval(
  () => {

    if (
      currentUser &&
      isSocketReady
    ) {

      socket.emit(
        "getQueueStats"
      );

      socket.emit(
        "getQueueState"
      );

    }

  },
  3000
);


/* =====================================================
   PERIODIC PARTY RESTORE
===================================================== */

setInterval(
  () => {

    if (
      currentUser &&
      isSocketReady
    ) {

      socket.emit(
        "getParty"
      );

    }

  },
  5000
);
