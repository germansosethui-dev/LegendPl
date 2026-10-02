"use strict";

/* =========================================================
   LEGEND PL CLIENT
========================================================= */

const socket = io({
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity
});

let currentUser = null;
let currentParty = null;
let currentMatch = null;

let matchTimer = null;
let currentTopMode = "1v1";

const $ = id =>
  document.getElementById(id);

function escapeHTML(value) {
  return String(
    value ?? ""
  )
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function avatar(user) {
  return (
    user?.avatar ||
    "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg"
           width="100"
           height="100">
        <rect width="100" height="100"
              rx="50"
              fill="#26334a"/>
        <text x="50"
              y="58"
              text-anchor="middle"
              fill="#94a3b8"
              font-size="40">
          ?
        </text>
      </svg>
    `)
  );
}

function notify(text) {
  const el =
    $("notification");

  el.textContent = String(text);

  el.className = "show";

  clearTimeout(
    el._timer
  );

  el._timer =
    setTimeout(() => {
      el.className = "";
    }, 3000);
}


function uiModal({ title, message = "", input = false, value = "", placeholder = "", confirmText = "Подтвердить", cancelText = "Отмена" }) {
  return new Promise(resolve => {
    const modal = document.createElement("div");
    modal.className = "modal ui-dialog";
    modal.innerHTML = `
      <div class="modal-box dialog-box">
        <div class="dialog-glow"></div>
        <h3>${escapeHTML(title)}</h3>
        ${message ? `<p class="dialog-message">${escapeHTML(message)}</p>` : ""}
        ${input ? `<input id="uiDialogInput" class="dialog-input" value="${escapeHTML(value)}" placeholder="${escapeHTML(placeholder)}">` : ""}
        <div class="modal-buttons">
          <button id="uiDialogCancel" class="secondary">${escapeHTML(cancelText)}</button>
          <button id="uiDialogOk" class="success">${escapeHTML(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = result => { modal.remove(); resolve(result); };
    modal.querySelector("#uiDialogCancel").onclick = () => close(null);
    modal.querySelector("#uiDialogOk").onclick = () => close(input ? modal.querySelector("#uiDialogInput").value.trim() : true);
    modal.addEventListener("click", e => { if (e.target === modal) close(null); });
    if (input) { const el = modal.querySelector("#uiDialogInput"); el.focus(); el.select(); el.addEventListener("keydown", e => { if (e.key === "Enter") modal.querySelector("#uiDialogOk").click(); }); }
  });
}

const uiPrompt = (title, message, placeholder = "", value = "") => uiModal({ title, message, input:true, placeholder, value, confirmText:"Сохранить" });
const uiConfirm = (title, message) => uiModal({ title, message, confirmText:"Подтвердить" });

async function api(
  url,
  options = {}
) {
  let response;

  try {
    response = await fetch(url, options);
  } catch (err) {
    throw new Error("Не удалось подключиться к серверу.");
  }

  const contentType = response.headers.get("content-type") || "";
  let data = null;
  let raw = "";

  try {
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else {
      raw = await response.text();
      try { data = JSON.parse(raw); } catch { data = null; }
    }
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (data?.message) throw new Error(String(data.message));

    if (response.status === 404) {
      throw new Error("Запрос не найден на сервере. Перезапусти сервер с последней версией проекта.");
    }

    if (response.status === 401) {
      throw new Error("Неверный логин или пароль.");
    }

    throw new Error("Ошибка сервера. Попробуйте ещё раз.");
  }

  if (!data || typeof data !== "object") {
    throw new Error("Сервер вернул некорректный ответ.");
  }

  return data;
}

async function post(
  url,
  body
) {
  return api(
    url,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify(body)
    }
  );
}

/* =========================================================
   SESSION
========================================================= */

function saveSession() {
  if (!currentUser) return;

  localStorage.setItem(
    "legendpl_user",
    currentUser.id
  );
}

function clearSession() {
  localStorage.removeItem(
    "legendpl_user"
  );
}

async function restoreSession() {
  const id =
    localStorage.getItem(
      "legendpl_user"
    );

  if (!id) return;

  try {
    const data =
      await api(
        `/api/me?userId=${encodeURIComponent(id)}`
      );

    currentUser =
      data.user;

    currentParty =
      data.party;

    saveSession();

    showMain();

    renderEverything();

    socket.emit(
      "auth",
      currentUser.id
    );
  } catch {
    clearSession();
  }
}

/* =========================================================
   AUTH
========================================================= */

$("showRegister").onclick =
  () => {
    $("loginForm").style.display =
      "none";

    $("registerForm").style.display =
      "block";
  };

$("showLogin").onclick =
  () => {
    $("registerForm").style.display =
      "none";

    $("loginForm").style.display =
      "block";
  };

$("loginBtn").onclick =
  login;

$("registerBtn").onclick =
  register;

const authMenuBtn = $("authMenuBtn");
const authMenu = $("authMenu");
const authMenuOverlay = $("authMenuOverlay");

function closeAuthMenu() {
  if (authMenu) authMenu.classList.remove("open");
  if (authMenuOverlay) authMenuOverlay.classList.remove("open");
}

if (authMenuBtn) {
  authMenuBtn.onclick = () => {
    authMenu?.classList.toggle("open");
    authMenuOverlay?.classList.toggle("open");
  };
}

if (authMenuOverlay) authMenuOverlay.onclick = closeAuthMenu;

const authAboutBtn = $("authAboutBtn");
if (authAboutBtn) {
  authAboutBtn.onclick = () => {
    closeAuthMenu();
    document.getElementById("authAbout")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
}

async function login() {
  const username =
    $("loginUsername").value.trim();

  const password =
    $("loginPassword").value;

  if (!username || !password) {
    $("authMessage").textContent =
      "Введите логин и пароль.";

    return;
  }

  $("authMessage").textContent = "Выполняется вход…";

  try {
    const data =
      await post(
        "/api/login",
        {
          username,
          password
        }
      );

    currentUser =
      data.user;

    saveSession();

    showMain();

    socket.emit(
      "auth",
      currentUser.id
    );

    await refreshMe();

    notify("Вход выполнен.");
  } catch (err) {
    $("authMessage").textContent =
      err.message;
  }
}

async function register() {
  const username =
    $("regUsername").value.trim();

  const password =
    $("regPassword").value;

  const password2 =
    $("regPassword2").value;

  const inGameNick =
    $("regGameNick").value.trim();

  const inGameId =
    $("regGameId").value.trim();

  if (
    !username ||
    !password ||
    !inGameNick ||
    !inGameId
  ) {
    $("authMessage").textContent =
      "Заполните все поля.";

    return;
  }

  if (password !== password2) {
    $("authMessage").textContent =
      "Пароли не совпадают.";

    return;
  }

  try {
    await post(
      "/api/register",
      {
        username,
        password,
        inGameNick,
        inGameId
      }
    );

    $("authMessage").textContent =
      "Аккаунт создан. Теперь войдите.";

    $("registerForm").style.display =
      "none";

    $("loginForm").style.display =
      "block";

    $("loginUsername").value = username;
    $("loginPassword").value = "";
    $("loginPassword").focus();

  } catch (err) {
    $("authMessage").textContent =
      err.message;
  }
}

/* =========================================================
   MAIN
========================================================= */

function showMain() {
  $("loginScreen").style.display =
    "none";

  $("mainScreen").style.display =
    "flex";
}

function showLogin() {
  $("mainScreen").style.display =
    "none";

  $("loginScreen").style.display =
    "flex";
}

async function refreshMe() {
  if (!currentUser) return;

  const data =
    await api(
      `/api/me?userId=${encodeURIComponent(
        currentUser.id
      )}`
    );

  currentUser =
    data.user;

  currentParty =
    data.party;

  saveSession();

  renderEverything();
}

function renderEverything() {
  renderCurrentUser();
  renderParty();
  renderProfile();

  if (
    currentUser?.isAdmin
  ) {
    $("adminNavBtn").style.display =
      "block";

    $("adminStickerBox").style.display =
      "block";
  }
}

/* =========================================================
   CURRENT USER
========================================================= */

function renderCurrentUser() {
  if (!currentUser) return;

  $("myAvatar").src =
    avatar(currentUser);

  $("myNick").textContent =
    currentUser.inGameNick ||
    "Игрок";

  $("mySticker").textContent =
    currentUser.sticker || "";

  const elo =
    currentUser.stats?.["1v1"]?.elo ||
    100;

  $("myLevel").textContent =
    `Уровень ${getLevel(elo)}`;
}

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

/* =========================================================
   MOBILE MENU
========================================================= */
const mobileMenuBtn = $("mobileMenuBtn");
const sidebar = $("sidebar");
const sidebarOverlay = $("sidebarOverlay");
function setMobileMenu(open){ sidebar?.classList.toggle("mobile-open", open); sidebarOverlay?.classList.toggle("open", open); }
function closeMobileMenu(){ setMobileMenu(false); }
mobileMenuBtn?.addEventListener("click", () => setMobileMenu(!sidebar?.classList.contains("mobile-open")));
sidebarOverlay?.addEventListener("click", closeMobileMenu);

/* =========================================================
   NAVIGATION
========================================================= */

document
  .querySelectorAll(".nav-btn")
  .forEach(button => {

    button.onclick = () => {
      switchView(button.dataset.view);
      closeMobileMenu();
    };

  });

function switchView(view) {
  document
    .querySelectorAll(".nav-btn")
    .forEach(btn => {
      btn.classList.toggle(
        "active",
        btn.dataset.view === view
      );
    });

  document
    .querySelectorAll(".view")
    .forEach(el => {
      el.style.display =
        "none";
    });

  const target =
    $(`${view}View`);

  if (target) {
    target.style.display =
      "block";
  }

  if (view === "friends") {
    loadFriends();
  }

  if (view === "top") {
    loadTop();
  }

  if (view === "clan") {
    loadClan();
  }

  if (view === "admin") {
    if (!currentUser?.isAdmin) {
      notify(
        "Нет доступа."
      );

      return;
    }

    loadAdmin();
  }
}

/* =========================================================
   AVATAR
========================================================= */

$("avatarBtn").onclick =
  () =>
    $("avatarInput").click();

$("avatarInput").onchange =
  async event => {

    const file =
      event.target.files[0];

    if (!file) return;

    const form =
      new FormData();

    form.append(
      "avatar",
      file
    );

    form.append(
      "userId",
      currentUser.id
    );

    try {
      await api(
        "/api/upload-avatar",
        {
          method: "POST",
          body: form
        }
      );

      await refreshMe();

      notify(
        "Аватар обновлён."
      );

    } catch (err) {
      notify(err.message);
    }
  };

/* =========================================================
   PROFILE
========================================================= */

function renderProfile() {
  if (!currentUser) return;

  const stats =
    currentUser.stats;

  $("profileContent").innerHTML =
    `
    <div class="stat-card">
      <h3>Основное</h3>

      <div class="stat-row">
        <span>Ник</span>
        <b>${escapeHTML(
          currentUser.inGameNick
        )}</b>
      </div>

      <div class="stat-row">
        <span>ID игры</span>
        <b>${escapeHTML(
          currentUser.inGameId
        )}</b>
      </div>

      <div class="stat-row">
        <span>ID сайта</span>
        <b>${escapeHTML(
          currentUser.id
        )}</b>
      </div>

      <div class="stat-row">
        <span>Логин</span>
        <b>${escapeHTML(
          currentUser.username
        )}</b>
      </div>
    </div>

    ${profileMode(
      "1v1",
      stats["1v1"]
    )}

    ${profileMode(
      "2v2",
      stats["2v2"]
    )}

    ${profileMode(
      "5v5",
      stats["5v5"]
    )}
  `;

  $("adminSticker").value =
    currentUser.sticker || "";
}

function profileMode(
  mode,
  stats
) {
  const kd =
    stats.deaths > 0
      ? (
          stats.kills /
          stats.deaths
        ).toFixed(2)
      : stats.kills;

  return `
    <div class="stat-card">

      <h3>${mode}</h3>

      <div class="stat-row">
        <span>ELO</span>
        <b>${stats.elo}</b>
      </div>

      <div class="stat-row">
        <span>Уровень</span>
        <b>${getLevel(
          stats.elo
        )}</b>
      </div>

      <div class="stat-row">
        <span>Матчи</span>
        <b>${stats.matches}</b>
      </div>

      <div class="stat-row">
        <span>Обычных до ранга</span>
        <b>${stats[`unrankedMatches${mode}`] || 0}/3</b>
      </div>

      <div class="stat-row">
        <span>Победы</span>
        <b>${stats.wins}</b>
      </div>

      <div class="stat-row">
        <span>Поражения</span>
        <b>${stats.losses}</b>
      </div>

      <div class="stat-row">
        <span>Стрик</span>
        <b>${stats.streak}</b>
      </div>

      <div class="stat-row">
        <span>К/Д</span>
        <b>${kd}</b>
      </div>

    </div>
  `;
}

$("changeNickBtn").onclick =
  async () => {

    const newNick =
      $("newNick").value.trim();

    if (!newNick) {
      notify(
        "Введите новый ник."
      );

      return;
    }

    try {
      const data =
        await post(
          "/api/change-nick",
          {
            userId:
              currentUser.id,

            newNick
          }
        );

      currentUser =
        data.user;

      renderEverything();

      $("newNick").value = "";

      notify(
        "Ник изменён."
      );

    } catch (err) {
      notify(err.message);
    }
  };

/* =========================================================
   ADMIN STICKER
========================================================= */

$("saveStickerBtn").onclick =
  async () => {

    try {
      const data =
        await post(
          "/api/admin/sticker",
          {
            adminId:
              currentUser.id,

            sticker:
              $("adminSticker")
                .value
                .trim()
          }
        );

      currentUser =
        data.user;

      renderEverything();

      notify(
        "Стикер сохранён."
      );

    } catch (err) {
      notify(err.message);
    }
  };

/* =========================================================
   PARTY
========================================================= */

function renderParty() {
  const box =
    $("partyMembers");

  if (!currentParty) {
    $("partyStatus").textContent =
      "Вы не состоите в пати";

    box.innerHTML = "";

    $("createPartyBtn").style.display =
      "block";

    $("partyCodeInput").style.display =
      "block";

    $("joinPartyBtn").style.display =
      "block";

    $("leavePartyBtn").style.display =
      "none";

    return;
  }

  $("partyStatus").innerHTML =
    `Вы в пати · <b>${escapeHTML(
      currentParty.code
    )}</b>`;

  $("createPartyBtn").style.display =
    "none";

  $("partyCodeInput").style.display =
    "none";

  $("joinPartyBtn").style.display =
    "none";

  $("leavePartyBtn").style.display =
    "block";

  box.innerHTML =
    currentParty.members
      .map(member => `
        <div class="party-member">

          <img src="${avatar(
            member
          )}">

          <span>
            ${escapeHTML(
              member.inGameNick
            )}
          </span>

          ${
            member.id ===
            currentParty.leaderId
              ? "<b>👑</b>"
              : ""
          }

          ${
            member.id !==
            currentUser.id
              ? `
                <button
                  onclick="openPlayerProfile('${member.id}')"
                >
                  Профиль
                </button>
              `
              : ""
          }

        </div>
      `)
      .join("");
}

$("createPartyBtn").onclick =
  async () => {

    try {
      const data =
        await post(
          "/api/create-party",
          {
            userId:
              currentUser.id
          }
        );

      currentParty =
        data.party;

      renderParty();

      notify(
        `Пати создана: ${currentParty.code}`
      );

    } catch (err) {
      notify(err.message);
    }
  };

$("joinPartyBtn").onclick =
  async () => {

    const partyId =
      $("partyCodeInput")
        .value
        .trim();

    if (!partyId) {
      notify(
        "Введите код пати."
      );

      return;
    }

    try {
      const data =
        await post(
          "/api/join-party",
          {
            userId:
              currentUser.id,

            partyId
          }
        );

      currentParty =
        data.party;

      renderParty();

    } catch (err) {
      notify(err.message);
    }
  };

$("leavePartyBtn").onclick =
  async () => {

    if (!currentParty) return;

    try {
      await post(
        "/api/leave-party",
        {
          userId:
            currentUser.id,

          partyId:
            currentParty.id
        }
      );

      currentParty =
        null;

      renderParty();

    } catch (err) {
      notify(err.message);
    }
  };

/* =========================================================
   QUEUE
========================================================= */

document
  .querySelectorAll(".queue-btn")
  .forEach(button => {

    button.onclick =
      () => {

        socket.emit(
          "joinQueue",
          {
            mode:
              button.dataset.mode,

            ranked:
              button.dataset.ranked ===
              "true",

            partyId:
              currentParty?.id
          }
        );

      };

  });

document
  .querySelectorAll(".leave-queue")
  .forEach(button => {

    button.onclick =
      () => {

        socket.emit(
          "leaveQueue",
          {
            mode:
              button.dataset.mode,

            ranked:
              button.dataset.ranked ===
              "true"
          }
        );

      };

  });

socket.on(
  "queueUpdate",
  renderQueue
);

function renderQueue(data) {
  if (!data) return;

  for (
    const mode of [
      "1v1",
      "2v2",
      "5v5"
    ]
  ) {

    const normal =
      data[mode]?.unranked || 0;

    const ranked =
      data[mode]?.ranked || 0;

    const normalMax =
      mode === "1v1"
        ? 2
        : mode === "2v2"
          ? 4
          : 10;

    $(
      `queue-${mode}-unranked`
    ).textContent =
      `${normal}/${normalMax}`;

    $(
      `queue-${mode}-ranked`
    ).textContent =
      `${ranked}/${normalMax}`;
  }
}

/* =========================================================
   MATCH FOUND
========================================================= */

socket.on(
  "matchFound",
  data => {

    currentMatch = data;

    openMatchModal(
      data
    );
  }
);

function openMatchModal(
  match
) {
  $("matchModal").style.display =
    "flex";

  $("matchInfo").innerHTML =
    `
      <p>
        <b>ID матча:</b>
        ${escapeHTML(
          match.matchId
        )}
      </p>

      <p>
        <b>Режим:</b>
        ${escapeHTML(
          match.mode
        )}
      </p>

      <p><b>Карта:</b> ${escapeHTML(match.map)}</p>
      <p><b>Раундов:</b> ${Number(match.rounds || 0)}</p>
      <p><b>Приняли:</b> <span id="matchAcceptedCount">${Number(match.accepted || 0)}/${Number(match.total || match.participants?.length || 0)}</span></p>

      <div class="teams">

        <div class="team">
          ${match.participants
            .slice(
              0,
              Math.ceil(
                match.participants.length /
                  2
              )
            )
            .map(playerCard)
            .join("")}
        </div>

        <div class="team">
          ${match.participants
            .slice(
              Math.ceil(
                match.participants.length /
                  2
              )
            )
            .map(playerCard)
            .join("")}
        </div>

      </div>
    `;

  startMatchTimer(
    Number(match.timeout) || 20
  );
}

function playerCard(
  player
) {
  return `
    <div
      class="team-player"
      onclick="openPlayerProfile('${escapeHTML(
        player.id
      )}')"
    >

      <img
        src="${avatar(player)}"
      >

      <span>
        ${escapeHTML(
          player.inGameNick
        )}
      </span>

    </div>
  `;
}

function startMatchTimer(
  seconds
) {
  clearInterval(
    matchTimer
  );

  let left = seconds;

  $("matchTimer")
    .textContent = left;

  matchTimer =
    setInterval(() => {

      left--;

      $("matchTimer")
        .textContent =
        Math.max(
          0,
          left
        );

      if (left <= 0) {
        clearInterval(
          matchTimer
        );
      }

    }, 1000);
}

$("acceptMatchBtn").onclick =
  () => {

    if (!currentMatch) return;

    socket.emit(
      "acceptMatch",
      {
        matchId:
          currentMatch.matchId
      }
    );

    $("acceptMatchBtn")
      .disabled = true;
  };

$("declineMatchBtn").onclick =
  () => {

    if (!currentMatch) return;

    socket.emit(
      "declineMatch",
      {
        matchId:
          currentMatch.matchId
      }
    );

    closeMatchModal();
  };

socket.on("matchAcceptedUpdate", data => {
  const counter = $("matchAcceptedCount");
  if (counter) counter.textContent = `${data.accepted}/${data.total}`;
  if (currentMatch) { currentMatch.accepted = data.accepted; currentMatch.total = data.total; }
  notify(`Приняли матч: ${data.accepted}/${data.total}`);
});

socket.on(
  "matchCancelled",
  data => {

    closeMatchModal();

    notify(
      data.reason ||
      "Матч отменён."
    );

  }
);

/* =========================================================
   DRAFT
========================================================= */

socket.on("matchDraft", data => {
  currentMatch = data;
  openDraftModal(data);
});

function openDraftModal(match) {
  let modal = $("draftModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "draftModal";
    modal.className = "modal";
    document.body.appendChild(modal);
  }
  modal.style.display = "flex";
  const captainIds = new Set((match.captains || []).map(x => x?.id));
  const left = Number(match.draftSeconds || 6);
  modal.innerHTML = `
    <div class="modal-box draft-box">
      <div class="draft-badge">ДРАФТ МАТЧА</div>
      <h2>Матч подготовлен</h2>
      <div class="draft-id">${escapeHTML(match.matchId)}</div>
      <div class="draft-params">
        <div><span>Карта</span><b>${escapeHTML(match.map)}</b></div>
        <div><span>Раундов</span><b>${match.rounds}</b></div>
        <div><span>Макс. деньги</span><b>$${Number(match.maxMoney || 16000).toLocaleString()}</b></div>
      </div>
      <div class="teams draft-teams">
        <div class="team"><h3>Команда A</h3>${(match.teamA||[]).map(p => playerCard(p)+(captainIds.has(p?.id)?'<small class="captain-tag">КАПИТАН</small>':'')).join("")}</div>
        <div class="team"><h3>Команда B</h3>${(match.teamB||[]).map(p => playerCard(p)+(captainIds.has(p?.id)?'<small class="captain-tag">КАПИТАН</small>':'')).join("")}</div>
      </div>
      <div class="lobby-creator"><b>Создаёт лобби:</b> ${playerCard(match.lobbyCreator || {})}<span class="creator-id">ID в игре: ${escapeHTML(match.lobbyCreator?.inGameId || "—")}</span></div>
      <div class="draft-countdown">Переход в лобби через <b id="draftTimer">${left}</b> сек.</div>
    </div>`;
  let sec = left;
  clearInterval(window._draftTimer);
  window._draftTimer = setInterval(() => { sec--; const el=$("draftTimer"); if(el) el.textContent=Math.max(0,sec); if(sec<=0){clearInterval(window._draftTimer); modal.style.display="none";} },1000);
}

/* =========================================================
   MATCH LOBBY
========================================================= */

socket.on(
  "matchLobby",
  data => {

    currentMatch = data;
  $("draftModal")?.style && ($("draftModal").style.display = "none");
  closeMatchModal();

    openGameModal(
      data
    );
  }
);

function closeMatchModal() {
  clearInterval(
    matchTimer
  );

  $("matchModal").style.display =
    "none";

  $("acceptMatchBtn")
    .disabled = false;
}

function openGameModal(
  match
) {
  $("gameModal").style.display =
    "flex";

  $("gameMatchId").textContent =
    `ID матча: ${match.matchId}`;

  $("gameMap").innerHTML = `Карта: <b>${escapeHTML(match.map)}</b> · Раундов: <b>${Number(match.rounds || 0)}</b> · Макс. денег: <b>$${Number(match.maxMoney || 16000).toLocaleString()}</b>`;
  const lobbyInfo = document.getElementById("gameLobbyInfo");
  if (lobbyInfo) lobbyInfo.innerHTML = `Создаёт лобби: <b>${escapeHTML(match.lobbyCreator?.inGameNick || "—")}</b> · ID игры: <b>${escapeHTML(match.lobbyCreator?.inGameId || "—")}</b>`;

  $("teamA").innerHTML =
    match.teamA
      .map(playerCard)
      .join("");

  $("teamB").innerHTML =
    match.teamB
      .map(playerCard)
      .join("");

  renderScreenshots(
    match.screenshots || []
  );
}

$("closeGameBtn").onclick =
  () => {
    $("gameModal").style.display =
      "none";
  };

$("chooseScreenshotBtn")?.addEventListener("click", () => $("screenshotInput")?.click());
$("screenshotInput")?.addEventListener("change", e => {
  const file = e.target.files?.[0];
  if ($("screenshotFileName")) $("screenshotFileName").textContent = file ? file.name : "Файл не выбран";
});

$("uploadScreenshotBtn").onclick =
  async () => {

    const file =
      $("screenshotInput")
        .files[0];

    if (!file) {
      notify(
        "Выберите скриншот."
      );

      return;
    }

    if (!currentMatch) {
      return;
    }

    const form =
      new FormData();

    form.append(
      "screenshot",
      file
    );

    form.append(
      "userId",
      currentUser.id
    );

    try {
      const data =
        await api(
          `/api/match/${encodeURIComponent(
            currentMatch.matchId
          )}/screenshot`,
          {
            method: "POST",
            body: form
          }
        );

      renderScreenshots([
        ...(currentMatch.screenshots || []),
        data.screenshot
      ]);

      currentMatch.screenshots ||= [];

      currentMatch.screenshots.push(
        data.screenshot
      );

      notify(
        "Скриншот отправлен администратору."
      );

    } catch (err) {
      notify(err.message);
    }
  };

function renderScreenshots(
  screenshots
) {
  $("uploadedScreenshots")
    .innerHTML =
      screenshots
        .map(
          shot => `
            <div class="screenshot-preview">

              <a
                href="${shot.url}"
                target="_blank"
              >
                <img
                  src="${shot.url}"
                >
              </a>

              <div>
                ${escapeHTML(
                  shot.nickname
                )}
              </div>

            </div>
          `
        )
        .join("");
}

/* =========================================================
   MATCH RESOLVED
========================================================= */

socket.on(
  "matchResolved",
  async data => {

    notify(
      `Матч ${data.matchId} обработан администратором.`
    );

    $("gameModal").style.display =
      "none";

    await refreshMe();
  }
);

/* =========================================================
   PLAYER PROFILE
========================================================= */

async function openPlayerProfile(
  userId
) {
  try {
    const data =
      await api(
        `/api/user/${encodeURIComponent(
          userId
        )}`
      );

    const user =
      data.user;

    const s =
      user.stats;

    $("playerProfile")
      .innerHTML =
      `
      <div style="text-align:center">

        <img
          src="${avatar(user)}"
          style="
            width:100px;
            height:100px;
            border-radius:50%;
            object-fit:cover;
            border:2px solid #3b82f6;
          "
        >

        <h2>
          ${
            user.isAdmin
              ? '<span class="admin-prefix">ADMIN</span>'
              : ""
          }

          ${escapeHTML(
            user.inGameNick
          )}

          ${escapeHTML(
            user.sticker || ""
          )}
        </h2>

        <p>
          ID игры:
          ${escapeHTML(
            user.inGameId
          )}
        </p>

        <p>
          ID сайта:
          ${escapeHTML(
            user.id
          )}
        </p>

      </div>

      <div class="profile-grid">

        ${profileMode(
          "1v1",
          s["1v1"]
        )}

        ${profileMode(
          "2v2",
          s["2v2"]
        )}

        ${profileMode(
          "5v5",
          s["5v5"]
        )}

      </div>

      ${
        user.id !==
        currentUser.id
          ? `
            <button
              onclick="addFriend('${user.id}')"
            >
              Добавить в друзья
            </button>

            <button
              onclick="reportPlayer('${user.id}')"
              class="danger"
            >
              Пожаловаться
            </button>
          `
          : ""
      }

      <br><br>

      <button
        id="playerCloseButton"
        class="close-profile-btn"
      >
        Выйти
      </button>
    `;

    $("playerModal").style.display =
      "flex";

    $("playerCloseButton").onclick =
      () => {
        $("playerModal").style.display =
          "none";
      };

  } catch (err) {
    notify(err.message);
  }
}

window.openPlayerProfile =
  openPlayerProfile;

$("closePlayerModal").onclick =
  () => {
    $("playerModal").style.display =
      "none";
  };

async function addFriend(
  userId
) {
  try {
    await post(
      "/api/friend-request",
      {
        fromUserId:
          currentUser.id,

        toUserId:
          userId
      }
    );

    notify(
      "Заявка отправлена."
    );

  } catch (err) {
    notify(err.message);
  }
}

window.addFriend =
  addFriend;

async function reportPlayer(
  userId
) {
  const reason = await uiPrompt("Новая жалоба", "Опишите нарушение игрока.", "Причина жалобы");
  if (!reason) return;

  try {
    await post(
      "/api/report",
      {
        reporterId:
          currentUser.id,

        targetId:
          userId,

        reason
      }
    );

    notify(
      "Жалоба отправлена."
    );

  } catch (err) {
    notify(err.message);
  }
}

window.reportPlayer =
  reportPlayer;

/* =========================================================
   FRIENDS
========================================================= */

$("friendSearchBtn").onclick =
  searchFriends;

async function searchFriends() {
  const q =
    $("friendSearchInput")
      .value
      .trim();

  if (!q) return;

  try {
    const data =
      await api(
        `/api/search-users?q=${encodeURIComponent(
          q
        )}`
      );

    $("friendSearchResults")
      .innerHTML =
      data.users
        .map(
          user => `
            <div class="search-result">

              <img src="${avatar(
                user
              )}">

              <div class="friend-info">

                <b>
                  ${escapeHTML(
                    user.inGameNick
                  )}
                </b>

                <small>
                  ID:
                  ${escapeHTML(
                    user.inGameId
                  )}
                </small>

              </div>

              <button
                onclick="openPlayerProfile('${user.id}')"
              >
                Профиль
              </button>

              <button
                onclick="addFriend('${user.id}')"
              >
                Добавить
              </button>

            </div>
          `
        )
        .join("");

  } catch (err) {
    notify(err.message);
  }
}

async function loadFriends() {
  try {
    const data =
      await api(
        `/api/friends?userId=${currentUser.id}`
      );

    $("friendsList")
      .innerHTML =
      data.friends.length
        ? data.friends
            .map(
              friend => `
                <div class="friend-card">

                  <img
                    src="${avatar(
                      friend
                    )}"
                  >

                  <div class="friend-info">

                    <b>
                      ${escapeHTML(
                        friend.inGameNick
                      )}
                    </b>

                  </div>

                  <button
                    onclick="openPlayerProfile('${friend.id}')"
                  >
                    Профиль
                  </button>

                </div>
              `
            )
            .join("")
        : "<p>Друзей пока нет.</p>";

    $("friendRequests")
      .innerHTML =
      data.requests.length
        ? data.requests
            .map(
              user => `
                <div class="friend-card">

                  <img
                    src="${avatar(
                      user
                    )}"
                  >

                  <div class="friend-info">
                    ${escapeHTML(
                      user.inGameNick
                    )}
                  </div>

                  <button
                    onclick="acceptFriend('${user.id}')"
                  >
                    Принять
                  </button>

                  <button
                    class="danger"
                    onclick="rejectFriend('${user.id}')"
                  >
                    Отклонить
                  </button>

                </div>
              `
            )
            .join("")
        : "<p>Заявок нет.</p>";

  } catch (err) {
    notify(err.message);
  }
}

async function acceptFriend(
  friendId
) {
  try {
    await post(
      "/api/friend-accept",
      {
        userId:
          currentUser.id,

        friendId
      }
    );

    loadFriends();

  } catch (err) {
    notify(err.message);
  }
}

window.acceptFriend =
  acceptFriend;

async function rejectFriend(
  friendId
) {
  try {
    await post(
      "/api/friend-reject",
      {
        userId:
          currentUser.id,

        friendId
      }
    );

    loadFriends();

  } catch (err) {
    notify(err.message);
  }
}

window.rejectFriend =
  rejectFriend;

socket.on(
  "friendChanged",
  loadFriends
);

socket.on(
  "friendRequest",
  () => {
    notify(
      "Новая заявка в друзья."
    );

    loadFriends();
  }
);

/* =========================================================
   CHAT
========================================================= */

$("chatSendBtn").onclick =
  sendChat;

$("chatInput").onkeydown =
  event => {
    if (
      event.key === "Enter"
    ) {
      sendChat();
    }
  };

function sendChat() {
  const text =
    $("chatInput")
      .value
      .trim();

  if (!text) return;

  socket.emit(
    "chatMessage",
    text
  );

  $("chatInput").value =
    "";
}

socket.on(
  "chatHistory",
  messages => {

    $("chatMessages")
      .innerHTML = "";

    messages.forEach(
      renderChatMessage
    );
  }
);

socket.on(
  "chatMessage",
  renderChatMessage
);

function renderChatMessage(
  msg
) {
  if (!msg) return;

  let text =
    msg.text;

  if (
    typeof text === "object" &&
    text !== null
  ) {
    text =
      text.text ||
      text.message ||
      "";
  }

  const name =
    msg.nickname ||
    msg.inGameNick ||
    msg.username ||
    "Игрок";

  const prefix =
    msg.isAdmin
      ? '<span class="admin-prefix">ADMIN</span>'
      : "";

  const sticker =
    msg.sticker || "";

  const html =
    `
      <div class="chat-message">

        <img
          src="${avatar(msg)}"
        >

        <div class="chat-message-content">

          <div>
            ${prefix}

            <span class="chat-name">
              ${escapeHTML(
                name
              )}
            </span>

            ${escapeHTML(
              sticker
            )}
          </div>

          <div>
            ${escapeHTML(
              String(text || "")
            )}
          </div>

        </div>

      </div>
    `;

  $("chatMessages")
    .insertAdjacentHTML(
      "beforeend",
      html
    );

  $("chatMessages")
    .scrollTop =
    $("chatMessages")
      .scrollHeight;
}

/* =========================================================
   TOP
========================================================= */

document
  .querySelectorAll(
    ".top-mode"
  )
  .forEach(button => {

    button.onclick =
      () => {

        document
          .querySelectorAll(
            ".top-mode"
          )
          .forEach(
            b =>
              b.classList.remove(
                "active"
              )
          );

        button.classList.add(
          "active"
        );

        currentTopMode =
          button.dataset.mode;

        loadTop();
      };

  });

async function loadTop() {
  try {
    const data =
      await api(
        `/api/top?mode=${currentTopMode}`
      );

    $("topList")
      .innerHTML =
      data.users
        .map(
          (user, index) => `
            <div class="top-player">

              <b>
                #${index + 1}
              </b>

              <img
                src="${avatar(
                  user
                )}"
              >

              <div class="top-player-info">

                <b>
                  ${
                    user.isAdmin
                      ? '<span class="admin-prefix">ADMIN</span>'
                      : ""
                  }

                  ${escapeHTML(
                    user.inGameNick
                  )}
                </b>

                <div>
                  Уровень
                  ${user.level}
                </div>

              </div>

              <div class="top-elo">
                ${user.elo} ELO
              </div>

            </div>
          `
        )
        .join("");

  } catch (err) {
    notify(err.message);
  }
}

/* =========================================================
   CLAN
========================================================= */

async function loadClan() {
  try {
    const data =
      await api(
        `/api/clan?userId=${currentUser.id}`
      );

    if (!data.clan) {
      $("clanContent")
        .innerHTML =
        `
          <h3>Вы не состоите в клане</h3>

          <p>
            Система кланов уже подключена.
          </p>

          <p>
            Создание клана можно расширить
            через админ-панель.
          </p>
        `;

      return;
    }

    $("clanContent")
      .innerHTML =
      `
        <h3>
          [${escapeHTML(
            data.clan.tag
          )}]
          ${escapeHTML(
            data.clan.name
          )}
        </h3>

        <p>
          Участников:
          ${data.clan.members.length}
        </p>

        ${data.clan.members
          .map(
            member => `
              <div class="party-member">

                <img
                  src="${avatar(
                    member
                  )}"
                >

                ${escapeHTML(
                  member.inGameNick
                )}

              </div>
            `
          )
          .join("")}
      `;

  } catch (err) {
    notify(err.message);
  }
}

/* =========================================================
   ADMIN
========================================================= */

async function loadAdmin() {
  if (!currentUser?.isAdmin) {
    return;
  }

  try {
    const stats =
      await api(
        `/api/admin/stats?adminId=${currentUser.id}`
      );

    $("adminStats")
      .innerHTML =
      `
        <div class="stat-card">
          <h3>Онлайн</h3>
          <b>${stats.online}</b>
        </div>

        <div class="stat-card">
          <h3>Пользователи</h3>
          <b>${stats.users}</b>
        </div>

        <div class="stat-card">
          <h3>Репорты</h3>
          <b>${stats.reports}</b>
        </div>
      `;

    await loadAdminMatches();
    await loadAdminReports();
    await loadAdminUsers();

  } catch (err) {
    notify(err.message);
  }
}

async function loadAdminMatches() {
  const data =
    await api(
      `/api/admin/matches?adminId=${currentUser.id}`
    );

  $("adminMatches")
    .innerHTML =
    data.matches
      .map(
        match => `
          <div class="admin-match">

            <h4>
              Матч:
              ${escapeHTML(
                match.id
              )}
            </h4>

            <p>
              ${match.mode}
              ·
              ${
                match.ranked
                  ? "Ранговый"
                  : "Обычный"
              }
            </p>

            <div class="admin-team">

              <b>Команда A</b>

              ${match.teamA
                .map(
                  player => `
                    <div class="admin-player">

                      <img
                        src="${avatar(
                          player
                        )}"
                      >

                      ${escapeHTML(
                        player.inGameNick
                      )}

                    </div>
                  `
                )
                .join("")}

            </div>

            <div class="admin-team">

              <b>Команда B</b>

              ${match.teamB
                .map(
                  player => `
                    <div class="admin-player">

                      <img
                        src="${avatar(
                          player
                        )}"
                      >

                      ${escapeHTML(
                        player.inGameNick
                      )}

                    </div>
                  `
                )
                .join("")}

            </div>

            <h4>
              Скриншоты
            </h4>

            ${
              match.screenshots
                ?.map(
                  shot => `
                    <div
                      class="screenshot-preview"
                    >

                      <a
                        href="${shot.url}"
                        target="_blank"
                      >

                        <img
                          src="${shot.url}"
                        >

                      </a>

                      <div>
                        ${escapeHTML(
                          shot.nickname
                        )}
                      </div>

                    </div>
                  `
                )
                .join("") ||
              "<p>Скриншотов пока нет.</p>"
            }

            ${!match.resolved ? `
              <div class="elo-control-card">
                <b>Изменение ELO каждому игроку</b>
                <p class="muted">Положительное число — добавить ELO, отрицательное — снять. Базовое значение: 0.</p>
                ${match.participants.map(p => `<label class="elo-control-row"><span>${escapeHTML(p.inGameNick || "Игрок")}</span><input type="number" data-elo-match="${escapeHTML(match.id)}" data-user-id="${escapeHTML(p.id)}" value="0" step="1"></label>`).join("")}
              </div>
              <div class="admin-result-buttons">
                <button class="success" ${!(match.screenshots||[]).length?'disabled':''} onclick="resolveAdminMatch('${match.id}', 'A')">Победа команды A</button>
                <button class="success" ${!(match.screenshots||[]).length?'disabled':''} onclick="resolveAdminMatch('${match.id}', 'B')">Победа команды B</button>
              </div>
              ${!(match.screenshots||[]).length ? '<p class="muted">Нельзя закрыть матч без скриншота.</p>' : ''}
            ` : `<p class="resolved-badge">Матч обработан • победа команды ${escapeHTML(match.winnerTeam || "—")}</p>`}

          </div>
        `
      )
      .join("");
}

window.resolveAdminMatch = async function(matchId, winnerTeam) {
  const inputs = [...document.querySelectorAll(`[data-elo-match="${CSS.escape(matchId)}"]`)];
  const eloChanges = {};
  inputs.forEach(input => { eloChanges[input.dataset.userId] = Number(input.value || 0); });
  const ok = await uiConfirm(`Команда ${winnerTeam} победила?`, "Проверьте скриншот и введённые изменения ELO. После подтверждения матч будет закрыт.");
  if (!ok) return;
  try {
    await post(`/api/admin/match/${encodeURIComponent(matchId)}/resolve`, { adminId: currentUser.id, winnerTeam, eloChanges });
    notify("Матч обработан. Статистика и ELO сохранены.");
    await loadAdmin();
  } catch (err) { notify(err.message); }
};

async function loadAdminReports() {
  const data =
    await api(
      `/api/admin/reports?adminId=${currentUser.id}`
    );

  $("adminReports")
    .innerHTML =
    data.reports
      .map(
        report => `
          <div class="report-card">

            <b>
              ${escapeHTML(
                report.id
              )}
            </b>

            <p>
              От:
              ${escapeHTML(
                report.reporter?.inGameNick ||
                "Игрок"
              )}
            </p>

            <p>
              На:
              ${escapeHTML(
                report.target?.inGameNick ||
                "Игрок"
              )}
            </p>

            <p>
              Причина:
              ${escapeHTML(
                report.reason
              )}
            </p>

            <p class="report-status">
              Статус:
              ${report.status}
            </p>

            ${
              report.status === "open"
                ? `
                  <button
                    onclick="closeReport('${report.id}')"
                  >
                    Закрыть репорт
                  </button>
                `
                : ""
            }

          </div>
        `
      )
      .join("");
}

window.closeReport =
  async function (
    reportId
  ) {

    try {
      await post(
        `/api/admin/report/${encodeURIComponent(
          reportId
        )}`,
        {
          adminId:
            currentUser.id,

          status:
            "closed"
        }
      );

      loadAdmin();

    } catch (err) {
      notify(err.message);
    }
  };

async function loadAdminUsers() {
  const data =
    await api(
      `/api/admin/users?adminId=${currentUser.id}`
    );

  $("adminUsers")
    .innerHTML =
    data.users
      .map(
        user => `
          <div class="admin-user">

            <img
              src="${avatar(
                user
              )}"
            >

            <div>

              <b>
                ${
                  user.isAdmin
                    ? '<span class="admin-prefix">ADMIN</span>'
                    : ""
                }

                ${escapeHTML(
                  user.inGameNick
                )}
              </b>

              <div>
                ID:
                ${escapeHTML(
                  user.id
                )}
              </div>

              <div>
                ELO:
                ${user.stats["1v1"].elo}
              </div>

            </div>

          </div>
        `
      )
      .join("");
}

/* =========================================================
   SOCKET
========================================================= */

socket.on(
  "connect",
  () => {

    if (currentUser) {
      socket.emit(
        "auth",
        currentUser.id
      );
    }

  }
);

socket.on(
  "partyUpdate",
  party => {

    currentParty =
      party;

    renderParty();

  }
);

socket.on(
  "userUpdated",
  user => {

    if (
      currentUser &&
      String(user.id) ===
        String(currentUser.id)
    ) {

      currentUser =
        user;

      renderEverything();
    }

  }
);

socket.on(
  "chatError",
  data => {
    notify(
      data.message ||
      "Ошибка чата."
    );
  }
);

socket.on(
  "screenshotAdded",
  data => {

    if (
      currentMatch &&
      currentMatch.matchId ===
        data.matchId
    ) {

      currentMatch.screenshots ||=
        [];

      currentMatch.screenshots.push(
        data.screenshot
      );

      renderScreenshots(
        currentMatch.screenshots
      );
    }

  }
);

/* =========================================================
   LOGOUT
========================================================= */

$("logoutBtn").onclick =
  () => {

    clearSession();

    currentUser =
      null;

    currentParty =
      null;

    currentMatch =
      null;

    showLogin();
  };

/* =========================================================
   START
========================================================= */

restoreSession();
/* BUILD FIX 2026.10.02-fix1: visible runtime errors instead of silent dead UI. */
window.addEventListener("error", event => {
  const msg = event?.error?.message || event?.message || "Неизвестная ошибка интерфейса.";
  try { notify("Ошибка интерфейса: " + msg); } catch {}
  console.error("Legend Pl UI error:", event.error || event.message);
});
window.addEventListener("unhandledrejection", event => {
  const reason = event?.reason?.message || event?.reason || "Неизвестная ошибка запроса.";
  try { notify("Ошибка: " + String(reason)); } catch {}
  console.error("Legend Pl promise error:", event.reason);
});
