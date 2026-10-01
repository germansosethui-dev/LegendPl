const socket = io();

let currentUser = null;
let currentParty = null;
let currentMatch = null;

let queueState = {};

let matchTimer = null;

const $ = id =>
  document.getElementById(id);

/* =========================================================
   HELPERS
========================================================= */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function text(value) {
  return String(value ?? '');
}

async function api(
  url,
  method = 'GET',
  body = null
) {
  try {
    const options = {
      method,
      headers: {}
    };

    if (body !== null) {
      options.headers['Content-Type'] =
        'application/json';

      options.body =
        JSON.stringify(body);
    }

    const response =
      await fetch(url, options);

    return await response.json();

  } catch (err) {

    console.error(err);

    return {
      success: false,
      message:
        'Ошибка соединения с сервером'
    };
  }
}

function avatar(user) {

  if (
    user &&
    user.avatar &&
    String(user.avatar).trim()
  ) {
    return user.avatar;
  }

  return 'data:image/svg+xml;charset=UTF-8,' +
    encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg"
           width="80"
           height="80">
        <rect width="80"
              height="80"
              rx="40"
              fill="#263750"/>
        <text x="40"
              y="48"
              text-anchor="middle"
              fill="#94a3b8"
              font-size="30">
          ?
        </text>
      </svg>
    `);
}

function showNotification(
  message,
  type = 'info'
) {

  let box =
    $('notifications');

  if (!box) {
    box =
      document.createElement('div');

    box.id =
      'notifications';

    document.body.appendChild(box);
  }

  const item =
    document.createElement('div');

  item.className =
    `notification ${type}`;

  item.textContent =
    String(message);

  box.appendChild(item);

  setTimeout(() => {
    item.remove();
  }, 4500);
}

/* =========================================================
   LEVEL
========================================================= */

function getLevel(mmr) {

  if (mmr >= 2000) return 10;
  if (mmr >= 1800) return 9;
  if (mmr >= 1600) return 8;
  if (mmr >= 1400) return 7;
  if (mmr >= 1250) return 6;
  if (mmr >= 1100) return 5;
  if (mmr >= 950) return 4;
  if (mmr >= 800) return 3;
  if (mmr >= 650) return 2;

  return 1;
}

/* =========================================================
   AUTH
========================================================= */

function showLogin() {

  $('loginForm').style.display =
    'block';

  $('registerForm').style.display =
    'none';
}

function showRegister() {

  $('loginForm').style.display =
    'none';

  $('registerForm').style.display =
    'block';
}

async function login() {

  const username =
    $('loginUsername').value.trim();

  const password =
    $('loginPassword').value;

  if (!username || !password) {
    $('authMessage').textContent =
      'Введите логин и пароль';

    return;
  }

  $('authMessage').textContent =
    'Выполняется вход...';

  const result =
    await api(
      '/api/login',
      'POST',
      {
        username,
        password
      }
    );

  if (!result.success) {

    $('authMessage').textContent =
      result.message ||
      'Ошибка входа';

    return;
  }

  await enterAccount(
    result.userData
  );
}

async function register() {

  const username =
    $('regUsername').value.trim();

  const password =
    $('regPassword').value;

  const confirm =
    $('regPasswordConfirm').value;

  const inGameNick =
    $('regInGameNick').value.trim();

  const inGameId =
    $('regInGameId').value.trim();

  if (
    !username ||
    !password ||
    !inGameNick ||
    !inGameId
  ) {
    $('authMessage').textContent =
      'Заполните все поля';

    return;
  }

  if (password !== confirm) {
    $('authMessage').textContent =
      'Пароли не совпадают';

    return;
  }

  const result =
    await api(
      '/api/register',
      'POST',
      {
        username,
        password,
        inGameNick,
        inGameId
      }
    );

  $('authMessage').textContent =
    result.message || '';

  if (result.success) {

    $('loginUsername').value =
      username;

    showLogin();
  }
}

async function enterAccount(user) {

  currentUser = user;

  localStorage.setItem(
    'userId',
    user.id
  );

  $('loginScreen').style.display =
    'none';

  $('mainScreen').style.display =
    'flex';

  updateUI();

  socket.emit(
    'auth',
    user.id
  );

  await restoreParty();

  await loadFriends();

  await loadTop();

  await loadClan();

  await loadChat();
}

async function tryAutoLogin() {

  const id =
    localStorage.getItem(
      'userId'
    );

  if (!id) return;

  const result =
    await api(
      `/api/user/${encodeURIComponent(id)}`
    );

  if (
    result.success &&
    result.userData
  ) {
    await enterAccount(
      result.userData
    );
  } else {
    localStorage.removeItem(
      'userId'
    );
  }
}

/* =========================================================
   UI
========================================================= */

function updateUI() {

  if (!currentUser) return;

  $('nickname').textContent =
    currentUser.inGameNick;

  $('avatar').src =
    avatar(currentUser);

  $('streakCount').textContent =
    currentUser.stats.streak || 0;

  renderProfile();
  renderHistory();
}

function renderProfile() {

  if (!currentUser) return;

  const stats =
    currentUser.stats;

  $('profileHeader').innerHTML = `
    <div class="stat-card">
      <h3>${escapeHtml(currentUser.inGameNick)}</h3>

      <div class="stat-row">
        <span>Ник на сайте</span>
        <strong>${escapeHtml(currentUser.username)}</strong>
      </div>

      <div class="stat-row">
        <span>ID на сайте</span>
        <strong>${currentUser.id}</strong>
      </div>

      <div class="stat-row">
        <span>ID в игре</span>
        <strong>${escapeHtml(currentUser.inGameId)}</strong>
      </div>

      <div class="stat-row">
        <span>Общие матчи</span>
        <strong>${stats.totalMatches}</strong>
      </div>

      <div class="stat-row">
        <span>Победы</span>
        <strong>${stats.totalWins}</strong>
      </div>

      <div class="stat-row">
        <span>Поражения</span>
        <strong>${stats.totalLosses}</strong>
      </div>

      <div class="stat-row">
        <span>Стрик</span>
        <strong>🔥 ${stats.streak}</strong>
      </div>
    </div>
  `;

  $('profileStats').innerHTML =
    ['1v1', '2v2', '5v5']
      .map(mode => {

        const s =
          stats[mode];

        const kd =
          s.deaths > 0
            ? (
              s.kills /
              s.deaths
            ).toFixed(2)
            : s.kills.toFixed(2);

        const winrate =
          s.matches
            ? Math.round(
                s.wins /
                s.matches *
                100
              )
            : 0;

        return `
          <div class="stat-card">

            <h3>${mode}</h3>

            <div class="stat-row">
              <span>Рейтинг (ELO)</span>
              <strong>${s.mmr}</strong>
            </div>

            <div class="stat-row">
              <span>Уровень</span>
              <strong>${getLevel(s.mmr)}</strong>
            </div>

            <div class="stat-row">
              <span>Матчи</span>
              <strong>${s.matches}</strong>
            </div>

            <div class="stat-row">
              <span>Победы</span>
              <strong>${s.wins}</strong>
            </div>

            <div class="stat-row">
              <span>Поражения</span>
              <strong>${s.losses}</strong>
            </div>

            <div class="stat-row">
              <span>Winrate</span>
              <strong>${winrate}%</strong>
            </div>

            <div class="stat-row">
              <span>Стрик</span>
              <strong>${s.streak}</strong>
            </div>

            <div class="stat-row">
              <span>Лучший стрик</span>
              <strong>${s.bestStreak}</strong>
            </div>

            <div class="stat-row">
              <span>K/D</span>
              <strong>${kd}</strong>
            </div>

            <div class="stat-row">
              <span>Обычные победы</span>
              <strong>${s.unrankedWins}</strong>
            </div>

            <div class="stat-row">
              <span>Ранговые победы</span>
              <strong>${s.rankedWins}</strong>
            </div>

          </div>
        `;
      })
      .join('');
}

function renderHistory() {

  const list =
    currentUser?.stats?.matchHistory ||
    [];

  if (!list.length) {

    $('matchList').innerHTML =
      '<div class="stat-card">Матчей пока нет.</div>';

    return;
  }

  $('matchList').innerHTML =
    list.map(match => `
      <div class="stat-card">
        <strong>
          ${escapeHtml(match.mode)}
          ${match.ranked ? ' • Ранговый' : ' • Обычный'}
        </strong>

        <div class="stat-row">
          <span>Карта</span>
          <span>${escapeHtml(match.map)}</span>
        </div>

        <div class="stat-row">
          <span>Результат</span>
          <strong>${escapeHtml(match.result)}</strong>
        </div>

        <small>
          ${escapeHtml(match.date)}
        </small>
      </div>
    `)
    .join('');
}

/* =========================================================
   NAVIGATION
========================================================= */

function setupNavigation() {

  const views = [
    'play',
    'profile',
    'history',
    'friends',
    'chat',
    'top',
    'clan',
    'about'
  ];

  document
    .querySelectorAll('.nav-btn')
    .forEach(button => {

      button.addEventListener(
        'click',
        async () => {

          const target =
            button.dataset.view;

          document
            .querySelectorAll('.nav-btn')
            .forEach(btn =>
              btn.classList.remove(
                'active'
              )
            );

          button.classList.add(
            'active'
          );

          for (
            const view
            of views
          ) {

            const element =
              $(`${view}View`);

            if (element) {
              element.style.display =
                view === target
                  ? 'block'
                  : 'none';
            }
          }

          document
            .querySelector(
              '.sidebar'
            )
            ?.classList.remove(
              'mobile-open'
            );

          if (target === 'friends') {
            await loadFriends();
          }

          if (target === 'top') {
            await loadTop();
          }

          if (target === 'clan') {
            await loadClan();
          }

          if (target === 'chat') {
            await loadChat();
          }
        }
      );
    });
}

/* =========================================================
   PARTY
========================================================= */

async function restoreParty() {

  if (!currentUser) return;

  const result =
    await api(
      `/api/my-party?userId=${encodeURIComponent(currentUser.id)}`
    );

  if (
    result.success &&
    result.party
  ) {

    currentParty =
      result.party;

    renderParty();
  }
}

async function createParty() {

  const result =
    await api(
      '/api/create-party',
      'POST',
      {
        leaderId:
          currentUser.id
      }
    );

  if (!result.success) {

    if (result.party) {
      currentParty =
        result.party;

      renderParty();
    }

    showNotification(
      result.message,
      'error'
    );

    return;
  }

  currentParty =
    result.party;

  renderParty();

  showNotification(
    `Пати создана. Код: ${currentParty.id}`,
    'success'
  );
}

async function joinParty() {

  const code =
    $('joinPartyCode')
      .value
      .trim()
      .toUpperCase();

  if (!code) return;

  const result =
    await api(
      '/api/join-party',
      'POST',
      {
        partyId: code,
        userId: currentUser.id
      }
    );

  if (!result.success) {

    showNotification(
      result.message,
      'error'
    );

    return;
  }

  currentParty =
    result.party;

  renderParty();

  showNotification(
    'Вы вошли в пати',
    'success'
  );
}

async function leaveParty() {

  if (!currentParty) return;

  const result =
    await api(
      '/api/leave-party',
      'POST',
      {
        partyId:
          currentParty.id,

        userId:
          currentUser.id
      }
    );

  if (result.success) {

    currentParty = null;

    renderParty();

    showNotification(
      'Вы вышли из пати',
      'success'
    );
  }
}

function renderParty() {

  if (!currentParty) {

    $('partyStatus').innerHTML =
      '';

    $('partyMembers').style.display =
      'none';

    return;
  }

  $('partyStatus').innerHTML = `
    <div class="party-status">
      Вы в пати.
      Участников:
      <strong>${currentParty.members.length}/5</strong>

      <br>

      Код:
      <strong>${escapeHtml(currentParty.id)}</strong>

      <button id="copyPartyBtn">
        Копировать
      </button>

      <button id="leavePartyBtn">
        Выйти
      </button>
    </div>
  `;

  $('copyPartyBtn')
    .onclick = async () => {

      await navigator.clipboard
        ?.writeText(
          currentParty.id
        );

      showNotification(
        'Код скопирован',
        'success'
      );
    };

  $('leavePartyBtn')
    .onclick =
      leaveParty;

  $('partyMembers').style.display =
    'block';

  const list =
    $('partyMembersList');

  list.innerHTML = '';

  currentParty.members
    .forEach(async userId => {

      const result =
        await api(
          `/api/user/${encodeURIComponent(userId)}`
        );

      if (!result.success) return;

      const user =
        result.userData;

      const div =
        document.createElement('div');

      div.className =
        'party-member';

      div.innerHTML = `
        <img
          src="${avatar(user)}"
          class="mini-avatar"
          data-profile-id="${user.id}"
        >

        <div style="flex:1;">
          <strong>
            ${escapeHtml(user.inGameNick)}
          </strong>

          <small>
            ID: ${escapeHtml(user.inGameId)}
          </small>
        </div>

        ${
          user.id !== currentUser.id
            ? `
              <button
                class="add-party-friend"
                data-user-id="${user.id}"
              >
                Добавить в друзья
              </button>
            `
            : ''
        }
      `;

      list.appendChild(div);
    });
}

/* =========================================================
   QUEUE
========================================================= */

function updateQueueUI() {

  if (!currentUser) return;

  for (
    const mode
    of ['1v1', '2v2', '5v5']
  ) {

    for (
      const ranked
      of [false, true]
    ) {

      const key =
        `${mode}_${ranked ? 'ranked' : 'unranked'}`;

      const queue =
        queueState[key] || [];

      const needed =
        mode === '1v1'
          ? 2
          : mode === '2v2'
            ? 4
            : 10;

      const count =
        $(
          `queue-count-${mode}-${ranked ? 'ranked' : 'unranked'}`
        );

      const status =
        $(
          `queue-status-${mode}-${ranked ? 'ranked' : 'unranked'}`
        );

      const leave =
        document.querySelector(
          `.leave-queue-btn[data-mode="${mode}"][data-ranked="${ranked}"]`
        );

      if (count) {
        count.textContent =
          `${queue.length}/${needed}`;
      }

      const inQueue =
        queue.some(
          item =>
            item.userId ===
            currentUser.id
        );

      if (status) {
        status.textContent =
          inQueue
            ? 'В очереди'
            : 'Не в очереди';
      }

      if (leave) {
        leave.style.display =
          inQueue
            ? 'block'
            : 'none';
      }
    }
  }
}

function joinQueue(
  mode,
  ranked
) {

  socket.emit(
    'joinQueue',
    {
      mode,
      ranked,
      partyId:
        currentParty?.id ||
        null
    }
  );
}

function leaveQueue(
  mode,
  ranked
) {

  socket.emit(
    'leaveQueue',
    {
      mode,
      ranked
    }
  );
}

/* =========================================================
   MATCH FOUND
========================================================= */

function closeMatchModal() {

  const modal =
    $('matchModal');

  if (modal) {
    modal.remove();
  }

  if (matchTimer) {
    clearInterval(
      matchTimer
    );

    matchTimer = null;
  }
}

async function showMatchFound(match) {

  closeMatchModal();

  currentMatch =
    match;

  const modal =
    document.createElement('div');

  modal.id =
    'matchModal';

  modal.className =
    'modal';

  modal.innerHTML = `
    <div class="modal-content">

      <h2>🎮 Матч найден!</h2>

      <p>
        Режим:
        <strong>
          ${escapeHtml(match.mode)}
          ${match.ranked ? ' — Ранговый' : ' — Обычный'}
        </strong>
      </p>

      <p>
        Карта:
        <strong>
          ${escapeHtml(match.map)}
        </strong>
      </p>

      <div id="matchParticipants"></div>

      <div class="match-timer">
        <span id="matchTimer">
          20
        </span>
        сек
      </div>

      <div class="match-buttons">

        <button
          id="acceptMatchBtn"
          class="accept-btn"
        >
          Принять
        </button>

        <button
          id="declineMatchBtn"
          class="decline-btn"
        >
          Отклонить
        </button>

      </div>

    </div>
  `;

  document.body.appendChild(
    modal
  );

  const participants =
    $('matchParticipants');

  for (
    const id
    of match.participants
  ) {

    const result =
      await api(
        `/api/user/${encodeURIComponent(id)}`
      );

    if (!result.success) continue;

    const user =
      result.userData;

    const div =
      document.createElement('div');

    div.className =
      'match-participant';

    div.innerHTML = `
      <img
        src="${avatar(user)}"
        class="match-avatar"
        data-profile-id="${user.id}"
      >

      <div>
        <strong>
          ${escapeHtml(user.inGameNick)}
        </strong>

        <br>

        <small>
          ID: ${escapeHtml(user.inGameId)}
        </small>
      </div>
    `;

    participants.appendChild(
      div
    );
  }

  let seconds = 20;

  matchTimer =
    setInterval(() => {

      seconds--;

      const timer =
        $('matchTimer');

      if (timer) {
        timer.textContent =
          Math.max(
            0,
            seconds
          );
      }

      if (seconds <= 0) {
        clearInterval(
          matchTimer
        );

        matchTimer = null;

        socket.emit(
          'declineMatch',
          {
            matchId:
              match.matchId
          }
        );

        closeMatchModal();
      }

    }, 1000);

  $('acceptMatchBtn')
    .onclick = () => {

      socket.emit(
        'acceptMatch',
        {
          matchId:
            match.matchId
        }
      );

      $('acceptMatchBtn')
        .disabled = true;

      $('acceptMatchBtn')
        .textContent =
        'Ожидание остальных...';
    };

  $('declineMatchBtn')
    .onclick = () => {

      socket.emit(
        'declineMatch',
        {
          matchId:
            match.matchId
        }
      );

      closeMatchModal();
    };
}

/* =========================================================
   MATCH LOBBY
========================================================= */

async function openMatchLobby(
  match
) {

  closeMatchModal();

  currentMatch =
    match;

  const old =
    $('lobbyModal');

  old?.remove();

  const modal =
    document.createElement('div');

  modal.id =
    'lobbyModal';

  modal.className =
    'modal';

  modal.innerHTML = `
    <div class="modal-content">

      <h2>🎮 Матч начался</h2>

      <p>
        ${escapeHtml(match.mode)}
        —
        ${match.ranked ? 'Ранговый' : 'Обычный'}
      </p>

      <p>
        Карта:
        <strong>
          ${escapeHtml(match.map)}
        </strong>
      </p>

      <div class="team-box">
        <h4>Команда A</h4>
        <div id="teamA"></div>
      </div>

      <div class="team-box">
        <h4>Команда B</h4>
        <div id="teamB"></div>
      </div>

      <div
        id="lobbyMessages"
        class="chat-messages"
        style="height:250px;margin-top:15px;"
      ></div>

      <div class="chat-input">

        <input
          id="lobbyInput"
          placeholder="Сообщение..."
        >

        <button id="lobbySend">
          Отправить
        </button>

      </div>

      <div
        class="team-box"
        style="margin-top:15px;"
      >

        <strong>
          Завершение матча
        </strong>

        <p style="margin-top:7px;">
          После завершения выберите победившую команду.
        </p>

        <div class="match-buttons">

          <button
            id="winTeamA"
            class="accept-btn"
          >
            Победа команды A
          </button>

          <button
            id="winTeamB"
            class="accept-btn"
          >
            Победа команды B
          </button>

        </div>

      </div>

    </div>
  `;

  document.body.appendChild(
    modal
  );

  await renderTeam(
    'teamA',
    match.teamA || []
  );

  await renderTeam(
    'teamB',
    match.teamB || []
  );

  $('lobbySend').onclick =
    sendLobbyMessage;

  $('lobbyInput')
    .addEventListener(
      'keydown',
      e => {
        if (e.key === 'Enter') {
          sendLobbyMessage();
        }
      }
    );

  $('winTeamA').onclick =
    () => finishMatch('A');

  $('winTeamB').onclick =
    () => finishMatch('B');
}

async function renderTeam(
  elementId,
  ids
) {

  const container =
    $(elementId);

  if (!container) return;

  container.innerHTML = '';

  for (
    const id
    of ids
  ) {

    const result =
      await api(
        `/api/user/${encodeURIComponent(id)}`
      );

    if (!result.success) continue;

    const user =
      result.userData;

    const div =
      document.createElement('div');

    div.className =
      'match-participant';

    div.innerHTML = `
      <img
        src="${avatar(user)}"
        class="match-avatar"
        data-profile-id="${user.id}"
      >

      <strong>
        ${escapeHtml(user.inGameNick)}
      </strong>
    `;

    container.appendChild(
      div
    );
  }
}

function sendLobbyMessage() {

  const input =
    $('lobbyInput');

  const value =
    input?.value.trim();

  if (!value) return;

  socket.emit(
    'lobbyChat',
    {
      matchId:
        currentMatch.matchId,

      text:
        value
    }
  );

  input.value = '';
}

async function finishMatch(
  winnerTeam
) {

  if (!currentMatch) return;

  const result =
    await api(
      '/api/finish-match',
      'POST',
      {
        matchId:
          currentMatch.matchId,

        winnerTeam
      }
    );

  if (!result.success) {

    showNotification(
      result.message,
      'error'
    );

    return;
  }

  document
    .getElementById(
      'lobbyModal'
    )
    ?.remove();

  currentMatch =
    null;

  const fresh =
    await api(
      `/api/user/${currentUser.id}`
    );

  if (fresh.success) {

    currentUser =
      fresh.userData;

    updateUI();
  }

  showNotification(
    'Результат матча сохранён',
    'success'
  );
}

/* =========================================================
   FRIENDS
========================================================= */

async function loadFriends() {

  if (!currentUser) return;

  $('friendsList').innerHTML =
    '';

  for (
    const id
    of currentUser.friends || []
  ) {

    const result =
      await api(
        `/api/user/${encodeURIComponent(id)}`
      );

    if (!result.success) continue;

    const user =
      result.userData;

    const div =
      document.createElement('div');

    div.className =
      'friend-item';

    div.innerHTML = `
      <img
        src="${avatar(user)}"
        class="friend-avatar"
        data-profile-id="${user.id}"
      >

      <div class="friend-info">

        <strong>
          ${escapeHtml(user.inGameNick)}
        </strong>

        <small>
          ID: ${escapeHtml(user.inGameId)}
        </small>

      </div>

      <div class="friend-actions">

        <button
          class="friend-profile-btn"
          data-user-id="${user.id}"
        >
          Профиль
        </button>

        <button
          class="invite-btn"
          data-user-id="${user.id}"
        >
          В пати
        </button>

        <button
          class="remove-friend-btn"
          data-user-id="${user.id}"
        >
          Удалить
        </button>

      </div>
    `;

    $('friendsList')
      .appendChild(div);
  }

  await loadFriendRequests();

  bindFriendButtons();
}

async function loadFriendRequests() {

  $('friendRequests').innerHTML =
    '';

  for (
    const id
    of currentUser.pendingRequests || []
  ) {

    const result =
      await api(
        `/api/user/${encodeURIComponent(id)}`
      );

    if (!result.success) continue;

    const user =
      result.userData;

    const div =
      document.createElement('div');

    div.className =
      'friend-item';

    div.innerHTML = `
      <img
        src="${avatar(user)}"
        class="friend-avatar"
      >

      <div class="friend-info">
        <strong>
          ${escapeHtml(user.inGameNick)}
        </strong>

        <small>
          ID: ${escapeHtml(user.inGameId)}
        </small>
      </div>

      <div class="friend-actions">

        <button
          class="accept-friend-btn"
          data-user-id="${user.id}"
        >
          Принять
        </button>

        <button
          class="reject-friend-btn"
          data-user-id="${user.id}"
        >
          Отклонить
        </button>

      </div>
    `;

    $('friendRequests')
      .appendChild(div);
  }

  document
    .querySelectorAll(
      '.accept-friend-btn'
    )
    .forEach(btn => {

      btn.onclick = () =>
        acceptFriend(
          btn.dataset.userId
        );
    });

  document
    .querySelectorAll(
      '.reject-friend-btn'
    )
    .forEach(btn => {

      btn.onclick = () =>
        rejectFriend(
          btn.dataset.userId
        );
    });
}

function bindFriendButtons() {

  document
    .querySelectorAll(
      '.friend-profile-btn'
    )
    .forEach(btn => {

      btn.onclick = () =>
        showProfile(
          btn.dataset.userId
        );
    });

  document
    .querySelectorAll(
      '.invite-btn'
    )
    .forEach(btn => {

      btn.onclick = () => {

        if (!currentParty) {

          showNotification(
            'Сначала создайте пати',
            'error'
          );

          return;
        }

        socket.emit(
          'inviteToParty',
          {
            partyId:
              currentParty.id,

            targetUserId:
              btn.dataset.userId
          }
        );

        showNotification(
          'Приглашение отправлено',
          'success'
        );
      };
    });

  document
    .querySelectorAll(
      '.remove-friend-btn'
    )
    .forEach(btn => {

      btn.onclick =
        async () => {

          const result =
            await api(
              '/api/remove-friend',
              'POST',
              {
                userId:
                  currentUser.id,

                friendId:
                  btn.dataset.userId
              }
            );

          if (result.success) {

            currentUser.friends =
              currentUser.friends
                .filter(
                  id =>
                    id !==
                    btn.dataset.userId
                );

            await loadFriends();

            showNotification(
              'Друг удалён',
              'success'
            );
          }
        };
    });
}

async function sendFriendRequest(
  userId
) {

  const result =
    await api(
      '/api/send-friend-request',
      'POST',
      {
        fromUserId:
          currentUser.id,

        toUserId:
          userId
      }
    );

  showNotification(
    result.message ||
      (
        result.success
          ? 'Заявка отправлена'
          : 'Ошибка'
      ),
    result.success
      ? 'success'
      : 'error'
  );
}

async function acceptFriend(
  userId
) {

  const result =
    await api(
      '/api/accept-friend',
      'POST',
      {
        userId:
          currentUser.id,

        friendId:
          userId
      }
    );

  if (result.success) {

    currentUser.friends.push(
      userId
    );

    currentUser.pendingRequests =
      currentUser.pendingRequests
        .filter(
          id =>
            id !== userId
        );

    await loadFriends();

    showNotification(
      'Заявка принята',
      'success'
    );
  }
}

async function rejectFriend(
  userId
) {

  const result =
    await api(
      '/api/reject-friend',
      'POST',
      {
        userId:
          currentUser.id,

        friendId:
          userId
      }
    );

  if (result.success) {

    currentUser.pendingRequests =
      currentUser.pendingRequests
        .filter(
          id =>
            id !== userId
        );

    await loadFriends();
  }
}

/* =========================================================
   FRIEND SEARCH
========================================================= */

async function searchFriends() {

  const q =
    $('friendSearchInput')
      .value
      .trim();

  if (!q) return;

  const result =
    await api(
      `/api/search-users?q=${encodeURIComponent(q)}`
    );

  const box =
    $('friendSearchResults');

  box.innerHTML =
    '';

  if (
    !result.success ||
    !result.users.length
  ) {

    box.innerHTML =
      '<div class="stat-card">Игроки не найдены.</div>';

    return;
  }

  result.users
    .filter(
      user =>
        user.id !==
        currentUser.id
    )
    .forEach(user => {

      const div =
        document.createElement('div');

      div.className =
        'friend-item';

      div.innerHTML = `
        <img
          src="${avatar(user)}"
          class="friend-avatar"
          data-profile-id="${user.id}"
        >

        <div class="friend-info">

          <strong>
            ${escapeHtml(user.inGameNick)}
          </strong>

          <small>
            ID: ${escapeHtml(user.inGameId)}
          </small>

        </div>

        <div class="friend-actions">

          <button
            class="search-profile"
            data-user-id="${user.id}"
          >
            Профиль
          </button>

          <button
            class="search-add"
            data-user-id="${user.id}"
          >
            Добавить в друзья
          </button>

        </div>
      `;

      box.appendChild(div);
    });

  box
    .querySelectorAll(
      '.search-profile'
    )
    .forEach(btn => {

      btn.onclick = () =>
        showProfile(
          btn.dataset.userId
        );
    });

  box
    .querySelectorAll(
      '.search-add'
    )
    .forEach(btn => {

      btn.onclick = () =>
        sendFriendRequest(
          btn.dataset.userId
        );
    });
}

/* =========================================================
   PROFILE OF PLAYER
========================================================= */

async function showProfile(
  userId
) {

  const result =
    await api(
      `/api/user/${encodeURIComponent(userId)}`
    );

  if (!result.success) {
    showNotification(
      'Игрок не найден',
      'error'
    );

    return;
  }

  const user =
    result.userData;

  const modal =
    document.createElement('div');

  modal.className =
    'modal';

  modal.innerHTML = `
    <div class="modal-content">

      <div style="text-align:center;">

        <img
          src="${avatar(user)}"
          style="
            width:90px;
            height:90px;
            object-fit:cover;
            border-radius:50%;
            border:2px solid #3b82f6;
          "
        >

        <h2 style="margin-top:12px;">
          ${escapeHtml(user.inGameNick)}
        </h2>

        <p>
          ID в игре:
          ${escapeHtml(user.inGameId)}
        </p>

      </div>

      <div class="stats-grid">

        ${['1v1', '2v2', '5v5']
          .map(mode => {

            const s =
              user.stats[mode];

            return `
              <div class="stat-card">

                <h3>${mode}</h3>

                <div class="stat-row">
                  <span>ELO</span>
                  <strong>${s.mmr}</strong>
                </div>

                <div class="stat-row">
                  <span>Уровень</span>
                  <strong>${getLevel(s.mmr)}</strong>
                </div>

                <div class="stat-row">
                  <span>Матчи</span>
                  <strong>${s.matches}</strong>
                </div>

                <div class="stat-row">
                  <span>Победы</span>
                  <strong>${s.wins}</strong>
                </div>

                <div class="stat-row">
                  <span>Поражения</span>
                  <strong>${s.losses}</strong>
                </div>

                <div class="stat-row">
                  <span>Стрик</span>
                  <strong>${s.streak}</strong>
                </div>

                <div class="stat-row">
                  <span>K/D</span>
                  <strong>
                    ${
                      s.deaths
                        ? (
                          s.kills /
                          s.deaths
                        ).toFixed(2)
                        : s.kills
                    }
                  </strong>
                </div>

              </div>
            `;
          })
          .join('')}

      </div>

      ${
        user.id !== currentUser.id
          ? `
            <button
              id="profileAddFriend"
              style="
                width:100%;
                margin-top:15px;
                padding:12px;
                border:0;
                border-radius:9px;
                background:#2563eb;
                color:white;
              "
            >
              Добавить в друзья
            </button>
          `
          : ''
      }

      <button
        class="modal-close"
        id="closeProfile"
      >
        Закрыть
      </button>

    </div>
  `;

  document.body.appendChild(
    modal
  );

  $('closeProfile')
    .onclick = () =>
      modal.remove();

  if (
    user.id !==
    currentUser.id
  ) {

    $('profileAddFriend')
      ?.addEventListener(
        'click',
        async () => {

          await sendFriendRequest(
            user.id
          );

          modal.remove();
        }
      );
  }
}

/* =========================================================
   CHAT
========================================================= */

function renderChatMessage(
  message
) {

  if (!message) return;

  const msg = {
    userId:
      text(message.userId),

    username:
      text(
        message.username ||
        message.inGameNick ||
        'Игрок'
      ),

    text:
      text(message.text),

    avatar:
      text(message.avatar),

    date:
      text(message.date)
  };

  const div =
    document.createElement('div');

  div.className =
    'chat-message';

  div.innerHTML = `
    <img
      src="${avatar({
        avatar: msg.avatar
      })}"
      class="chat-avatar"
      data-profile-id="${escapeHtml(msg.userId)}"
    >

    <div class="chat-text">

      <span class="chat-name">
        ${escapeHtml(msg.username)}
      </span>

      <span>
        :
        ${escapeHtml(msg.text)}
      </span>

      <small class="chat-date">
        ${escapeHtml(msg.date)}
      </small>

    </div>
  `;

  $('chatMessages')
    .appendChild(div);

  div
    .querySelector(
      '.chat-avatar'
    )
    ?.addEventListener(
      'click',
      () =>
        showProfile(
          msg.userId
        )
    );
}

function sendChat() {

  const input =
    $('chatInput');

  const value =
    input.value.trim();

  if (!value) return;

  socket.emit(
    'chatMessage',
    value
  );

  input.value = '';
}

async function loadChat() {

  const result =
    await api(
      '/api/chat-history'
    );

  if (!result.success) return;

  $('chatMessages')
    .innerHTML = '';

  result.messages.forEach(
    renderChatMessage
  );
}

/* =========================================================
   TOP
========================================================= */

async function loadTop() {

  const result =
    await api(
      '/api/top-players'
    );

  if (!result.success) return;

  const players =
    result.players || [];

  if (!players.length) {

    $('topContent').innerHTML =
      '<div class="stat-card">Пока нет игроков.</div>';

    return;
  }

  $('topContent').innerHTML = `
    <table class="top-table">

      <thead>

        <tr>
          <th>#</th>
          <th>Игрок</th>
          <th>1x1</th>
          <th>2x2</th>
          <th>5x5</th>
          <th>Общий ELO</th>
        </tr>

      </thead>

      <tbody>

        ${players
          .map((user, index) => {

            const total =
              user.stats['1v1'].mmr +
              user.stats['2v2'].mmr +
              user.stats['5v5'].mmr;

            return `
              <tr>

                <td>
                  ${index + 1}
                </td>

                <td>

                  <div class="top-player">

                    <img
                      src="${avatar(user)}"
                      class="top-avatar"
                    >

                    <button
                      style="
                        background:none;
                        border:0;
                        color:#60a5fa;
                      "
                      data-top-profile="${user.id}"
                    >
                      ${escapeHtml(user.inGameNick)}
                    </button>

                  </div>

                </td>

                <td>
                  ${user.stats['1v1'].mmr}
                </td>

                <td>
                  ${user.stats['2v2'].mmr}
                </td>

                <td>
                  ${user.stats['5v5'].mmr}
                </td>

                <td>
                  <strong>
                    ${total}
                  </strong>
                </td>

              </tr>
            `;
          })
          .join('')}

      </tbody>

    </table>
  `;

  document
    .querySelectorAll(
      '[data-top-profile]'
    )
    .forEach(btn => {

      btn.onclick = () =>
        showProfile(
          btn.dataset.topProfile
        );
    });
}

/* =========================================================
   CLAN
========================================================= */

async function loadClan() {

  const result =
    await api(
      `/api/clan-info?userId=${encodeURIComponent(currentUser.id)}`
    );

  if (
    !result.success ||
    !result.clan
  ) {

    $('clanContent').innerHTML = `
      <div class="clan-card">

        <h3>Вы не состоите в клане</h3>

        <p style="margin-top:10px;">
          Создайте свой клан или присоединитесь
          к существующему.
        </p>

        <div class="clan-actions">

          <input
            id="clanTag"
            maxlength="5"
            placeholder="Тег"
          >

          <input
            id="clanName"
            maxlength="32"
            placeholder="Название"
          >

          <button id="createClan">
            Создать клан
          </button>

        </div>

        <div class="clan-actions">

          <input
            id="joinClanId"
            placeholder="ID клана"
          >

          <button id="joinClan">
            Присоединиться
          </button>

        </div>

      </div>
    `;

    $('createClan').onclick =
      createClan;

    $('joinClan').onclick =
      joinClan;

    return;
  }

  const clan =
    result.clan;

  $('clanContent').innerHTML = `
    <div class="clan-card">

      <h2>
        [${escapeHtml(clan.tag)}]
        ${escapeHtml(clan.name)}
      </h2>

      <p>
        Участники:
        ${clan.members.length}/${clan.maxMembers}
      </p>

      <p>
        ID клана:
        <strong>${clan.id}</strong>
      </p>

      <div style="margin-top:18px;">

        ${clan.members
          .map(member => `
            <div class="clan-member">

              <img
                src="${avatar(member)}"
                class="mini-avatar"
                data-profile-id="${member.id}"
              >

              <button
                style="
                  background:none;
                  border:0;
                  color:#60a5fa;
                "
                data-clan-profile="${member.id}"
              >
                ${escapeHtml(member.inGameNick)}
              </button>

            </div>
          `)
          .join('')}

      </div>

      <button
        id="leaveClan"
        style="
          margin-top:18px;
          padding:10px 15px;
          border:0;
          border-radius:8px;
          background:#7f1d1d;
          color:white;
        "
      >
        Покинуть клан
      </button>

    </div>
  `;

  $('leaveClan').onclick =
    async () => {

      const response =
        await api(
          '/api/leave-clan',
          'POST',
          {
            userId:
              currentUser.id
          }
        );

      if (response.success) {
        await loadClan();

        const fresh =
          await api(
            `/api/user/${currentUser.id}`
          );

        if (fresh.success) {
          currentUser =
            fresh.userData;

          updateUI();
        }
      }
    };

  document
    .querySelectorAll(
      '[data-clan-profile]'
    )
    .forEach(btn => {

      btn.onclick = () =>
        showProfile(
          btn.dataset.clanProfile
        );
    });
}

async function createClan() {

  const tag =
    $('clanTag')
      .value
      .trim();

  const name =
    $('clanName')
      .value
      .trim();

  const result =
    await api(
      '/api/create-clan',
      'POST',
      {
        userId:
          currentUser.id,

        clanTag:
          tag,

        clanName:
          name
      }
    );

  showNotification(
    result.message ||
      (
        result.success
          ? 'Клан создан'
          : 'Ошибка'
      ),
    result.success
      ? 'success'
      : 'error'
  );

  if (result.success) {
    await loadClan();
  }
}

async function joinClan() {

  const clanId =
    $('joinClanId')
      .value
      .trim();

  const result =
    await api(
      '/api/join-clan',
      'POST',
      {
        userId:
          currentUser.id,

        clanId
      }
    );

  showNotification(
    result.message ||
      (
        result.success
          ? 'Вы вошли в клан'
          : 'Ошибка'
      ),
    result.success
      ? 'success'
      : 'error'
  );

  if (result.success) {
    await loadClan();
  }
}

/* =========================================================
   NICK
========================================================= */

async function changeNick() {

  const nick =
    $('newNickInput')
      .value
      .trim();

  if (!nick) return;

  const result =
    await api(
      '/api/change-nick',
      'POST',
      {
        userId:
          currentUser.id,

        newNick:
          nick
      }
    );

  if (!result.success) {

    showNotification(
      result.message,
      'error'
    );

    return;
  }

  currentUser =
    result.userData;

  updateUI();

  $('newNickInput').value =
    '';

  showNotification(
    'Ник изменён',
    'success'
  );
}

/* =========================================================
   AVATAR
========================================================= */

async function uploadAvatar() {

  const file =
    $('avatarUpload')
      .files[0];

  if (!file) return;

  if (!file.type.startsWith('image/')) {

    showNotification(
      'Можно загружать только изображения',
      'error'
    );

    return;
  }

  const form =
    new FormData();

  form.append(
    'avatar',
    file
  );

  form.append(
    'userId',
    currentUser.id
  );

  try {

    const response =
      await fetch(
        '/api/upload-avatar',
        {
          method: 'POST',
          body: form
        }
      );

    const result =
      await response.json();

    if (!result.success) {

      showNotification(
        result.message ||
          'Ошибка загрузки',
        'error'
      );

      return;
    }

    currentUser.avatar =
      result.avatarUrl;

    currentUser.stats.avatar =
      result.avatarUrl;

    $('avatar').src =
      result.avatarUrl;

    showNotification(
      'Аватарка установлена',
      'success'
    );

  } catch (err) {

    showNotification(
      'Не удалось загрузить аватарку',
      'error'
    );
  }

  $('avatarUpload').value =
    '';
}

/* =========================================================
   ADMIN PANEL
========================================================= */

async function openAdminPanel() {

  const check =
    await api(
      `/api/check-admin?userId=${encodeURIComponent(currentUser.id)}`
    );

  if (!check.isAdmin) {

    showNotification(
      'У вас нет прав администратора',
      'error'
    );

    return;
  }

  const modal =
    document.createElement('div');

  modal.className =
    'modal';

  modal.innerHTML = `
    <div class="modal-content">

      <h2>⚙️ Админ-панель</h2>

      <div id="adminUsers">
        Загрузка...
      </div>

      <button
        id="closeAdmin"
        class="modal-close"
      >
        Закрыть
      </button>

    </div>
  `;

  document.body.appendChild(
    modal
  );

  $('closeAdmin').onclick =
    () => modal.remove();

  const result =
    await api(
      `/api/admin/users?adminId=${encodeURIComponent(currentUser.id)}`
    );

  if (!result.success) {

    $('adminUsers').textContent =
      result.message;

    return;
  }

  $('adminUsers').innerHTML =
    result.users
      .map(user => `
        <div class="admin-user">

          <div>

            <strong>
              ${escapeHtml(user.inGameNick)}
            </strong>

            <br>

            <small>
              ${escapeHtml(user.inGameId)}
              • ID ${user.id}
            </small>

            <br>

            ${
              user.banned
                ? '<small style="color:#ef4444;">БАН</small>'
                : ''
            }

            ${
              user.muted
                ? '<small style="color:#f59e0b;">МУТ</small>'
                : ''
            }

          </div>

          <div class="admin-actions">

            <button
              data-admin-action="ban"
              data-user-id="${user.id}"
            >
              Бан
            </button>

            <button
              data-admin-action="mute"
              data-user-id="${user.id}"
            >
              Мут
            </button>

            <button
              data-admin-action="unban"
              data-user-id="${user.id}"
            >
              Снять бан
            </button>

            <button
              data-admin-action="unmute"
              data-user-id="${user.id}"
            >
              Снять мут
            </button>

          </div>

        </div>
      `)
      .join('');

  document
    .querySelectorAll(
      '[data-admin-action]'
    )
    .forEach(btn => {

      btn.onclick =
        () =>
          adminAction(
            btn.dataset.adminAction,
            btn.dataset.userId
          );
    });
}

async function adminAction(
  action,
  targetUserId
) {

  const reason =
    prompt(
      'Причина:',
      'Нарушение правил'
    ) || '';

  const duration =
    prompt(
      'Срок в часах:',
      '24'
    ) || '24';

  const result =
    await api(
      '/api/admin-action',
      'POST',
      {
        adminId:
          currentUser.id,

        targetUserId,

        action,

        reason,

        durationHours:
          Number(duration)
      }
    );

  showNotification(
    result.message ||
      (
        result.success
          ? 'Готово'
          : 'Ошибка'
      ),
    result.success
      ? 'success'
      : 'error'
  );
}

/* =========================================================
   EVENTS
========================================================= */

$('doLoginBtn')
  .onclick =
  login;

$('doRegisterBtn')
  .onclick =
  register;

$('showRegisterLink')
  .onclick =
  e => {
    e.preventDefault();
    showRegister();
  };

$('showLoginLink')
  .onclick =
  e => {
    e.preventDefault();
    showLogin();
  };

$('logoutBtn')
  .onclick =
  () => {

    localStorage.removeItem(
      'userId'
    );

    location.reload();
  };

$('createPartyBtn')
  .onclick =
  createParty;

$('joinPartyBtn')
  .onclick =
  joinParty;

$('chatSendBtn')
  .onclick =
  sendChat;

$('chatInput')
  .addEventListener(
    'keydown',
    e => {

      if (e.key === 'Enter') {
        sendChat();
      }
    }
  );

$('changeNickBtn')
  .onclick =
  changeNick;

$('changeAvatarBtn')
  .onclick =
  () =>
    $('avatarUpload').click();

$('avatarUpload')
  .onchange =
  uploadAvatar;

$('mobileMenuBtn')
  .onclick =
  () =>
    document
      .querySelector('.sidebar')
      ?.classList.toggle(
        'mobile-open'
      );

$('friendSearchBtn')
  .onclick =
  searchFriends;

/* =========================================================
   FRIEND TABS
========================================================= */

document
  .querySelectorAll(
    '.friends-tab'
  )
  .forEach(tab => {

    tab.onclick =
      async () => {

        document
          .querySelectorAll(
            '.friends-tab'
          )
          .forEach(t =>
            t.classList.remove(
              'active'
            )
          );

        tab.classList.add(
          'active'
        );

        const type =
          tab.dataset.tab;

        $('friendsList')
          .style.display =
          type === 'friends'
            ? 'block'
            : 'none';

        $('friendRequests')
          .style.display =
          type === 'requests'
            ? 'block'
            : 'none';

        $('friendSearch')
          .style.display =
          type === 'search'
            ? 'block'
            : 'none';

        if (type === 'friends') {
          await loadFriends();
        }

        if (type === 'requests') {
          await loadFriendRequests();
        }
      };
  });

/* =========================================================
   QUEUE BUTTONS
========================================================= */

document
  .querySelectorAll(
    '.queue-mode-btn'
  )
  .forEach(btn => {

    btn.onclick =
      () => {

        joinQueue(
          btn.dataset.mode,
          btn.dataset.ranked ===
            'true'
        );
      };
  });

document
  .querySelectorAll(
    '.leave-queue-btn'
  )
  .forEach(btn => {

    btn.onclick =
      () => {

        leaveQueue(
          btn.dataset.mode,
          btn.dataset.ranked ===
            'true'
        );
      };
  });

/* =========================================================
   PARTY / PROFILE CLICK DELEGATION
========================================================= */

document.addEventListener(
  'click',
  e => {

    const profile =
      e.target.closest(
        '[data-profile-id]'
      );

    if (
      profile &&
      profile.dataset.profileId
    ) {

      showProfile(
        profile.dataset.profileId
      );
    }

    const addParty =
      e.target.closest(
        '.add-party-friend'
      );

    if (
      addParty &&
      addParty.dataset.userId
    ) {

      sendFriendRequest(
        addParty.dataset.userId
      );
    }
  }
);

/* =========================================================
   SOCKET
========================================================= */

socket.on(
  'connect',
  () => {

    if (currentUser) {
      socket.emit(
        'auth',
        currentUser.id
      );
    }
  }
);

socket.on(
  'queueUpdate',
  queues => {

    queueState =
      queues || {};

    updateQueueUI();
  }
);

socket.on(
  'queueError',
  data => {

    showNotification(
      data?.message ||
        'Ошибка очереди',
      'error'
    );
  }
);

socket.on(
  'matchFound',
  match => {

    showMatchFound(
      match
    );
  }
);

socket.on(
  'matchAcceptanceUpdate',
  data => {

    const modal =
      $('matchModal');

    if (!modal) return;

    const timer =
      $('matchTimer');

    if (timer) {

      timer.textContent =
        `${data.accepted}/${data.total}`;
    }
  }
);

socket.on(
  'matchCancelled',
  data => {

    closeMatchModal();

    currentMatch =
      null;

    showNotification(
      data?.reason ||
        'Матч отменён',
      'error'
    );
  }
);

socket.on(
  'lobbyOpen',
  match => {

    openMatchLobby(
      match
    );
  }
);

socket.on(
  'lobbyMessage',
  msg => {

    const container =
      $('lobbyMessages');

    if (!container) return;

    const div =
      document.createElement('div');

    div.className =
      'chat-message';

    div.innerHTML = `
      <div class="chat-text">
        <span class="chat-name">
          ${escapeHtml(
            msg.username ||
            msg.from ||
            'Игрок'
          )}
        </span>

        :
        ${escapeHtml(msg.text)}

        <small class="chat-date">
          ${escapeHtml(msg.date)}
        </small>
      </div>
    `;

    container.appendChild(
      div
    );

    container.scrollTop =
      container.scrollHeight;
  }
);

socket.on(
  'chatMessage',
  msg => {

    renderChatMessage(
      msg
    );

    $('chatMessages')
      .scrollTop =
      $('chatMessages')
        .scrollHeight;
  }
);

socket.on(
  'chatHistory',
  history => {

    $('chatMessages')
      .innerHTML = '';

    (history || [])
      .forEach(
        renderChatMessage
      );
  }
);

socket.on(
  'privateMessage',
  msg => {

    showNotification(
      `Новое сообщение от игрока`,
      'info'
    );
  }
);

socket.on(
  'partyUpdate',
  party => {

    currentParty =
      party;

    renderParty();
  }
);

socket.on(
  'partyInvite',
  invite => {

    const accept =
      confirm(
        `${invite.fromName} приглашает вас в пати.\n\nПринять?`
      );

    if (accept) {

      socket.emit(
        'acceptPartyInvite',
        {
          partyId:
            invite.partyId
        }
      );
    }
  }
);

socket.on(
  'friendRequest',
  data => {

    if (!currentUser) return;

    if (
      !currentUser.pendingRequests
        .includes(data.from)
    ) {

      currentUser.pendingRequests
        .push(data.from);
    }

    showNotification(
      `Новая заявка в друзья от ${data.fromName}`,
      'info'
    );

    loadFriends();
  }
);

socket.on(
  'friendAdded',
  friendId => {

    if (!currentUser) return;

    if (
      !currentUser.friends
        .includes(friendId)
    ) {

      currentUser.friends
        .push(friendId);
    }

    loadFriends();
  }
);

socket.on(
  'statsUpdated',
  stats => {

    if (!currentUser) return;

    currentUser.stats =
      stats;

    updateUI();
  }
);

socket.on(
  'muted',
  data => {

    showNotification(
      `Мут до ${new Date(data.until).toLocaleString()}. ${data.reason || ''}`,
      'error'
    );
  }
);

socket.on(
  'banned',
  data => {

    showNotification(
      `Вы заблокированы до ${new Date(data.until).toLocaleString()}`,
      'error'
    );

    localStorage.removeItem(
      'userId'
    );

    setTimeout(
      () => location.reload(),
      1500
    );
  }
);

socket.on(
  'matchFinished',
  async () => {

    const fresh =
      await api(
        `/api/user/${currentUser.id}`
      );

    if (fresh.success) {

      currentUser =
        fresh.userData;

      updateUI();
    }

    showNotification(
      'Статистика обновлена',
      'success'
    );
  }
);

/* =========================================================
   ADMIN BUTTON
========================================================= */

async function setupAdminButton() {

  if (!currentUser) return;

  const result =
    await api(
      `/api/check-admin?userId=${encodeURIComponent(currentUser.id)}`
    );

  if (!result.isAdmin) return;

  if ($('adminButton')) return;

  const btn =
    document.createElement('button');

  btn.id =
    'adminButton';

  btn.textContent =
    '⚙️ Админ-панель';

  btn.style.cssText = `
    position:fixed;
    right:18px;
    bottom:18px;
    z-index:4500;
    padding:12px 16px;
    border:0;
    border-radius:10px;
    background:#2563eb;
    color:white;
    font-weight:700;
    box-shadow:0 8px 25px rgba(0,0,0,.35);
  `;

  btn.onclick =
    openAdminPanel;

  document.body.appendChild(
    btn
  );
}

/* =========================================================
   AFTER LOGIN PATCH
========================================================= */

const oldEnterAccount =
  enterAccount;

/*
  После авторизации проверяем админские права.
*/

async function finishInitialization() {

  setupNavigation();

  if (currentUser) {
    await setupAdminButton();
  }
}

/* =========================================================
   INIT
========================================================= */

(async () => {

  setupNavigation();

  await tryAutoLogin();

  if (currentUser) {
    await setupAdminButton();
  }

})();