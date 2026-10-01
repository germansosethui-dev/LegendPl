const socket = io();

let currentUser = null;
let currentParty = null;
let currentMatch = null;
let matchTimerInterval = null;
let activeModal = null;
let activeTooltip = null;
let queueState = {};
let privateHistory = [];
let adminButton = null;

// ============================================================
// DOM
// ============================================================

const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const authMessage = document.getElementById('authMessage');

const nicknameSpan = document.getElementById('nickname');
const profileStatsDiv = document.getElementById('profileStats');
const matchListUl = document.getElementById('matchList');

const friendsListDiv = document.getElementById('friendsList');
const friendRequestsDiv = document.getElementById('friendRequests');

const chatMessagesDiv = document.getElementById('chatMessages');
const privateChatArea = document.getElementById('privateChatArea');

const partyStatusDiv = document.getElementById('partyStatus');
const partyMembersDiv = document.getElementById('partyMembers');
const partyMembersList = document.getElementById('partyMembersList');

const activeMatchInfoDiv = document.getElementById('activeMatchInfo');

const avatarImg = document.getElementById('avatar');
const streakCountSpan = document.getElementById('streakCount');

const tooltip = document.getElementById('profileTooltip');
const profileInfoIcon = document.getElementById('profileInfoIcon');

const tooltipSiteId = document.getElementById('tooltipSiteId');
const tooltipSiteNick = document.getElementById('tooltipSiteNick');
const tooltipGameId = document.getElementById('tooltipGameId');
const tooltipGameNick = document.getElementById('tooltipGameNick');


// ============================================================
// HELPERS
// ============================================================

function escapeHtml(value) {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


async function apiCall(url, method = 'GET', body = undefined) {
  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (body !== undefined && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    let data;

    try {
      data = await response.json();
    } catch {
      data = {
        success: false,
        message: `Сервер вернул HTTP ${response.status}`
      };
    }

    if (!response.ok && data.success === undefined) {
      data.success = false;
    }

    return data;
  } catch (error) {
    console.error('API error:', error);

    return {
      success: false,
      message: 'Ошибка соединения с сервером'
    };
  }
}


function getUserAvatar(user) {
  if (user && user.avatar) {
    return user.avatar;
  }

  return 'https://via.placeholder.com/80?text=Avatar';
}


function getLevelIcon(level) {
  return `
    <img
      src="/images/${level}lvl.png"
      style="width:24px;height:24px;vertical-align:middle;"
      alt="Уровень ${level}"
      onerror="this.style.display='none'"
    >
  `;
}


function getLevelByMmr(mmr) {
  mmr = Number(mmr) || 0;

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


function showNotification(message, type = 'info') {
  let container = document.getElementById('notificationContainer');

  if (!container) {
    container = document.createElement('div');
    container.id = 'notificationContainer';

    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: min(400px, calc(100vw - 30px));
    `;

    document.body.appendChild(container);
  }

  const notification = document.createElement('div');

  notification.className = `notification ${type}`;

  let borderColor = '#3b82f6';

  if (type === 'success') {
    borderColor = '#22c55e';
  }

  if (type === 'error') {
    borderColor = '#ef4444';
  }

  notification.innerHTML = escapeHtml(message);

  notification.style.cssText = `
    background: #1e293b;
    border-left: 4px solid ${borderColor};
    padding: 12px 18px;
    border-radius: 8px;
    box-shadow: 0 5px 20px rgba(0,0,0,.35);
    color: #fff;
    font-size: 14px;
    animation: slideIn .3s ease;
    word-break: break-word;
  `;

  container.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideOut .3s ease';

    setTimeout(() => {
      notification.remove();
    }, 300);
  }, 5000);
}


function setAuthenticatedUI(authenticated) {
  if (!loginScreen || !mainScreen) return;

  if (authenticated) {
    loginScreen.style.display = 'none';
    mainScreen.style.display = 'flex';
  } else {
    loginScreen.style.display = 'flex';
    mainScreen.style.display = 'none';
  }
}


function resetApplicationState() {
  currentUser = null;
  currentParty = null;
  currentMatch = null;
  queueState = {};
  privateHistory = [];

  if (matchTimerInterval) {
    clearInterval(matchTimerInterval);
    matchTimerInterval = null;
  }

  if (adminButton) {
    adminButton.remove();
    adminButton = null;
  }
}


// ============================================================
// PROFILE / UI
// ============================================================

function updateUI() {
  if (!currentUser) return;

  nicknameSpan.textContent =
    currentUser.username ||
    currentUser.inGameNick ||
    'Игрок';

  if (avatarImg) {
    avatarImg.src = getUserAvatar(currentUser);
  }

  if (streakCountSpan) {
    streakCountSpan.textContent =
      currentUser.stats?.streak || 0;
  }

  if (tooltipSiteId) {
    tooltipSiteId.textContent = currentUser.id ?? '—';
  }

  if (tooltipSiteNick) {
    tooltipSiteNick.textContent =
      currentUser.username || '—';
  }

  if (tooltipGameId) {
    tooltipGameId.textContent =
      currentUser.inGameId || '—';
  }

  if (tooltipGameNick) {
    tooltipGameNick.textContent =
      currentUser.inGameNick || '—';
  }

  renderProfileStats();
  renderMatchHistory();

  if (currentUser.isAdmin) {
    createAdminButton();
  } else if (adminButton) {
    adminButton.remove();
    adminButton = null;
  }
}


function renderProfileStats() {
  if (!profileStatsDiv || !currentUser) return;

  const stats = currentUser.stats || {};

  const mmr1v1 = Number(stats.mmr_1v1) || 0;
  const mmr2v2 = Number(stats.mmr_2v2) || 0;
  const mmr5v5 = Number(stats.mmr_5v5) || 0;

  const matches1v1 = Number(stats.matches_1v1) || 0;
  const matches2v2 = Number(stats.matches_2v2) || 0;
  const matches5v5 = Number(stats.matches_5v5) || 0;

  const wins1v1 = Number(stats.wins_1v1) || 0;
  const wins2v2 = Number(stats.wins_2v2) || 0;
  const wins5v5 = Number(stats.wins_5v5) || 0;

  const losses1v1 = Number(stats.losses_1v1) || 0;
  const losses2v2 = Number(stats.losses_2v2) || 0;
  const losses5v5 = Number(stats.losses_5v5) || 0;

  const level1v1 = getLevelByMmr(mmr1v1);
  const level2v2 = getLevelByMmr(mmr2v2);
  const level5v5 = getLevelByMmr(mmr5v5);

  const winrate1v1 =
    matches1v1
      ? Math.round((wins1v1 / matches1v1) * 100)
      : 0;

  const winrate2v2 =
    matches2v2
      ? Math.round((wins2v2 / matches2v2) * 100)
      : 0;

  const winrate5v5 =
    matches5v5
      ? Math.round((wins5v5 / matches5v5) * 100)
      : 0;

  profileStatsDiv.innerHTML = `
    <div class="stat-card">
      <h3>1x1 Дуэль</h3>

      <div class="stat-row">
        <span>MMR:</span>
        <strong>${mmr1v1}</strong>
      </div>

      <div class="stat-row">
        <span>Уровень:</span>
        ${getLevelIcon(level1v1)}
      </div>

      <div class="stat-row">
        <span>Матчи:</span>
        <strong>${matches1v1}</strong>
      </div>

      <div class="stat-row">
        <span>Победы:</span>
        <strong>${wins1v1}</strong>
      </div>

      <div class="stat-row">
        <span>Поражения:</span>
        <strong>${losses1v1}</strong>
      </div>

      <div class="stat-row">
        <span>Винрейт:</span>
        <strong>${winrate1v1}%</strong>
      </div>
    </div>

    <div class="stat-card">
      <h3>2x2 Напарники</h3>

      <div class="stat-row">
        <span>MMR:</span>
        <strong>${mmr2v2}</strong>
      </div>

      <div class="stat-row">
        <span>Уровень:</span>
        ${getLevelIcon(level2v2)}
      </div>

      <div class="stat-row">
        <span>Матчи:</span>
        <strong>${matches2v2}</strong>
      </div>

      <div class="stat-row">
        <span>Победы:</span>
        <strong>${wins2v2}</strong>
      </div>

      <div class="stat-row">
        <span>Поражения:</span>
        <strong>${losses2v2}</strong>
      </div>

      <div class="stat-row">
        <span>Винрейт:</span>
        <strong>${winrate2v2}%</strong>
      </div>
    </div>

    <div class="stat-card">
      <h3>5x5 Соревновательный</h3>

      <div class="stat-row">
        <span>MMR:</span>
        <strong>${mmr5v5}</strong>
      </div>

      <div class="stat-row">
        <span>Уровень:</span>
        ${getLevelIcon(level5v5)}
      </div>

      <div class="stat-row">
        <span>Матчи:</span>
        <strong>${matches5v5}</strong>
      </div>

      <div class="stat-row">
        <span>Победы:</span>
        <strong>${wins5v5}</strong>
      </div>

      <div class="stat-row">
        <span>Поражения:</span>
        <strong>${losses5v5}</strong>
      </div>

      <div class="stat-row">
        <span>Винрейт:</span>
        <strong>${winrate5v5}%</strong>
      </div>
    </div>

    ${
      currentUser.isAdmin
        ? '<div class="admin-badge">Admin</div>'
        : ''
    }
  `;
}


function renderMatchHistory() {
  if (!matchListUl || !currentUser) return;

  const history =
    currentUser.stats?.matchHistory || [];

  matchListUl.innerHTML = '';

  if (!history.length) {
    matchListUl.innerHTML =
      '<li>История матчей пока пуста</li>';

    return;
  }

  history.forEach(match => {
    const li = document.createElement('li');

    const ranked =
      match.ranked === true ||
      match.ranked === 'true'
        ? 'Ранговый'
        : 'Обычный';

    li.innerHTML = `
      <strong>${escapeHtml(match.mode || 'Матч')}</strong>
      <br>
      ${escapeHtml(match.map || 'Карта не указана')}
      <br>
      ${ranked}
      ·
      ${escapeHtml(match.result || 'Результат неизвестен')}
      <br>
      <small>${escapeHtml(match.date || '')}</small>
    `;

    matchListUl.appendChild(li);
  });
}


function createAdminButton() {
  if (adminButton) return;

  adminButton = document.createElement('button');

  adminButton.textContent = '⚙️ Админ-панель';

  adminButton.className = 'admin-button';

  adminButton.style.cssText = `
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 10000;
    background: #3b82f6;
    color: #fff;
    border: none;
    padding: 10px 16px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
  `;

  adminButton.addEventListener('click', () => {
    window.open('/admin.html', '_blank');
  });

  document.body.appendChild(adminButton);
}


// ============================================================
// AUTH
// ============================================================

function showLoginForm() {
  const loginForm =
    document.getElementById('loginForm');

  const registerForm =
    document.getElementById('registerForm');

  if (loginForm) {
    loginForm.style.display = 'block';
  }

  if (registerForm) {
    registerForm.style.display = 'none';
  }

  if (authMessage) {
    authMessage.textContent = '';
  }
}


function showRegisterForm() {
  const loginForm =
    document.getElementById('loginForm');

  const registerForm =
    document.getElementById('registerForm');

  if (loginForm) {
    loginForm.style.display = 'none';
  }

  if (registerForm) {
    registerForm.style.display = 'block';
  }

  if (authMessage) {
    authMessage.textContent = '';
  }
}


async function register(
  username,
  password,
  inGameNick,
  inGameId
) {
  if (!username || !password || !inGameNick || !inGameId) {
    authMessage.textContent =
      'Заполните все поля';

    return;
  }

  const result = await apiCall(
    '/api/register',
    'POST',
    {
      username,
      password,
      inGameNick,
      inGameId
    }
  );

  if (result.success) {
    authMessage.textContent =
      result.message || 'Регистрация успешна';

    showNotification(
      'Регистрация выполнена',
      'success'
    );

    showLoginForm();

    const loginUsername =
      document.getElementById('loginUsername');

    if (loginUsername) {
      loginUsername.value = username;
    }
  } else {
    authMessage.textContent =
      result.message || 'Ошибка регистрации';
  }
}


async function login(username, password) {
  if (!username || !password) {
    authMessage.textContent =
      'Введите логин и пароль';

    return;
  }

  const result = await apiCall(
    '/api/login',
    'POST',
    {
      username,
      password
    }
  );

  if (!result.success) {
    authMessage.textContent =
      result.message || 'Неверный логин или пароль';

    return;
  }

  currentUser = result.userData;

  if (
    currentUser.stats &&
    currentUser.stats.avatar
  ) {
    currentUser.avatar =
      currentUser.stats.avatar;
  }

  localStorage.setItem(
    'userId',
    currentUser.id
  );

  localStorage.setItem(
    'loginTime',
    String(Date.now())
  );

  setAuthenticatedUI(true);

  updateUI();

  socket.emit(
    'auth',
    currentUser.id
  );

  await loadFriends();
  await loadTopLeaderboard();
  await loadClanInfo();

  showNotification(
    `Добро пожаловать, ${currentUser.username}!`,
    'success'
  );
}


async function tryAutoLogin() {
  const savedUserId =
    localStorage.getItem('userId');

  const loginTime =
    localStorage.getItem('loginTime');

  if (!savedUserId || !loginTime) {
    setAuthenticatedUI(false);
    return;
  }

  const elapsed =
    Date.now() - Number(loginTime);

  if (
    Number.isNaN(elapsed) ||
    elapsed >= 24 * 60 * 60 * 1000
  ) {
    localStorage.removeItem('userId');
    localStorage.removeItem('loginTime');

    setAuthenticatedUI(false);

    return;
  }

  const result = await apiCall(
    `/api/user/${encodeURIComponent(savedUserId)}`,
    'GET'
  );

  if (!result.success || !result.userData) {
    localStorage.removeItem('userId');
    localStorage.removeItem('loginTime');

    setAuthenticatedUI(false);

    return;
  }

  currentUser = result.userData;

  if (
    currentUser.stats &&
    currentUser.stats.avatar
  ) {
    currentUser.avatar =
      currentUser.stats.avatar;
  }

  setAuthenticatedUI(true);

  updateUI();

  socket.emit(
    'auth',
    currentUser.id
  );

  await loadFriends();
  await loadTopLeaderboard();
  await loadClanInfo();
}


// ============================================================
// QUEUES
// ============================================================

function joinQueue(mode, ranked) {
  if (!currentUser) {
    showNotification(
      'Сначала войдите в аккаунт',
      'error'
    );

    return;
  }

  socket.emit(
    'joinQueue',
    {
      mode,
      ranked,
      userId: currentUser.id,
      partyId: currentParty?.id || null
    }
  );

  updateQueueStatus(
    mode,
    ranked,
    true
  );
}


function leaveQueue(mode, ranked) {
  if (!currentUser) return;

  socket.emit(
    'leaveQueue',
    {
      mode,
      ranked,
      userId: currentUser.id,
      partyId: currentParty?.id || null
    }
  );

  updateQueueStatus(
    mode,
    ranked,
    false
  );
}


function leaveAllQueues() {
  const modes = [
    '1v1',
    '2v2',
    '5v5'
  ];

  modes.forEach(mode => {
    [true, false].forEach(ranked => {
      leaveQueue(mode, ranked);
    });
  });
}


function updateQueueStatus(
  mode,
  ranked,
  inQueue
) {
  const suffix =
    ranked
      ? 'ranked'
      : 'unranked';

  const status =
    document.getElementById(
      `queue-status-${mode}-${suffix}`
    );

  const leaveButton =
    document.querySelector(
      `.leave-queue-btn[data-mode="${mode}"][data-ranked="${ranked}"]`
    );

  if (status) {
    status.textContent =
      inQueue
        ? 'В очереди'
        : 'Не в очереди';
  }

  if (leaveButton) {
    leaveButton.style.display =
      inQueue
        ? 'inline-block'
        : 'none';
  }
}


function updateQueueDisplay() {
  if (!queueState) return;

  const modes = [
    ['1v1', 2],
    ['2v2', 4],
    ['5v5', 10]
  ];

  modes.forEach(([mode, max]) => {
    [false, true].forEach(ranked => {
      const suffix =
        ranked
          ? 'ranked'
          : 'unranked';

      const element =
        document.getElementById(
          `queue-count-${mode}-${suffix}`
        );

      if (!element) return;

      let count = 0;

      const possible =
        queueState?.[mode];

      if (typeof possible === 'number') {
        count = possible;
      } else if (
        possible &&
        typeof possible === 'object'
      ) {
        if (ranked) {
          count =
            Number(
              possible.ranked
            ) || 0;
        } else {
          count =
            Number(
              possible.unranked
            ) || 0;
        }
      }

      element.textContent =
        `${count}/${max}`;
    });
  });
}


// ============================================================
// PARTY
// ============================================================

async function createParty() {
  if (!currentUser) return;

  const result = await apiCall(
    '/api/create-party',
    'POST',
    {
      userId: currentUser.id
    }
  );

  if (!result.success) {
    showNotification(
      result.message || 'Не удалось создать пати',
      'error'
    );

    return;
  }

  currentParty =
    result.party ||
    result.partyData ||
    result;

  updatePartyUI();

  showNotification(
    'Пати создана',
    'success'
  );
}


async function joinParty(code) {
  if (!currentUser || !code) return;

  const result = await apiCall(
    '/api/join-party',
    'POST',
    {
      userId: currentUser.id,
      code
    }
  );

  if (!result.success) {
    showNotification(
      result.message || 'Не удалось присоединиться',
      'error'
    );

    return;
  }

  currentParty =
    result.party ||
    result.partyData ||
    result;

  updatePartyUI();

  showNotification(
    'Вы присоединились к пати',
    'success'
  );
}


async function leaveParty(partyId) {
  if (!currentUser || !partyId) return;

  const result = await apiCall(
    '/api/leave-party',
    'POST',
    {
      partyId,
      userId: currentUser.id
    }
  );

  if (!result.success) {
    showNotification(
      result.message || 'Не удалось выйти из пати',
      'error'
    );

    return;
  }

  currentParty = null;

  updatePartyUI();

  showNotification(
    'Вы вышли из пати',
    'info'
  );
}


function updatePartyUI() {
  if (!partyStatusDiv) return;

  if (!currentParty) {
    partyStatusDiv.innerHTML =
      '<span>Вы не состоите в пати</span>';

    if (partyMembersDiv) {
      partyMembersDiv.style.display = 'none';
    }

    return;
  }

  const members =
    currentParty.members ||
    currentParty.players ||
    [];

  partyStatusDiv.innerHTML = `
    <div>
      <strong>Пати</strong>

      ${
        currentParty.code
          ? `<span>Код: <strong>${escapeHtml(currentParty.code)}</strong></span>`
          : ''
      }

      <button
        class="leave-party-btn"
        id="leaveCurrentPartyBtn"
      >
        Выйти из пати
      </button>
    </div>
  `;

  document
    .getElementById('leaveCurrentPartyBtn')
    ?.addEventListener(
      'click',
      () => leaveParty(currentParty.id)
    );

  if (!partyMembersDiv || !partyMembersList) {
    return;
  }

  partyMembersDiv.style.display =
    'block';

  partyMembersList.innerHTML = '';

  members.forEach(member => {
    const div =
      document.createElement('div');

    const memberId =
      member.id ||
      member.userId;

    const memberName =
      member.username ||
      member.inGameNick ||
      member.name ||
      'Игрок';

    div.innerHTML = `
      <img
        class="mini-avatar"
        src="${escapeHtml(getUserAvatar(member))}"
        alt=""
      >

      <span>
        ${escapeHtml(memberName)}
      </span>

      ${
        memberId &&
        currentUser &&
        memberId !== currentUser.id
          ? `
            <button
              class="add-friend-from-party"
              data-user-id="${escapeHtml(memberId)}"
            >
              + Друг
            </button>
          `
          : ''
      }
    `;

    partyMembersList.appendChild(div);
  });

  partyMembersList
    .querySelectorAll(
      '.add-friend-from-party'
    )
    .forEach(button => {
      button.addEventListener(
        'click',
        () => sendFriendRequest(
          button.dataset.userId
        )
      );
    });
}


// ============================================================
// FRIENDS
// ============================================================

async function loadFriends() {
  if (!currentUser) return;

  const result = await apiCall(
    `/api/friends/${encodeURIComponent(currentUser.id)}`,
    'GET'
  );

  if (!result.success) {
    console.error(
      'loadFriends:',
      result.message
    );

    return;
  }

  const friends =
    result.friends ||
    result.data ||
    [];

  const requests =
    result.requests ||
    result.pendingRequests ||
    [];

  renderFriends(friends);
  renderFriendRequests(requests);
}


function renderFriends(friends) {
  if (!friendsListDiv) return;

  friendsListDiv.innerHTML = '';

  if (!friends.length) {
    friendsListDiv.innerHTML =
      '<p class="muted-text">У вас пока нет друзей.</p>';

    return;
  }

  friends.forEach(friend => {
    const div =
      document.createElement('div');

    div.className =
      'friend-item';

    const id =
      friend.id ||
      friend.userId;

    const name =
      friend.username ||
      friend.inGameNick ||
      friend.name ||
      'Игрок';

    div.innerHTML = `
      <img
        class="friend-avatar"
        src="${escapeHtml(getUserAvatar(friend))}"
        alt=""
      >

      <div>
        <strong>${escapeHtml(name)}</strong>

        <div>
          <button
            class="pm-friend"
            data-user-id="${escapeHtml(id || '')}"
          >
            Написать
          </button>

          <button
            class="remove-friend"
            data-user-id="${escapeHtml(id || '')}"
          >
            Удалить
          </button>
        </div>
      </div>
    `;

    friendsListDiv.appendChild(div);
  });

  friendsListDiv
    .querySelectorAll('.pm-friend')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => openPrivateChat(
          button.dataset.userId
        )
      );
    });

  friendsListDiv
    .querySelectorAll('.remove-friend')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => removeFriend(
          button.dataset.userId
        )
      );
    });
}


function renderFriendRequests(requests) {
  if (!friendRequestsDiv) return;

  friendRequestsDiv.innerHTML = '';

  if (!requests.length) {
    friendRequestsDiv.innerHTML =
      '<p class="muted-text">Новых заявок нет.</p>';

    return;
  }

  requests.forEach(request => {
    const div =
      document.createElement('div');

    div.className =
      'friend-item';

    const id =
      request.id ||
      request.userId ||
      request.from;

    const name =
      request.username ||
      request.inGameNick ||
      request.name ||
      request.fromName ||
      'Игрок';

    div.innerHTML = `
      <img
        class="friend-avatar"
        src="${escapeHtml(getUserAvatar(request))}"
        alt=""
      >

      <div>
        <strong>${escapeHtml(name)}</strong>

        <div>
          <button
            class="accept-request"
            data-user-id="${escapeHtml(id || '')}"
          >
            Принять
          </button>

          <button
            class="reject-request"
            data-user-id="${escapeHtml(id || '')}"
          >
            Отклонить
          </button>
        </div>
      </div>
    `;

    friendRequestsDiv.appendChild(div);
  });

  friendRequestsDiv
    .querySelectorAll('.accept-request')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => respondFriendRequest(
          button.dataset.userId,
          true
        )
      );
    });

  friendRequestsDiv
    .querySelectorAll('.reject-request')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => respondFriendRequest(
          button.dataset.userId,
          false
        )
      );
    });
}


async function sendFriendRequest(userId) {
  if (!currentUser || !userId) return;

  const result = await apiCall(
    '/api/friend-request',
    'POST',
    {
      userId: currentUser.id,
      targetId: userId
    }
  );

  if (result.success) {
    showNotification(
      'Заявка отправлена',
      'success'
    );
  } else {
    showNotification(
      result.message || 'Не удалось отправить заявку',
      'error'
    );
  }
}


async function respondFriendRequest(
  userId,
  accept
) {
  if (!currentUser || !userId) return;

  const result = await apiCall(
    '/api/friend-request/respond',
    'POST',
    {
      userId: currentUser.id,
      fromUserId: userId,
      accept
    }
  );

  if (result.success) {
    showNotification(
      accept
        ? 'Заявка принята'
        : 'Заявка отклонена',
      'success'
    );

    loadFriends();
  } else {
    showNotification(
      result.message || 'Ошибка',
      'error'
    );
  }
}


async function removeFriend(userId) {
  if (!currentUser || !userId) return;

  const result = await apiCall(
    '/api/remove-friend',
    'POST',
    {
      userId: currentUser.id,
      friendId: userId
    }
  );

  if (result.success) {
    showNotification(
      'Друг удалён',
      'info'
    );

    loadFriends();
  } else {
    showNotification(
      result.message || 'Не удалось удалить друга',
      'error'
    );
  }
}


// ============================================================
// CHAT
// ============================================================

function sendGlobalChat() {
  if (!currentUser) return;

  const input =
    document.getElementById('chatInput');

  if (!input) return;

  const message =
    input.value.trim();

  if (!message) return;

  socket.emit(
    'chatMessage',
    {
      userId: currentUser.id,
      message
    }
  );

  input.value = '';
}


function addChatMessage(message) {
  if (!chatMessagesDiv) return;

  const div =
    document.createElement('div');

  div.className =
    'chat-message';

  const user =
    message.user ||
    message.author ||
    {};

  const userName =
    message.username ||
    message.userName ||
    user.username ||
    message.name ||
    'Игрок';

  const text =
    message.message ||
    message.text ||
    '';

  const avatar =
    message.avatar ||
    user.avatar ||
    'https://via.placeholder.com/40';

  div.innerHTML = `
    <img
      class="chat-avatar"
      src="${escapeHtml(avatar)}"
      alt=""
    >

    <div>
      <strong>
        ${escapeHtml(userName)}
      </strong>

      <small>
        ${escapeHtml(
          message.time ||
          message.date ||
          ''
        )}
      </small>

      <div>
        ${escapeHtml(text)}
      </div>
    </div>
  `;

  chatMessagesDiv.appendChild(div);

  chatMessagesDiv.scrollTop =
    chatMessagesDiv.scrollHeight;
}


function openPrivateChat(userId) {
  if (!currentUser || !userId) return;

  if (!privateChatArea) return;

  privateChatArea.innerHTML = `
    <div class="private-chat">
      <h3>Личный чат</h3>

      <div
        id="privateMessages"
        class="chat-messages"
        style="height:250px;"
      ></div>

      <div class="chat-input">
        <input
          id="privateChatInput"
          type="text"
          placeholder="Сообщение..."
        >

        <button id="privateChatSend">
          Отправить
        </button>
      </div>
    </div>
  `;

  const sendButton =
    document.getElementById(
      'privateChatSend'
    );

  const input =
    document.getElementById(
      'privateChatInput'
    );

  const send = () => {
    const text =
      input.value.trim();

    if (!text) return;

    socket.emit(
      'privateMessage',
      {
        from: currentUser.id,
        to: userId,
        message: text
      }
    );

    input.value = '';
  };

  sendButton?.addEventListener(
    'click',
    send
  );

  input?.addEventListener(
    'keypress',
    event => {
      if (event.key === 'Enter') {
        send();
      }
    }
  );

  socket.emit(
    'privateHistory',
    {
      userId: currentUser.id,
      targetId: userId
    }
  );
}


// ============================================================
// TOP
// ============================================================

async function loadTopLeaderboard() {
  const result = await apiCall(
    '/api/leaderboard',
    'GET'
  );

  if (!result.success) {
    console.error(
      'leaderboard:',
      result.message
    );

    return;
  }

  window.topLeaderboard =
    result.players ||
    result.users ||
    result.leaderboard ||
    [];
}


function renderTop() {
  const topView =
    document.getElementById('topView');

  if (!topView) return;

  const players =
    window.topLeaderboard || [];

  topView.innerHTML = `
    <h2>Топ игроков</h2>

    <div class="top-tabs">
      <button
        class="top-tab active"
        data-top-mode="1v1"
      >
        1x1
      </button>

      <button
        class="top-tab"
        data-top-mode="2v2"
      >
        2x2
      </button>

      <button
        class="top-tab"
        data-top-mode="5v5"
      >
        5x5
      </button>
    </div>

    <div id="topTableContainer"></div>
  `;

  const tabs =
    topView.querySelectorAll(
      '.top-tab'
    );

  tabs.forEach(tab => {
    tab.addEventListener(
      'click',
      () => {
        tabs.forEach(t =>
          t.classList.remove('active')
        );

        tab.classList.add('active');

        renderTopTable(
          tab.dataset.topMode,
          players
        );
      }
    );
  });

  renderTopTable(
    '1v1',
    players
  );
}


function renderTopTable(mode, players) {
  const container =
    document.getElementById(
      'topTableContainer'
    );

  if (!container) return;

  const mmrKey =
    `mmr_${mode}`;

  const sorted =
    [...players]
      .sort(
        (a, b) =>
          (Number(b?.stats?.[mmrKey]) || 0) -
          (Number(a?.stats?.[mmrKey]) || 0)
      );

  container.innerHTML = `
    <table class="top-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Игрок</th>
          <th>MMR</th>
        </tr>
      </thead>

      <tbody>
        ${
          sorted.length
            ? sorted
                .slice(0, 100)
                .map(
                  (player, index) => `
                    <tr>
                      <td>${index + 1}</td>

                      <td>
                        <img
                          class="top-avatar"
                          src="${escapeHtml(
                            getUserAvatar(player)
                          )}"
                          alt=""
                        >

                        ${escapeHtml(
                          player.username ||
                          player.inGameNick ||
                          'Игрок'
                        )}
                      </td>

                      <td>
                        ${
                          Number(
                            player?.stats?.[mmrKey]
                          ) || 0
                        }
                      </td>
                    </tr>
                  `
                )
                .join('')
            : `
              <tr>
                <td colspan="3">
                  Нет данных
                </td>
              </tr>
            `
        }
      </tbody>
    </table>
  `;
}


// ============================================================
// CLAN
// ============================================================

async function loadClanInfo() {
  if (!currentUser) return;

  const clanView =
    document.getElementById('clanView');

  if (!clanView) return;

  const result = await apiCall(
    `/api/clan/${encodeURIComponent(currentUser.id)}`,
    'GET'
  );

  if (
    !result.success ||
    !result.clan
  ) {
    renderClanCreate();
    return;
  }

  renderClan(result.clan);
}


function renderClanCreate() {
  const clanView =
    document.getElementById('clanView');

  if (!clanView) return;

  clanView.innerHTML = `
    <h2>Клан</h2>

    <p>
      Вы пока не состоите в клане.
    </p>

    <div>
      <input
        type="text"
        id="clanTag"
        placeholder="Тег клана"
        maxlength="5"
      >

      <input
        type="text"
        id="clanName"
        placeholder="Название клана"
        maxlength="32"
      >

      <button
        id="createClanBtn"
        class="glow-btn"
      >
        Создать клан
      </button>
    </div>

    <div style="margin-top:20px;">
      <input
        type="text"
        id="joinClanId"
        placeholder="ID клана"
      >

      <button
        id="joinClanBtn"
        class="glow-btn"
      >
        Присоединиться
      </button>
    </div>
  `;

  document
    .getElementById('createClanBtn')
    ?.addEventListener(
      'click',
      async () => {
        const tag =
          document
            .getElementById('clanTag')
            .value
            .trim();

        const name =
          document
            .getElementById('clanName')
            .value
            .trim();

        if (!tag || !name) {
          showNotification(
            'Заполните тег и название',
            'error'
          );

          return;
        }

        const result =
          await apiCall(
            '/api/create-clan',
            'POST',
            {
              userId: currentUser.id,
              clanTag: tag,
              clanName: name
            }
          );

        if (result.success) {
          showNotification(
            'Клан создан',
            'success'
          );

          loadClanInfo();
        } else {
          showNotification(
            result.message || 'Ошибка',
            'error'
          );
        }
      }
    );

  document
    .getElementById('joinClanBtn')
    ?.addEventListener(
      'click',
      async () => {
        const clanId =
          document
            .getElementById('joinClanId')
            .value
            .trim();

        if (!clanId) return;

        const result =
          await apiCall(
            '/api/join-clan',
            'POST',
            {
              userId: currentUser.id,
              clanId
            }
          );

        if (result.success) {
          showNotification(
            'Вы присоединились к клану',
            'success'
          );

          loadClanInfo();
        } else {
          showNotification(
            result.message || 'Ошибка',
            'error'
          );
        }
      }
    );
}


function renderClan(clan) {
  const clanView =
    document.getElementById('clanView');

  if (!clanView) return;

  const members =
    clan.members ||
    [];

  clanView.innerHTML = `
    <h2>Клан</h2>

    <div class="stat-card">
      <h3>
        ${escapeHtml(
          clan.name ||
          'Клан'
        )}
      </h3>

      <p>
        Тег:
        <strong>
          ${escapeHtml(
            clan.tag || ''
          )}
        </strong>
      </p>

      <p>
        ID:
        <strong>
          ${escapeHtml(
            clan.id || ''
          )}
        </strong>
      </p>
    </div>

    <div style="margin-top:20px;">
      <h3>Участники</h3>

      <div class="friends-list">
        ${
          members.length
            ? members
                .map(
                  member => `
                    <div class="friend-item">
                      <img
                        class="friend-avatar"
                        src="${escapeHtml(
                          getUserAvatar(member)
                        )}"
                        alt=""
                      >

                      <strong>
                        ${escapeHtml(
                          member.username ||
                          member.inGameNick ||
                          'Игрок'
                        )}
                      </strong>
                    </div>
                  `
                )
                .join('')
            : '<p>Участников нет</p>'
        }
      </div>
    </div>
  `;
}


// ============================================================
// CHANGE NICK
// ============================================================

async function changeInGameNick(newNick) {
  if (!currentUser || !newNick) return;

  const result =
    await apiCall(
      '/api/change-nick',
      'POST',
      {
        userId: currentUser.id,
        newNick
      }
    );

  if (!result.success) {
    showNotification(
      result.message || 'Не удалось изменить ник',
      'error'
    );

    return;
  }

  currentUser.inGameNick =
    newNick;

  updateUI();

  showNotification(
    'Ник в игре изменён',
    'success'
  );
}


// ============================================================
// AVATAR
// ============================================================

async function uploadAvatar(file) {
  if (!currentUser || !file) return;

  if (!file.type.startsWith('image/')) {
    showNotification(
      'Можно загружать только изображения',
      'error'
    );

    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    showNotification(
      'Максимальный размер аватарки — 5 МБ',
      'error'
    );

    return;
  }

  const formData =
    new FormData();

  formData.append(
    'avatar',
    file
  );

  formData.append(
    'userId',
    currentUser.id
  );

  try {
    const response =
      await fetch(
        '/api/upload-avatar',
        {
          method: 'POST',
          body: formData
        }
      );

    const result =
      await response.json();

    if (!result.success) {
      showNotification(
        result.message ||
          'Не удалось загрузить аватар',
        'error'
      );

      return;
    }

    if (result.avatar) {
      currentUser.avatar =
        result.avatar;

      if (avatarImg) {
        avatarImg.src =
          result.avatar;
      }
    }

    showNotification(
      'Аватарка обновлена',
      'success'
    );
  } catch (error) {
    console.error(error);

    showNotification(
      'Ошибка загрузки аватарки',
      'error'
    );
  }
}


// ============================================================
// MATCH FOUND
// ============================================================

function showMatchFound(match) {
  currentMatch = match;

  const old =
    document.getElementById(
      'matchFoundModal'
    );

  if (old) old.remove();

  const modal =
    document.createElement('div');

  modal.id =
    'matchFoundModal';

  modal.className =
    'match-found-modal';

  const players =
    match.players ||
    match.participants ||
    [];

  let seconds =
    Number(
      match.acceptTime ||
      match.timeout ||
      30
    );

  modal.innerHTML = `
    <div class="match-found-content">
      <h2>Матч найден!</h2>

      <div class="participants-list">
        ${
          players
            .map(player => `
              <div class="participant">
                <img
                  class="participant-avatar"
                  src="${escapeHtml(
                    getUserAvatar(player)
                  )}"
                  alt=""
                >

                <span>
                  ${escapeHtml(
                    player.username ||
                    player.inGameNick ||
                    'Игрок'
                  )}
                </span>
              </div>
            `)
            .join('')
        }
      </div>

      <div class="timer">
        Принятие:
        <strong id="matchAcceptTimer">
          ${seconds}
        </strong>
      </div>

      <div class="match-buttons">
        <button id="acceptMatchBtn">
          Принять
        </button>

        <button id="declineMatchBtn">
          Отклонить
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document
    .getElementById('acceptMatchBtn')
    ?.addEventListener(
      'click',
      () => acceptMatch(match)
    );

  document
    .getElementById('declineMatchBtn')
    ?.addEventListener(
      'click',
      () => declineMatch(match)
    );

  if (matchTimerInterval) {
    clearInterval(matchTimerInterval);
  }

  matchTimerInterval =
    setInterval(() => {
      seconds--;

      const timer =
        document.getElementById(
          'matchAcceptTimer'
        );

      if (timer) {
        timer.textContent =
          Math.max(seconds, 0);
      }

      if (seconds <= 0) {
        clearInterval(
          matchTimerInterval
        );

        matchTimerInterval =
          null;
      }
    }, 1000);
}


function acceptMatch(match) {
  if (!currentUser) return;

  socket.emit(
    'acceptMatch',
    {
      matchId:
        match.matchId ||
        match.id,
      userId:
        currentUser.id
    }
  );

  const modal =
    document.getElementById(
      'matchFoundModal'
    );

  if (modal) {
    modal.remove();
  }

  if (matchTimerInterval) {
    clearInterval(
      matchTimerInterval
    );

    matchTimerInterval =
      null;
  }

  showNotification(
    'Матч принят',
    'success'
  );
}


function declineMatch(match) {
  if (!currentUser) return;

  socket.emit(
    'declineMatch',
    {
      matchId:
        match.matchId ||
        match.id,
      userId:
        currentUser.id
    }
  );

  const modal =
    document.getElementById(
      'matchFoundModal'
    );

  if (modal) {
    modal.remove();
  }

  if (matchTimerInterval) {
    clearInterval(
      matchTimerInterval
    );

    matchTimerInterval =
      null;
  }

  showNotification(
    'Матч отклонён',
    'info'
  );
}


// ============================================================
// DRAFT
// ============================================================

function handleDraftStart(data) {
  const existing =
    document.getElementById(
      'draftModal'
    );

  if (existing) {
    existing.remove();
  }

  const modal =
    document.createElement('div');

  modal.id =
    'draftModal';

  modal.className =
    'modal';

  const maps =
    data.maps ||
    [];

  modal.innerHTML = `
    <div class="modal-content">
      <h2>Выбор карты</h2>

      <div id="draftContent">
        ${
          maps.length
            ? maps
                .map(
                  map => `
                    <button
                      class="glow-btn draft-map-btn"
                      data-map="${escapeHtml(map)}"
                    >
                      ${escapeHtml(map)}
                    </button>
                  `
                )
                .join('')
            : `
              <p>
                Ожидание выбора...
              </p>
            `
        }
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal
    .querySelectorAll('.draft-map-btn')
    .forEach(button => {
      button.addEventListener(
        'click',
        () => {
          socket.emit(
            'mapVote',
            {
              matchId:
                data.matchId,
              userId:
                currentUser?.id,
              map:
                button.dataset.map
            }
          );
        }
      );
    });
}


// ============================================================
// LOBBY
// ============================================================

function openLobby(match) {
  const old =
    document.getElementById(
      'lobbyModal'
    );

  if (old) old.remove();

  const modal =
    document.createElement('div');

  modal.id =
    'lobbyModal';

  modal.className =
    'modal';

  modal.innerHTML = `
    <div class="modal-content">
      <h2>Лобби матча</h2>

      <div id="lobbyPlayers"></div>

      <div
        class="lobby-chat"
        id="lobbyChat"
      ></div>

      <div class="lobby-input">
        <input
          id="lobbyChatInput"
          type="text"
          placeholder="Сообщение..."
        >

        <button id="lobbyChatSend">
          Отправить
        </button>
      </div>

      <button id="closeLobbyBtn">
        Закрыть
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  renderLobbyPlayers(match);

  document
    .getElementById('closeLobbyBtn')
    ?.addEventListener(
      'click',
      () => modal.remove()
    );

  const input =
    document.getElementById(
      'lobbyChatInput'
    );

  const send =
    document.getElementById(
      'lobbyChatSend'
    );

  const sendMessage = () => {
    const text =
      input.value.trim();

    if (!text) return;

    socket.emit(
      'lobbyChatMessage',
      {
        matchId:
          match.matchId ||
          match.id,
        userId:
          currentUser?.id,
        message: text
      }
    );

    input.value = '';
  };

  send?.addEventListener(
    'click',
    sendMessage
  );

  input?.addEventListener(
    'keypress',
    event => {
      if (event.key === 'Enter') {
        sendMessage();
      }
    }
  );
}


function renderLobbyPlayers(match) {
  const container =
    document.getElementById(
      'lobbyPlayers'
    );

  if (!container) return;

  const players =
    match.players ||
    match.participants ||
    [];

  container.innerHTML =
    players
      .map(
        player => `
          <div class="participant">
            <img
              class="participant-avatar"
              src="${escapeHtml(
                getUserAvatar(player)
              )}"
              alt=""
            >

            <span>
              ${escapeHtml(
                player.username ||
                player.inGameNick ||
                'Игрок'
              )}
            </span>
          </div>
        `
      )
      .join('');
}


// ============================================================
// NAVIGATION
// ============================================================

function setupNavigation() {
  const buttons =
    document.querySelectorAll(
      '.nav-btn'
    );

  const views = {
    play:
      document.getElementById(
        'playView'
      ),

    profile:
      document.getElementById(
        'profileView'
      ),

    history:
      document.getElementById(
        'historyView'
      ),

    friends:
      document.getElementById(
        'friendsView'
      ),

    chat:
      document.getElementById(
        'chatView'
      ),

    top:
      document.getElementById(
        'topView'
      ),

    clan:
      document.getElementById(
        'clanView'
      )
  };

  buttons.forEach(button => {
    button.addEventListener(
      'click',
      () => {
        const target =
          button.dataset.view;

        if (!views[target]) return;

        buttons.forEach(btn =>
          btn.classList.remove(
            'active'
          )
        );

        button.classList.add(
          'active'
        );

        Object.values(views)
          .forEach(view => {
            if (view) {
              view.style.display =
                'none';

              view.classList.remove(
                'active'
              );
            }
          });

        views[target].style.display =
          'block';

        views[target].classList.add(
          'active'
        );

        if (target === 'friends') {
          loadFriends();
        }

        if (target === 'top') {
          loadTopLeaderboard()
            .then(renderTop);
        }

        if (target === 'clan') {
          loadClanInfo();
        }
      }
    );
  });

  // ВАЖНО:
  // после входа всегда показываем Играть.
  const playButton =
    document.querySelector(
      '.nav-btn[data-view="play"]'
    );

  if (playButton) {
    playButton.click();
  }
}


// ============================================================
// QUEUE BUTTONS
// ============================================================

function setupQueueButtons() {
  document
    .querySelectorAll(
      '.queue-mode-btn'
    )
    .forEach(button => {
      button.addEventListener(
        'click',
        () => {
          if (!currentUser) {
            showNotification(
              'Сначала войдите в аккаунт',
              'error'
            );

            return;
          }

          const mode =
            button.dataset.mode;

          const ranked =
            button.dataset.ranked ===
            'true';

          joinQueue(
            mode,
            ranked
          );
        }
      );
    });

  document
    .querySelectorAll(
      '.leave-queue-btn'
    )
    .forEach(button => {
      button.addEventListener(
        'click',
        () => {
          const mode =
            button.dataset.mode;

          const ranked =
            button.dataset.ranked ===
            'true';

          leaveQueue(
            mode,
            ranked
          );
        }
      );
    });
}


// ============================================================
// PARTICLES
// ============================================================

function createParticles(x, y) {
  for (let i = 0; i < 12; i++) {
    const particle =
      document.createElement('div');

    particle.className =
      'particle';

    const angle =
      Math.random() *
      Math.PI *
      2;

    const speed =
      3 +
      Math.random() * 5;

    particle.style.setProperty(
      '--dx',
      `${Math.cos(angle) * speed}px`
    );

    particle.style.setProperty(
      '--dy',
      `${Math.sin(angle) * speed}px`
    );

    particle.style.left =
      `${x}px`;

    particle.style.top =
      `${y}px`;

    document.body.appendChild(
      particle
    );

    setTimeout(
      () => particle.remove(),
      600
    );
  }
}


// ============================================================
// EVENTS
// ============================================================

document.addEventListener(
  'click',
  event => {
    if (
      event.target.closest(
        'button'
      )
    ) {
      createParticles(
        event.clientX,
        event.clientY
      );
    }
  }
);


document
  .getElementById(
    'doLoginBtn'
  )
  ?.addEventListener(
    'click',
    () => {
      const username =
        document
          .getElementById(
            'loginUsername'
          )
          ?.value
          .trim();

      const password =
        document
          .getElementById(
            'loginPassword'
          )
          ?.value || '';

      login(
        username,
        password
      );
    }
  );


document
  .getElementById(
    'loginPassword'
  )
  ?.addEventListener(
    'keypress',
    event => {
      if (event.key === 'Enter') {
        document
          .getElementById(
            'doLoginBtn'
          )
          ?.click();
      }
    }
  );


document
  .getElementById(
    'doRegisterBtn'
  )
  ?.addEventListener(
    'click',
    () => {
      const username =
        document
          .getElementById(
            'regUsername'
          )
          ?.value
          .trim();

      const password =
        document
          .getElementById(
            'regPassword'
          )
          ?.value || '';

      const confirm =
        document
          .getElementById(
            'regPasswordConfirm'
          )
          ?.value || '';

      const inGameNick =
        document
          .getElementById(
            'regInGameNick'
          )
          ?.value
          .trim();

      const inGameId =
        document
          .getElementById(
            'regInGameId'
          )
          ?.value
          .trim();

      if (password !== confirm) {
        authMessage.textContent =
          'Пароли не совпадают';

        return;
      }

      register(
        username,
        password,
        inGameNick,
        inGameId
      );
    }
  );


document
  .getElementById(
    'showRegisterLink'
  )
  ?.addEventListener(
    'click',
    event => {
      event.preventDefault();

      showRegisterForm();
    }
  );


document
  .getElementById(
    'showLoginLink'
  )
  ?.addEventListener(
    'click',
    event => {
      event.preventDefault();

      showLoginForm();
    }
  );


document
  .getElementById(
    'logoutBtn'
  )
  ?.addEventListener(
    'click',
    () => {
      leaveAllQueues();

      localStorage.removeItem(
        'userId'
      );

      localStorage.removeItem(
        'loginTime'
      );

      socket.disconnect();

      location.reload();
    }
  );


document
  .getElementById(
    'createPartyBtn'
  )
  ?.addEventListener(
    'click',
    createParty
  );


document
  .getElementById(
    'joinPartyBtn'
  )
  ?.addEventListener(
    'click',
    () => {
      const input =
        document.getElementById(
          'joinPartyCode'
        );

      const code =
        input?.value.trim();

      if (!code) {
        showNotification(
          'Введите код пати',
          'error'
        );

        return;
      }

      joinParty(code);
    }
  );


document
  .getElementById(
    'chatSendBtn'
  )
  ?.addEventListener(
    'click',
    sendGlobalChat
  );


document
  .getElementById(
    'chatInput'
  )
  ?.addEventListener(
    'keypress',
    event => {
      if (event.key === 'Enter') {
        sendGlobalChat();
      }
    }
  );


// ============================================================
// AVATAR EVENTS
// ============================================================

const changeAvatarBtn =
  document.getElementById(
    'changeAvatarBtn'
  );

const avatarUpload =
  document.getElementById(
    'avatarUpload'
  );


changeAvatarBtn?.addEventListener(
  'click',
  () => {
    avatarUpload?.click();
  }
);


avatarUpload?.addEventListener(
  'change',
  async event => {
    const file =
      event.target.files?.[0];

    if (file) {
      await uploadAvatar(file);
    }

    event.target.value = '';
  }
);


// ============================================================
// PROFILE TOOLTIP
// ============================================================

profileInfoIcon?.addEventListener(
  'click',
  event => {
    event.stopPropagation();

    if (!tooltip) return;

    if (
      tooltip.style.display ===
      'block'
    ) {
      tooltip.style.display =
        'none';

      return;
    }

    const rect =
      profileInfoIcon.getBoundingClientRect();

    tooltip.style.display =
      'block';

    tooltip.style.left =
      `${rect.right + 8}px`;

    tooltip.style.top =
      `${rect.top}px`;
  }
);


document.addEventListener(
  'click',
  event => {
    if (
      tooltip &&
      !event.target.closest(
        '#profileInfoIcon'
      ) &&
      !event.target.closest(
        '#profileTooltip'
      )
    ) {
      tooltip.style.display =
        'none';
    }
  }
);


// ============================================================
// CHANGE NICK
// ============================================================

const changeNickBtn =
  document.getElementById(
    'changeNickBtn'
  );

const newNickInput =
  document.getElementById(
    'newNickInput'
  );


changeNickBtn?.addEventListener(
  'click',
  () => {
    const nick =
      newNickInput?.value.trim();

    if (!nick) {
      showNotification(
        'Введите новый ник',
        'error'
      );

      return;
    }

    changeInGameNick(nick);
  }
);


newNickInput?.addEventListener(
  'keypress',
  event => {
    if (event.key === 'Enter') {
      changeNickBtn?.click();
    }
  }
);


// ============================================================
// SOCKET.IO
// ============================================================

socket.on(
  'connect',
  () => {
    console.log(
      'Socket connected:',
      socket.id
    );

    if (currentUser) {
      socket.emit(
        'auth',
        currentUser.id
      );
    }
  }
);


socket.on(
  'disconnect',
  () => {
    console.log(
      'Socket disconnected'
    );
  }
);


socket.on(
  'queueUpdate',
  queues => {
    queueState =
      queues || {};

    updateQueueDisplay();
  }
);


socket.on(
  'matchFound',
  match => {
    showMatchFound(match);
  }
);


socket.on(
  'matchCancelled',
  () => {
    const modal =
      document.getElementById(
        'matchFoundModal'
      );

    if (modal) {
      modal.remove();
    }

    if (matchTimerInterval) {
      clearInterval(
        matchTimerInterval
      );

      matchTimerInterval =
        null;
    }

    if (activeMatchInfoDiv) {
      activeMatchInfoDiv.style.display =
        'none';
    }

    currentMatch = null;

    showNotification(
      'Матч отменён',
      'error'
    );

    leaveAllQueues();

    if (currentParty?.id) {
      leaveParty(
        currentParty.id
      );
    }
  }
);


socket.on(
  'draftStart',
  data => {
    currentMatch = {
      ...(currentMatch || {}),
      matchId:
        data.matchId
    };

    handleDraftStart(data);
  }
);


socket.on(
  'lobbyOpen',
  match => {
    openLobby(match);
  }
);


socket.on(
  'statsUpdated',
  stats => {
    if (!currentUser) return;

    currentUser.stats =
      stats || {};

    if (stats?.avatar) {
      currentUser.avatar =
        stats.avatar;
    }

    updateUI();

    showNotification(
      'Статистика обновлена',
      'success'
    );
  }
);


socket.on(
  'friendRequest',
  data => {
    showNotification(
      `Новая заявка в друзья от ${
        data.fromName || 'игрока'
      }`,
      'info'
    );

    loadFriends();
  }
);


socket.on(
  'friendAdded',
  () => {
    loadFriends();
  }
);


socket.on(
  'partyUpdate',
  party => {
    currentParty =
      party || null;

    updatePartyUI();
  }
);


socket.on(
  'partyInvite',
  invite => {
    showNotification(
      `${
        invite.fromName ||
        'Игрок'
      } приглашает вас в пати`,
      'info'
    );

    showPartyInvite(invite);
  }
);


socket.on(
  'chatMessage',
  message => {
    addChatMessage(message);
  }
);


socket.on(
  'chatHistory',
  history => {
    if (!chatMessagesDiv) return;

    chatMessagesDiv.innerHTML = '';

    (history || [])
      .forEach(
        message =>
          addChatMessage(message)
      );
  }
);


socket.on(
  'privateHistory',
  history => {
    privateHistory =
      history || [];
  }
);


socket.on(
  'privateMessage',
  message => {
    const container =
      document.getElementById(
        'privateMessages'
      );

    if (!container) return;

    const div =
      document.createElement('div');

    div.className =
      'chat-message';

    div.innerHTML = `
      <div>
        <strong>
          ${escapeHtml(
            message.username ||
            message.fromName ||
            'Игрок'
          )}
        </strong>

        <div>
          ${escapeHtml(
            message.message ||
            message.text ||
            ''
          )}
        </div>
      </div>
    `;

    container.appendChild(div);

    container.scrollTop =
      container.scrollHeight;
  }
);


socket.on(
  'lobbyChatMessage',
  message => {
    const chat =
      document.getElementById(
        'lobbyChat'
      );

    if (!chat) return;

    const div =
      document.createElement('div');

    div.style.marginBottom =
      '8px';

    div.innerHTML = `
      <strong>
        ${escapeHtml(
          message.username ||
          message.fromName ||
          'Игрок'
        )}
      </strong>:
      ${escapeHtml(
        message.message ||
        ''
      )}
    `;

    chat.appendChild(div);

    chat.scrollTop =
      chat.scrollHeight;
  }
);


socket.on(
  'queueError',
  error => {
    showNotification(
      error?.message ||
      'Ошибка очереди',
      'error'
    );
  }
);


socket.on(
  'muted',
  data => {
    showNotification(
      `Вы замьючены до ${
        data?.until
          ? new Date(
              data.until
            ).toLocaleString()
          : 'неизвестной даты'
      }. Причина: ${
        data?.reason || 'не указана'
      }`,
      'error'
    );
  }
);


socket.on(
  'banned',
  data => {
    showNotification(
      `Вы забанены${
        data?.reason
          ? `. Причина: ${data.reason}`
          : ''
      }`,
      'error'
    );

    setTimeout(
      () => {
        localStorage.removeItem(
          'userId'
        );

        localStorage.removeItem(
          'loginTime'
        );

        location.reload();
      },
      3000
    );
  }
);


// ============================================================
// PARTY INVITE
// ============================================================

function showPartyInvite(invite) {
  const old =
    document.getElementById(
      'partyInviteModal'
    );

  if (old) old.remove();

  const modal =
    document.createElement('div');

  modal.id =
    'partyInviteModal';

  modal.className =
    'modal';

  modal.innerHTML = `
    <div class="modal-content">
      <h2>Приглашение в пати</h2>

      <p>
        ${
          escapeHtml(
            invite.fromName ||
            'Игрок'
          )
        }
        приглашает вас в пати.
      </p>

      <div style="display:flex;gap:10px;margin-top:20px;">
        <button
          id="acceptPartyInvite"
          class="glow-btn"
        >
          Принять
        </button>

        <button
          id="declinePartyInvite"
        >
          Отклонить
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document
    .getElementById(
      'acceptPartyInvite'
    )
    ?.addEventListener(
      'click',
      () => {
        socket.emit(
          'partyInviteAccept',
          {
            inviteId:
              invite.id,
            partyId:
              invite.partyId,
            userId:
              currentUser?.id
          }
        );

        modal.remove();
      }
    );

  document
    .getElementById(
      'declinePartyInvite'
    )
    ?.addEventListener(
      'click',
      () => {
        socket.emit(
          'partyInviteDecline',
          {
            inviteId:
              invite.id,
            userId:
              currentUser?.id
          }
        );

        modal.remove();
      }
    );
}


// ============================================================
// MOBILE MENU
// ============================================================

function setupMobileMenu() {
  if (
    document.querySelector(
      '.mobile-menu-btn'
    )
  ) {
    return;
  }

  const button =
    document.createElement('button');

  button.className =
    'mobile-menu-btn';

  button.textContent =
    '☰';

  button.setAttribute(
    'aria-label',
    'Меню'
  );

  document.body.appendChild(
    button
  );

  const sidebar =
    document.querySelector(
      '.sidebar'
    );

  if (!sidebar) return;

  button.addEventListener(
    'click',
    () => {
      sidebar.classList.toggle(
        'mobile-open'
      );

      document.body.classList.toggle(
        'menu-open'
      );
    }
  );

  sidebar
    .querySelectorAll('.nav-btn')
    .forEach(navButton => {
      navButton.addEventListener(
        'click',
        () => {
          sidebar.classList.remove(
            'mobile-open'
          );

          document.body.classList.remove(
            'menu-open'
          );
        }
      );
    });
}


// ============================================================
// INIT
// ============================================================

function initializeApplication() {
  // Сразу скрываем главный экран.
  // Это важно: выбор режима не должен
  // появляться на странице входа.
  if (mainScreen) {
    mainScreen.style.display =
      'none';
  }

  if (loginScreen) {
    loginScreen.style.display =
      'flex';
  }

  showLoginForm();

  setupNavigation();
  setupQueueButtons();
  setupMobileMenu();

  tryAutoLogin();
}


initializeApplication();
