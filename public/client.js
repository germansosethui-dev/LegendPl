const socket = io();

let currentUser = null;
let currentParty = null;
let currentMatch = null;
let matchTimerInterval = null;
let activeModal = null;
let activeTooltip = null;
let adminButton = null;
let queueState = {};
let privateHistory = [];
let topPlayersData = null;
let users = {};

// ------------------ DOM ------------------

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

// ------------------ HELPERS ------------------

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, m => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[m]));
}

async function apiCall(url, method = 'GET', body = undefined) {
    try {
        const options = {
            method,
            headers: {}
        };

        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }

        const res = await fetch(url, options);
        const text = await res.text();

        try {
            return JSON.parse(text);
        } catch {
            return {
                success: false,
                message: text || `HTTP ${res.status}`
            };
        }
    } catch (error) {
        console.error('API error:', error);
        return {
            success: false,
            message: 'Ошибка соединения с сервером'
        };
    }
}

function getUserAvatar(user) {
    if (user?.avatar) return user.avatar;

    return 'data:image/svg+xml;charset=UTF-8,' +
        encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg"
                 width="80"
                 height="80"
                 viewBox="0 0 80 80">
                <rect width="80" height="80" rx="40" fill="#1e293b"/>
                <circle cx="40" cy="31" r="13" fill="#64748b"/>
                <path d="M17 68c3-14 13-22 23-22s20 8 23 22"
                      fill="#64748b"/>
            </svg>
        `);
}

function getLevelIcon(level) {
    return `
        <img
            src="/images/${level}lvl.png"
            style="width:24px;height:24px;vertical-align:middle;"
            alt="lvl ${level}"
        >
    `;
}

function getLevelByMmr(mmr = 0) {
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
            position:fixed;
            top:20px;
            right:20px;
            z-index:99999;
            display:flex;
            flex-direction:column;
            gap:10px;
        `;

        document.body.appendChild(container);
    }

    const notif = document.createElement('div');

    notif.className = `notification ${type}`;

    const borderColor =
        type === 'success'
            ? '#22c55e'
            : type === 'error'
                ? '#ef4444'
                : '#3b82f6';

    notif.style.cssText = `
        background:#1e293b;
        border-left:4px solid ${borderColor};
        padding:12px 20px;
        border-radius:8px;
        box-shadow:0 2px 8px rgba(0,0,0,.3);
        color:white;
        font-size:14px;
        animation:slideIn .3s ease;
    `;

    notif.textContent = String(message ?? '');

    container.appendChild(notif);

    setTimeout(() => {
        notif.style.animation = 'slideOut .3s ease';

        setTimeout(() => {
            notif.remove();
        }, 300);
    }, 5000);
}

function createParticles(x, y) {
    for (let i = 0; i < 12; i++) {
        const particle = document.createElement('div');

        particle.className = 'particle';

        const angle = Math.random() * Math.PI * 2;
        const speed = 3 + Math.random() * 5;

        const dx = Math.cos(angle) * speed;
        const dy = Math.sin(angle) * speed;

        particle.style.setProperty('--dx', `${dx}px`);
        particle.style.setProperty('--dy', `${dy}px`);

        particle.style.left = `${x}px`;
        particle.style.top = `${y}px`;

        document.body.appendChild(particle);

        setTimeout(() => particle.remove(), 600);
    }
}

// ------------------ QUEUES ------------------

function leaveAllQueues() {
    const modes = ['1v1', '2v2', '5v5'];

    for (const mode of modes) {
        leaveQueue(mode, true);
        leaveQueue(mode, false);
    }
}

function joinQueue(mode, ranked) {
    if (!currentUser) return;

    socket.emit('joinQueue', {
        mode,
        ranked,
        partyId: currentParty?.id || null
    });
}

function leaveQueue(mode, ranked) {
    if (!currentUser) return;

    socket.emit('leaveQueue', {
        mode,
        ranked
    });
}

function updateQueueDisplay() {
    if (!currentUser) return;

    const modes = ['1v1', '2v2', '5v5'];

    for (const mode of modes) {
        for (const ranked of [true, false]) {
            const type = ranked ? 'ranked' : 'unranked';
            const key = `${mode}_${type}`;

            const queue = queueState[key] || [];

            const needed =
                mode === '1v1'
                    ? 2
                    : mode === '2v2'
                        ? 4
                        : 10;

            const countSpan = document.getElementById(
                `queue-count-${mode}-${type}`
            );

            if (countSpan) {
                countSpan.textContent = `${queue.length}/${needed}`;
            }

            const statusSpan = document.getElementById(
                `queue-status-${mode}-${type}`
            );

            const inQueue = queue.some(
                entry => String(entry.userId) === String(currentUser.id)
            );

            if (statusSpan) {
                statusSpan.textContent = inQueue
                    ? 'В очереди'
                    : 'Не в очереди';
            }

            const leaveBtn = document.querySelector(
                `.leave-queue-btn[data-mode="${mode}"][data-ranked="${ranked}"]`
            );

            if (leaveBtn) {
                leaveBtn.style.display =
                    inQueue ? 'inline-block' : 'none';
            }
        }
    }
}

// ------------------ USER UI ------------------

function updateUI() {
    if (!currentUser) return;

    currentUser.stats = currentUser.stats || {};

    if (nicknameSpan) {
        nicknameSpan.textContent =
            currentUser.inGameNick || 'Игрок';
    }

    if (avatarImg) {
        avatarImg.src = getUserAvatar(currentUser);
    }

    if (streakCountSpan) {
        streakCountSpan.textContent =
            currentUser.stats.streak || 0;
    }

    if (tooltipSiteId) {
        tooltipSiteId.textContent = currentUser.id || '—';
    }

    if (tooltipSiteNick) {
        tooltipSiteNick.textContent = 'скрыт';
    }

    if (tooltipGameId) {
        tooltipGameId.textContent =
            currentUser.inGameId || '—';
    }

    if (tooltipGameNick) {
        tooltipGameNick.textContent =
            currentUser.inGameNick || '—';
    }

    const stats = currentUser.stats;

    const mmr1 = Number(stats.mmr_1v1) || 0;
    const mmr2 = Number(stats.mmr_2v2) || 0;
    const mmr5 = Number(stats.mmr_5v5) || 0;

    const level1 = getLevelByMmr(mmr1);
    const level2 = getLevelByMmr(mmr2);
    const level5 = getLevelByMmr(mmr5);

    if (profileStatsDiv) {
        profileStatsDiv.innerHTML = `
            <div class="stats-grid">

                <div class="stat-card">
                    <h3>1x1 Дуэль</h3>

                    <div class="stat-row">
                        <span>MMR:</span>
                        <strong>${mmr1}</strong>
                    </div>

                    <div class="stat-row">
                        <span>Уровень:</span>
                        ${getLevelIcon(level1)}
                    </div>

                    <div class="stat-row">
                        <span>Матчи:</span>
                        ${stats.matches_1v1 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Победы:</span>
                        ${stats.wins_1v1 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Поражения:</span>
                        ${stats.losses_1v1 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Винрейт:</span>
                        ${stats.matches_1v1
                            ? Math.round(
                                stats.wins_1v1 /
                                stats.matches_1v1 *
                                100
                            )
                            : 0
                        }%
                    </div>

                    ${currentUser.isAdmin
                        ? '<div class="admin-badge">Admin</div>'
                        : ''
                    }
                </div>

                <div class="stat-card">
                    <h3>2x2 Напарники</h3>

                    <div class="stat-row">
                        <span>MMR:</span>
                        <strong>${mmr2}</strong>
                    </div>

                    <div class="stat-row">
                        <span>Уровень:</span>
                        ${getLevelIcon(level2)}
                    </div>

                    <div class="stat-row">
                        <span>Матчи:</span>
                        ${stats.matches_2v2 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Победы:</span>
                        ${stats.wins_2v2 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Поражения:</span>
                        ${stats.losses_2v2 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Винрейт:</span>
                        ${stats.matches_2v2
                            ? Math.round(
                                stats.wins_2v2 /
                                stats.matches_2v2 *
                                100
                            )
                            : 0
                        }%
                    </div>
                </div>

                <div class="stat-card">
                    <h3>5x5 Соревновательный</h3>

                    <div class="stat-row">
                        <span>MMR:</span>
                        <strong>${mmr5}</strong>
                    </div>

                    <div class="stat-row">
                        <span>Уровень:</span>
                        ${getLevelIcon(level5)}
                    </div>

                    <div class="stat-row">
                        <span>Матчи:</span>
                        ${stats.matches_5v5 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Победы:</span>
                        ${stats.wins_5v5 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Поражения:</span>
                        ${stats.losses_5v5 || 0}
                    </div>

                    <div class="stat-row">
                        <span>Винрейт:</span>
                        ${stats.matches_5v5
                            ? Math.round(
                                stats.wins_5v5 /
                                stats.matches_5v5 *
                                100
                            )
                            : 0
                        }%
                    </div>
                </div>

            </div>
        `;
    }

    if (matchListUl) {
        matchListUl.innerHTML = '';

        const history = stats.matchHistory || [];

        if (!history.length) {
            matchListUl.innerHTML = '<li>Нет матчей</li>';
        } else {
            history.forEach(match => {
                const li = document.createElement('li');

                li.textContent =
                    `${match.mode} (${match.ranked}) | ` +
                    `${match.map} | ` +
                    `${match.result} | ` +
                    `${match.date}`;

                matchListUl.appendChild(li);
            });
        }
    }

    if (currentUser.isAdmin && !adminButton) {
        adminButton = document.createElement('button');

        adminButton.textContent = '⚙️ Админ-панель';

        adminButton.style.cssText = `
            position:fixed;
            bottom:20px;
            right:20px;
            background:#3b82f6;
            color:white;
            border:none;
            padding:10px 16px;
            border-radius:8px;
            cursor:pointer;
            z-index:10000;
            font-weight:bold;
        `;

        adminButton.addEventListener('click', () => {
            window.open('/admin.html', '_blank');
        });

        document.body.appendChild(adminButton);

    } else if (!currentUser.isAdmin && adminButton) {
        adminButton.remove();
        adminButton = null;
    }
}

// ------------------ AUTH ------------------

async function tryAutoLogin() {
    const savedUserId =
        localStorage.getItem('userId');

    if (!savedUserId) return;

    const res =
        await apiCall(`/api/user/${savedUserId}`);

    if (!res.success) {
        localStorage.removeItem('userId');
        localStorage.removeItem('loginTime');
        return;
    }

    currentUser = res.userData;

    if (currentUser.stats?.avatar) {
        currentUser.avatar =
            currentUser.stats.avatar;
    }

    users[currentUser.id] = currentUser;

    updateUI();

    if (loginScreen) loginScreen.style.display = 'none';
    if (mainScreen) mainScreen.style.display = 'flex';

    socket.emit('auth', currentUser.id);

    loadFriends();
    loadTopLeaderboard();
    loadClanInfo();
}

async function register(
    username,
    password,
    inGameNick,
    inGameId
) {
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

        showLoginForm();
    } else {
        authMessage.textContent =
            result.message || 'Ошибка регистрации';
    }
}

async function login(username, password) {
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
            result.message || 'Ошибка входа';
        return;
    }

    currentUser = result.userData;

    if (currentUser.stats?.avatar) {
        currentUser.avatar =
            currentUser.stats.avatar;
    }

    users[currentUser.id] = currentUser;

    updateUI();

    if (loginScreen) loginScreen.style.display = 'none';
    if (mainScreen) mainScreen.style.display = 'flex';

    socket.emit('auth', currentUser.id);

    loadFriends();
    loadTopLeaderboard();
    loadClanInfo();

    localStorage.setItem(
        'userId',
        currentUser.id
    );

    localStorage.setItem(
        'loginTime',
        Date.now()
    );
}

// ------------------ AVATAR ------------------

async function uploadAvatar(file) {
    if (!currentUser || !file) return;

    const formData = new FormData();

    formData.append('avatar', file);
    formData.append('userId', currentUser.id);

    try {
        const res = await fetch(
            '/api/upload-avatar',
            {
                method: 'POST',
                body: formData
            }
        );

        const data = await res.json();

        if (!data.success) {
            showNotification(
                data.message || 'Ошибка загрузки аватарки',
                'error'
            );
            return;
        }

        currentUser.avatar = data.avatarUrl;

        currentUser.stats =
            currentUser.stats || {};

        currentUser.stats.avatar =
            data.avatarUrl;

        updateUI();

        await apiCall(
            '/api/update-stats',
            'POST',
            {
                userId: currentUser.id,
                stats: currentUser.stats
            }
        );

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

// ------------------ FRIENDS ------------------

async function loadFriends() {
    if (!currentUser) return;

    currentUser.friends =
        currentUser.friends || [];

    currentUser.pendingRequests =
        currentUser.pendingRequests || [];

    if (friendsListDiv) {
        friendsListDiv.innerHTML = '';
    }

    for (const friendId of currentUser.friends) {
        const friend =
            await apiCall(`/api/user/${friendId}`);

        if (!friend.success) continue;

        users[friendId] = friend.userData;

        const div =
            document.createElement('div');

        div.className = 'friend-item';

        div.innerHTML = `
            <img
                src="${getUserAvatar(friend.userData)}"
                class="friend-avatar"
                data-id="${escapeHtml(friendId)}"
            >

            <span>
                ${escapeHtml(friend.userData.inGameNick)}
                (${escapeHtml(friend.userData.inGameId)})
            </span>

            <div>
                <button
                    class="invite-friend"
                    data-id="${escapeHtml(friendId)}"
                >
                    Пригласить в пати
                </button>

                <button
                    class="pm-friend"
                    data-id="${escapeHtml(friendId)}"
                    data-nick="${escapeHtml(friend.userData.inGameNick)}"
                >
                    💬
                </button>

                <button
                    class="remove-friend"
                    data-id="${escapeHtml(friendId)}"
                >
                    Удалить
                </button>
            </div>
        `;

        friendsListDiv?.appendChild(div);
    }

    if (friendRequestsDiv) {
        friendRequestsDiv.innerHTML = '';
    }

    for (const requestId of currentUser.pendingRequests) {
        const req =
            await apiCall(`/api/user/${requestId}`);

        if (!req.success) continue;

        users[requestId] = req.userData;

        const div =
            document.createElement('div');

        div.className = 'friend-item';

        div.innerHTML = `
            <img
                src="${getUserAvatar(req.userData)}"
                class="friend-avatar"
                data-id="${escapeHtml(requestId)}"
            >

            <span>
                ${escapeHtml(req.userData.inGameNick)}
                (${escapeHtml(req.userData.inGameId)})
            </span>

            <div>
                <button
                    class="accept-request"
                    data-id="${escapeHtml(requestId)}"
                >
                    Принять
                </button>

                <button
                    class="reject-request"
                    data-id="${escapeHtml(requestId)}"
                >
                    Отклонить
                </button>
            </div>
        `;

        friendRequestsDiv?.appendChild(div);
    }

    document.querySelectorAll('.friend-avatar')
        .forEach(img => {
            img.addEventListener('click', () => {
                showUserProfile(img.dataset.id);
            });

            addAvatarHoverTooltip(img);
        });

    document.querySelectorAll('.invite-friend')
        .forEach(btn => {
            btn.addEventListener('click', () => {
                inviteToParty(btn.dataset.id);
            });
        });

    document.querySelectorAll('.pm-friend')
        .forEach(btn => {
            btn.addEventListener('click', () => {
                openPrivateChatModal(
                    btn.dataset.id,
                    btn.dataset.nick
                );
            });
        });

    document.querySelectorAll('.remove-friend')
        .forEach(btn => {
            btn.addEventListener('click', () => {
                removeFriend(btn.dataset.id);
            });
        });

    document.querySelectorAll('.accept-request')
        .forEach(btn => {
            btn.addEventListener('click', () => {
                acceptFriendRequest(btn.dataset.id);
            });
        });

    document.querySelectorAll('.reject-request')
        .forEach(btn => {
            btn.addEventListener('click', () => {
                rejectFriendRequest(btn.dataset.id);
            });
        });
}

async function removeFriend(friendId) {
    const res = await apiCall(
        '/api/remove-friend',
        'POST',
        {
            userId: currentUser.id,
            friendId
        }
    );

    if (!res.success) {
        showNotification(
            res.message || 'Ошибка удаления друга',
            'error'
        );
        return;
    }

    currentUser.friends =
        (currentUser.friends || [])
            .filter(id => String(id) !== String(friendId));

    await loadFriends();

    showNotification(
        'Друг удалён',
        'success'
    );
}

async function acceptFriendRequest(friendId) {
    const res = await apiCall(
        '/api/accept-friend',
        'POST',
        {
            userId: currentUser.id,
            friendId
        }
    );

    if (!res.success) {
        showNotification(
            res.message || 'Ошибка',
            'error'
        );
        return;
    }

    currentUser.friends =
        currentUser.friends || [];

    currentUser.pendingRequests =
        currentUser.pendingRequests || [];

    if (!currentUser.friends.some(
        id => String(id) === String(friendId)
    )) {
        currentUser.friends.push(friendId);
    }

    currentUser.pendingRequests =
        currentUser.pendingRequests.filter(
            id => String(id) !== String(friendId)
        );

    await loadFriends();

    showNotification(
        'Заявка принята',
        'success'
    );
}

async function rejectFriendRequest(friendId) {
    const res = await apiCall(
        '/api/reject-friend',
        'POST',
        {
            userId: currentUser.id,
            friendId
        }
    );

    if (!res.success) {
        showNotification(
            res.message || 'Ошибка',
            'error'
        );
        return;
    }

    currentUser.pendingRequests =
        (currentUser.pendingRequests || [])
            .filter(id => String(id) !== String(friendId));

    await loadFriends();

    showNotification(
        'Заявка отклонена',
        'info'
    );
}

async function sendFriendRequest(toUserId) {
    const user =
        await apiCall(`/api/user/${toUserId}`);

    if (!user.success) {
        showNotification(
            'Пользователь не найден',
            'error'
        );
        return;
    }

    const res = await apiCall(
        '/api/send-friend-request',
        'POST',
        {
            fromUserId: currentUser.id,
            toInGameId: user.userData.inGameId
        }
    );

    if (res.success) {
        showNotification(
            'Заявка отправлена',
            'success'
        );
    } else {
        showNotification(
            res.message || 'Ошибка',
            'error'
        );
    }
}

// ------------------ PROFILE ------------------

async function showUserProfile(userId) {
    const user =
        await apiCall(`/api/user/${userId}`);

    if (!user.success) return;

    const data = user.userData;

    users[userId] = data;

    data.stats = data.stats || {};

    const level1 =
        getLevelByMmr(data.stats.mmr_1v1);

    const level2 =
        getLevelByMmr(data.stats.mmr_2v2);

    const level5 =
        getLevelByMmr(data.stats.mmr_5v5);

    const modal =
        document.createElement('div');

    modal.className =
        'modal profile-modal';

    modal.innerHTML = `
        <div class="modal-content">

            <h3>Профиль игрока</h3>

            <img
                src="${getUserAvatar(data)}"
                style="
                    width:80px;
                    height:80px;
                    border-radius:50%;
                    margin:0 auto;
                    display:block;
                "
            >

            <p>
                <strong>Ник в игре:</strong>
                ${escapeHtml(data.inGameNick)}
            </p>

            <p>
                <strong>ID в игре:</strong>
                ${escapeHtml(data.inGameId)}
            </p>

            <p>
                <strong>1x1:</strong>
                MMR ${data.stats.mmr_1v1 || 0}
                ${getLevelIcon(level1)}
            </p>

            <p>
                <strong>2x2:</strong>
                MMR ${data.stats.mmr_2v2 || 0}
                ${getLevelIcon(level2)}
            </p>

            <p>
                <strong>5x5:</strong>
                MMR ${data.stats.mmr_5v5 || 0}
                ${getLevelIcon(level5)}
            </p>

            ${String(userId) !== String(currentUser.id)
                ? `
                    <button id="profileAddFriendBtn">
                        Добавить в друзья
                    </button>
                `
                : ''
            }

            ${data.isAdmin
                ? '<p><strong>👑 Администратор</strong></p>'
                : ''
            }

            <button class="close-modal">
                Закрыть
            </button>

        </div>
    `;

    document.body.appendChild(modal);

    if (String(userId) !== String(currentUser.id)) {
        document
            .getElementById('profileAddFriendBtn')
            ?.addEventListener('click', async () => {
                await sendFriendRequest(userId);
                modal.remove();
            });
    }

    modal
        .querySelector('.close-modal')
        ?.addEventListener('click', () => {
            modal.remove();
        });
}

function addAvatarHoverTooltip(element) {
    let tooltipDiv = null;

    const mouseenterHandler = async () => {
        const userId =
            element.getAttribute('data-id');

        if (!userId) return;

        const user =
            await apiCall(`/api/user/${userId}`);

        if (!user.success) return;

        const rect =
            element.getBoundingClientRect();

        tooltipDiv =
            document.createElement('div');

        tooltipDiv.className =
            'avatar-tooltip';

        tooltipDiv.innerHTML = `
            <div>
                <strong>ID на сайте:</strong>
                ${escapeHtml(user.userData.id)}
            </div>

            <div>
                <strong>Ник в игре:</strong>
                ${escapeHtml(user.userData.inGameNick)}
            </div>

            <div>
                <strong>ID в игре:</strong>
                ${escapeHtml(user.userData.inGameId)}
            </div>
        `;

        document.body.appendChild(tooltipDiv);

        tooltipDiv.style.left =
            `${rect.right + 8}px`;

        tooltipDiv.style.top =
            `${rect.top}px`;
    };

    const mouseleaveHandler = () => {
        if (tooltipDiv) {
            tooltipDiv.remove();
            tooltipDiv = null;
        }
    };

    element.addEventListener(
        'mouseenter',
        mouseenterHandler
    );

    element.addEventListener(
        'mouseleave',
        mouseleaveHandler
    );
}

// ------------------ PARTY ------------------

async function createParty() {
    if (!currentUser) return;

    const res = await apiCall(
        '/api/create-party',
        'POST',
        {
            leaderId: currentUser.id
        }
    );

    if (!res.success) {
        showNotification(
            res.message || 'Не удалось создать пати',
            'error'
        );
        return;
    }

    currentParty = {
        id: res.partyId,
        members: [currentUser.id],
        leaderId: currentUser.id
    };

    updatePartyUI();

    showNotification(
        `Пати создана! Код: ${res.partyId}`,
        'success'
    );
}

async function joinParty(partyCode) {
    if (!currentUser) return;

    const res = await apiCall(
        '/api/join-party',
        'POST',
        {
            partyId: partyCode,
            userId: currentUser.id
        }
    );

    if (res.success) {
        showNotification(
            'Вы присоединились к пати',
            'success'
        );
    } else {
        showNotification(
            res.message || 'Не удалось присоединиться',
            'error'
        );
    }
}

async function leaveParty(partyId) {
    if (!currentUser || !partyId) return;

    const res = await apiCall(
        '/api/leave-party',
        'POST',
        {
            partyId,
            userId: currentUser.id
        }
    );

    if (res.success) {
        currentParty = null;
        updatePartyUI();

        showNotification(
            'Вы вышли из пати',
            'info'
        );
    } else {
        showNotification(
            res.message || 'Не удалось выйти из пати',
            'error'
        );
    }
}

function updatePartyUI() {
    if (partyStatusDiv) {
        if (!currentParty) {
            partyStatusDiv.innerHTML = '';
        } else {
            const members =
                currentParty.members || [];

            partyStatusDiv.innerHTML = `
                Вы в пати
                (участников: ${members.length})

                Код пати:
                <strong>${escapeHtml(currentParty.id)}</strong>

                <button
                    id="copyPartyCodeBtn"
                    class="copy-code-btn"
                >
                    📋 Скопировать код
                </button>

                <button
                    id="leavePartyBtn"
                    class="leave-party-btn"
                >
                    Выйти из пати
                </button>
            `;

            document
                .getElementById('copyPartyCodeBtn')
                ?.addEventListener('click', async () => {
                    try {
                        await navigator.clipboard.writeText(
                            String(currentParty.id)
                        );

                        showNotification(
                            'Код пати скопирован',
                            'success'
                        );
                    } catch {
                        showNotification(
                            'Не удалось скопировать код',
                            'error'
                        );
                    }
                });

            document
                .getElementById('leavePartyBtn')
                ?.addEventListener('click', () => {
                    leaveParty(currentParty.id);
                });
        }
    }

    if (!partyMembersDiv) return;

    if (!currentParty || !currentParty.members?.length) {
        partyMembersDiv.style.display = 'none';
        return;
    }

    partyMembersDiv.style.display = 'block';

    if (partyMembersList) {
        partyMembersList.innerHTML = '';
    }

    currentParty.members.forEach(memberId => {
        if (String(memberId) === String(currentUser.id)) {
            partyMembersList.innerHTML += `
                <div>
                    <img
                        src="${getUserAvatar(currentUser)}"
                        class="mini-avatar"
                        data-id="${escapeHtml(memberId)}"
                    >

                    ${escapeHtml(currentUser.inGameNick)}
                    (${escapeHtml(currentUser.inGameId)})
                    — Вы
                </div>
            `;

            return;
        }

        apiCall(`/api/user/${memberId}`)
            .then(user => {
                if (!user.success) return;

                users[memberId] =
                    user.userData;

                const div =
                    document.createElement('div');

                div.innerHTML = `
                    <img
                        src="${getUserAvatar(user.userData)}"
                        class="mini-avatar"
                        data-id="${escapeHtml(memberId)}"
                    >

                    ${escapeHtml(user.userData.inGameNick)}
                    (${escapeHtml(user.userData.inGameId)})

                    <button
                        class="add-friend-from-party"
                        data-id="${escapeHtml(memberId)}"
                    >
                        Добавить в друзья
                    </button>
                `;

                partyMembersList.appendChild(div);

                const avatar =
                    div.querySelector('.mini-avatar');

                avatar?.addEventListener(
                    'click',
                    () => showUserProfile(memberId)
                );

                if (avatar) {
                    addAvatarHoverTooltip(avatar);
                }

                div
                    .querySelector('.add-friend-from-party')
                    ?.addEventListener(
                        'click',
                        () => sendFriendRequest(memberId)
                    );
            });
    });
}

function inviteToParty(friendId) {
    if (!currentParty) {
        showNotification(
            'Сначала создайте пати',
            'error'
        );
        return;
    }

    socket.emit('inviteToParty', {
        partyId: currentParty.id,
        targetUserId: friendId
    });

    showNotification(
        'Приглашение отправлено',
        'success'
    );
}

function showPartyInvite(invite) {
    const modal =
        document.createElement('div');

    modal.className = 'modal';

    modal.innerHTML = `
        <div class="modal-content">

            <h3>Приглашение в пати</h3>

            <p>
                ${escapeHtml(invite.fromName)}
                приглашает вас присоединиться к его пати.
            </p>

            <button id="acceptInviteBtn">
                Принять
            </button>

            <button id="declineInviteBtn">
                Отклонить
            </button>

        </div>
    `;

    document.body.appendChild(modal);

    document
        .getElementById('acceptInviteBtn')
        ?.addEventListener('click', () => {
            socket.emit(
                'acceptPartyInvite',
                {
                    partyId: invite.partyId
                }
            );

            modal.remove();

            showNotification(
                'Вы присоединились к пати',
                'success'
            );
        });

    document
        .getElementById('declineInviteBtn')
        ?.addEventListener('click', () => {
            modal.remove();
        });
}

// ------------------ MATCH ------------------

function showMatchFound(match) {
    currentMatch = match;
    showMatchFoundModal(match);
}

function showMatchFoundModal(match) {
    const old =
        document.getElementById('matchFoundModal');

    if (old) old.remove();

    if (matchTimerInterval) {
        clearInterval(matchTimerInterval);
    }

    const modal =
        document.createElement('div');

    modal.id = 'matchFoundModal';
    modal.className = 'match-found-modal';

    modal.innerHTML = `
        <div class="match-found-content">

            <h2>Матч найден!</h2>

            <p>
                Режим:
                ${escapeHtml(match.mode)}
                ${match.ranked ? 'Ранговый' : 'Обычный'}
            </p>

            <p>
                Карта:
                ${escapeHtml(match.map || '—')}
            </p>

            <div
                class="participants-list"
                id="matchParticipantsList"
            ></div>

            <div class="timer">
                Принять матч через:
                <span id="matchTimer">15</span>
                сек
            </div>

            <div class="match-buttons">
                <button id="modalAcceptBtn">
                    Принять
                </button>

                <button id="modalDeclineBtn">
                    Отклонить
                </button>
            </div>

        </div>
    `;

    document.body.appendChild(modal);
    activeModal = modal;

    const participantsContainer =
        document.getElementById(
            'matchParticipantsList'
        );

    for (const pid of match.participants || []) {
        apiCall(`/api/user/${pid}`)
            .then(user => {
                if (!user.success) return;

                users[pid] =
                    user.userData;

                const div =
                    document.createElement('div');

                div.className =
                    'participant';

                div.innerHTML = `
                    <img
                        src="${getUserAvatar(user.userData)}"
                        class="participant-avatar"
                        data-id="${escapeHtml(pid)}"
                    >

                    <span class="participant-name">
                        ${escapeHtml(user.userData.inGameNick)}
                        (${escapeHtml(user.userData.inGameId)})
                    </span>
                `;

                participantsContainer.appendChild(div);

                div
                    .querySelector('.participant-avatar')
                    ?.addEventListener(
                        'click',
                        () => showUserProfile(pid)
                    );

                const avatar =
                    div.querySelector('.participant-avatar');

                if (avatar) {
                    addAvatarHoverTooltip(avatar);
                }
            });
    }

    let timeLeft = 15;

    const timerSpan =
        document.getElementById('matchTimer');

    matchTimerInterval =
        setInterval(() => {
            timeLeft--;

            if (timerSpan) {
                timerSpan.textContent =
                    String(timeLeft);
            }

            if (timeLeft <= 0) {
                clearInterval(matchTimerInterval);
                declineMatch(match.matchId);
                modal.remove();
            }
        }, 1000);

    document
        .getElementById('modalAcceptBtn')
        ?.addEventListener('click', () => {
            clearInterval(matchTimerInterval);
            acceptMatch(match.matchId);
            modal.remove();
        });

    document
        .getElementById('modalDeclineBtn')
        ?.addEventListener('click', () => {
            clearInterval(matchTimerInterval);
            declineMatch(match.matchId);
            modal.remove();
        });
}

function acceptMatch(matchId) {
    socket.emit('acceptMatch', {
        matchId
    });
}

function declineMatch(matchId) {
    socket.emit('declineMatch', {
        matchId
    });

    if (activeMatchInfoDiv) {
        activeMatchInfoDiv.style.display = 'none';
    }

    currentMatch = null;

    if (matchTimerInterval) {
        clearInterval(matchTimerInterval);
    }
}

// ------------------ DRAFT ------------------

function handleDraftStart(data) {
    const old =
        document.getElementById('draftModal');

    if (old) old.remove();

    const draftModal =
        document.createElement('div');

    draftModal.id = 'draftModal';
    draftModal.className = 'modal';

    draftModal.innerHTML = `
        <div class="modal-content">

            <h3>Выбор команд</h3>

            <p>
                Капитаны по очереди выбирают игроков.
            </p>

            <div id="draftStatus"></div>
            <div id="draftPlayers"></div>
            <div id="draftTeams"></div>

        </div>
    `;

    document.body.appendChild(draftModal);

    const updateDraftUI = () => {
        const statusDiv =
            document.getElementById('draftStatus');

        const playersDiv =
            document.getElementById('draftPlayers');

        const teamsDiv =
            document.getElementById('draftTeams');

        if (!statusDiv) return;

        data.captains =
            data.captains || [];

        data.remainingPlayers =
            data.remainingPlayers || [];

        data.teamA =
            data.teamA || [];

        data.teamB =
            data.teamB || [];

        const captainId =
            data.captains.length
                ? data.captains[
                    data.turn % data.captains.length
                ]
                : null;

        const captain =
            users[captainId];

        statusDiv.innerHTML = `
            <strong>Капитаны:</strong>
            ${data.captains
                .map(id =>
                    escapeHtml(
                        users[id]?.inGameNick || id
                    )
                )
                .join(' vs ')
            }

            <br>

            <strong>Ход:</strong>
            ${
                String(captainId) === String(currentUser.id)
                    ? 'Ваш ход!'
                    : `Выбирает ${escapeHtml(
                        captain?.inGameNick || 'Игрок'
                    )}`
            }
        `;

        playersDiv.innerHTML = `
            <strong>Доступные игроки:</strong>
            <br>

            ${data.remainingPlayers
                .map(pid => {
                    const user =
                        users[pid] || {};

                    const canPick =
                        String(captainId) ===
                        String(currentUser.id);

                    return `
                        <div>
                            ${escapeHtml(
                                user.inGameNick || pid
                            )}
                            (${escapeHtml(
                                user.inGameId || ''
                            )})

                            ${
                                canPick
                                    ? `
                                        <button
                                            class="pick-btn"
                                            data-id="${escapeHtml(pid)}"
                                        >
                                            Выбрать
                                        </button>
                                    `
                                    : ''
                            }
                        </div>
                    `;
                })
                .join('')
            }
        `;

        teamsDiv.innerHTML = `
            <strong>Команда A:</strong>
            ${data.teamA
                .map(id =>
                    escapeHtml(
                        users[id]?.inGameNick || id
                    )
                )
                .join(', ') || '—'
            }

            <br>

            <strong>Команда B:</strong>
            ${data.teamB
                .map(id =>
                    escapeHtml(
                        users[id]?.inGameNick || id
                    )
                )
                .join(', ') || '—'
            }
        `;

        playersDiv
            .querySelectorAll('.pick-btn')
            .forEach(btn => {
                btn.addEventListener('click', () => {
                    socket.emit(
                        'draftPick',
                        {
                            matchId:
                                currentMatch.matchId,

                            pickedUserId:
                                btn.dataset.id
                        }
                    );
                });
            });
    };

    updateDraftUI();

    socket.on('draftUpdate', update => {
        data.remainingPlayers =
            update.remainingPlayers || [];

        data.teamA =
            update.teamA || [];

        data.teamB =
            update.teamB || [];

        data.turn =
            update.turn || 0;

        updateDraftUI();

        if (!data.remainingPlayers.length) {
            draftModal.remove();
        }
    });

    socket.once('mapVoteStart', voteData => {
        draftModal.remove();

        showMapVote(voteData);
    });
}

function showMapVote(voteData) {
    const voteModal =
        document.createElement('div');

    voteModal.className = 'modal';

    voteModal.innerHTML = `
        <div class="modal-content">

            <h3>Голосование за карту</h3>

            <div id="voteButtons"></div>

        </div>
    `;

    document.body.appendChild(voteModal);

    const buttonsDiv =
        voteModal.querySelector('#voteButtons');

    (voteData.maps || []).forEach(map => {
        const btn =
            document.createElement('button');

        btn.textContent = map;

        btn.addEventListener('click', () => {
            socket.emit(
                'mapVote',
                {
                    matchId:
                        currentMatch.matchId,

                    mapName: map
                }
            );

            voteModal.remove();
        });

        buttonsDiv.appendChild(btn);
    });
}

// ------------------ LOBBY ------------------

function openLobby(match) {
    if (matchTimerInterval) {
        clearInterval(matchTimerInterval);
    }

    const old =
        document.getElementById('lobbyModal');

    if (old) old.remove();

    currentMatch = match;

    const lobbyDiv =
        document.createElement('div');

    lobbyDiv.id = 'lobbyModal';
    lobbyDiv.className = 'modal';

    lobbyDiv.innerHTML = `
        <div class="modal-content">

            <h3>Лобби матча</h3>

            <p>
                Режим:
                ${escapeHtml(match.mode)}
                ${match.ranked ? 'Ранговый' : 'Обычный'}
            </p>

            <p>
                Карта:
                ${escapeHtml(match.map || '—')}
            </p>

            <div>
                <strong>Команда A:</strong>
                ${(match.teamA || [])
                    .map(pid =>
                        escapeHtml(
                            users[pid]?.inGameNick || pid
                        )
                    )
                    .join(', ') || '—'
                }
            </div>

            <div>
                <strong>Команда B:</strong>
                ${(match.teamB || [])
                    .map(pid =>
                        escapeHtml(
                            users[pid]?.inGameNick || pid
                        )
                    )
                    .join(', ') || '—'
                }
            </div>

            <div style="
                background:#0f172a;
                padding:10px;
                border-radius:8px;
                margin:10px 0;
            ">
                <strong>⚠️ Инструкция:</strong>
                После завершения матча загрузите
                скриншот итогов.
                Модератор проверит результат
                и начислит MMR.
            </div>

            <div
                id="lobbyParticipants"
                style="margin:10px 0;"
            ></div>

            <div
                id="lobbyChatMessages"
                class="lobby-chat"
            ></div>

            <div class="lobby-input">

                <input
                    type="text"
                    id="lobbyChatInput"
                    placeholder="Чат лобби"
                >

                <button id="lobbySendBtn">
                    Отправить
                </button>

            </div>

            <div id="screenshotArea">

                <input
                    type="file"
                    id="screenshotUpload"
                    accept="image/*"
                >

                <button id="uploadScreenshotBtn">
                    Загрузить скриншот
                </button>

            </div>

            <button id="closeLobbyBtn">
                Закрыть
            </button>

        </div>
    `;

    document.body.appendChild(lobbyDiv);

    const participantsContainer =
        document.getElementById(
            'lobbyParticipants'
        );

    participantsContainer.innerHTML =
        '<h4>Участники:</h4>';

    for (const pid of match.participants || []) {
        apiCall(`/api/user/${pid}`)
            .then(user => {
                if (!user.success) return;

                users[pid] =
                    user.userData;

                const div =
                    document.createElement('div');

                div.style.margin = '5px 0';

                div.innerHTML = `
                    <img
                        src="${getUserAvatar(user.userData)}"
                        style="
                            width:24px;
                            height:24px;
                            border-radius:50%;
                            vertical-align:middle;
                            margin-right:8px;
                            cursor:pointer;
                        "
                        class="lobby-avatar"
                        data-id="${escapeHtml(pid)}"
                    >

                    ${escapeHtml(
                        user.userData.inGameNick
                    )}

                    (ID:
                    ${escapeHtml(
                        user.userData.inGameId
                    )})

                    ${
                        String(pid) !==
                        String(currentUser.id)
                            ? `
                                <button
                                    class="add-friend-lobby"
                                    data-id="${escapeHtml(pid)}"
                                >
                                    Добавить в друзья
                                </button>
                            `
                            : ''
                    }
                `;

                participantsContainer.appendChild(div);

                const avatar =
                    div.querySelector('.lobby-avatar');

                avatar?.addEventListener(
                    'click',
                    () => showUserProfile(pid)
                );

                if (avatar) {
                    addAvatarHoverTooltip(avatar);
                }

                div
                    .querySelector('.add-friend-lobby')
                    ?.addEventListener(
                        'click',
                        () => sendFriendRequest(pid)
                    );
            });
    }

    const lobbyInput =
        document.getElementById(
            'lobbyChatInput'
        );

    const lobbySend =
        document.getElementById(
            'lobbySendBtn'
        );

    const uploadBtn =
        document.getElementById(
            'uploadScreenshotBtn'
        );

    const fileInput =
        document.getElementById(
            'screenshotUpload'
        );

    const closeBtn =
        document.getElementById(
            'closeLobbyBtn'
        );

    lobbySend?.addEventListener(
        'click',
        () => {
            const text =
                lobbyInput.value.trim();

            if (!text) return;

            socket.emit(
                'lobbyChat',
                {
                    matchId: match.matchId,
                    text
                }
            );

            lobbyInput.value = '';
        }
    );

    lobbyInput?.addEventListener(
        'keypress',
        e => {
            if (e.key === 'Enter') {
                lobbySend.click();
            }
        }
    );

    uploadBtn?.addEventListener(
        'click',
        async () => {
            const file =
                fileInput.files[0];

            if (!file) {
                showNotification(
                    'Выберите скриншот',
                    'error'
                );
                return;
            }

            const formData =
                new FormData();

            formData.append(
                'screenshot',
                file
            );

            formData.append(
                'matchId',
                match.matchId
            );

            formData.append(
                'userId',
                currentUser.id
            );

            try {
                const res =
                    await fetch(
                        '/api/upload-screenshot',
                        {
                            method: 'POST',
                            body: formData
                        }
                    );

                const data =
                    await res.json();

                if (data.success) {
                    showNotification(
                        'Скриншот загружен',
                        'success'
                    );
                } else {
                    showNotification(
                        data.message ||
                        'Ошибка загрузки',
                        'error'
                    );
                }
            } catch {
                showNotification(
                    'Ошибка загрузки',
                    'error'
                );
            }
        }
    );

    closeBtn?.addEventListener(
        'click',
        () => {
            leaveAllQueues();

            if (currentParty) {
                leaveParty(
                    currentParty.id
                );
            }

            lobbyDiv.remove();

            currentMatch = null;
        }
    );
}

// ------------------ GLOBAL CHAT ------------------

function addChatMessage(msg) {
    if (!chatMessagesDiv) return;

    const div =
        document.createElement('div');

    div.className =
        'chat-message';

    div.innerHTML = `
        <img
            src="${getUserAvatar({
                avatar: msg.avatar
            })}"
            class="chat-avatar"
            data-id="${escapeHtml(msg.userId)}"
            style="cursor:pointer;"
        >

        <strong>
            ${escapeHtml(
                msg.inGameNick ||
                msg.username ||
                'Игрок'
            )}
        </strong>:

        <span>
            ${escapeHtml(msg.text)}
        </span>

        <small>
            ${escapeHtml(msg.date || '')}
        </small>
    `;

    chatMessagesDiv.appendChild(div);

    chatMessagesDiv.scrollTop =
        chatMessagesDiv.scrollHeight;

    const avatar =
        div.querySelector('.chat-avatar');

    avatar?.addEventListener(
        'click',
        () => showUserProfile(msg.userId)
    );

    if (avatar) {
        addAvatarHoverTooltip(avatar);
    }
}

function sendGlobalChat() {
    const input =
        document.getElementById('chatInput');

    if (!input || !currentUser) return;

    const text =
        input.value.trim();

    if (!text) return;

    socket.emit(
        'chatMessage',
        text
    );

    input.value = '';
}

// ------------------ PRIVATE CHAT ------------------

function openPrivateChatModal(userId, userNick) {
    const modal =
        document.createElement('div');

    modal.className = 'modal';

    modal.innerHTML = `
        <div
            class="modal-content"
            style="max-width:500px;"
        >

            <h3>
                Личный чат с
                ${escapeHtml(userNick)}
            </h3>

            <div
                id="privateChatMessages"
                class="chat-messages"
                style="height:300px;"
            ></div>

            <div class="chat-input">

                <input
                    type="text"
                    id="privateChatInput"
                    placeholder="Сообщение..."
                >

                <button id="privateChatSendBtn">
                    Отправить
                </button>

            </div>

            <button id="closePrivateChatBtn">
                Закрыть
            </button>

        </div>
    `;

    document.body.appendChild(modal);

    const container =
        modal.querySelector(
            '#privateChatMessages'
        );

    const input =
        modal.querySelector(
            '#privateChatInput'
        );

    const sendBtn =
        modal.querySelector(
            '#privateChatSendBtn'
        );

    const closeBtn =
        modal.querySelector(
            '#closePrivateChatBtn'
        );

    const history =
        privateHistory.filter(msg =>
            (
                String(msg.from) === String(userId) &&
                String(msg.to) === String(currentUser.id)
            ) ||
            (
                String(msg.from) === String(currentUser.id) &&
                String(msg.to) === String(userId)
            )
        );

    history.forEach(msg => {
        renderPrivateMessage(
            container,
            msg,
            userNick
        );
    });

    container.scrollTop =
        container.scrollHeight;

    const privateHandler = msg => {
        const related =
            (
                String(msg.from) === String(userId) &&
                String(msg.to) === String(currentUser.id)
            ) ||
            (
                String(msg.from) === String(currentUser.id) &&
                String(msg.to) === String(userId)
            );

        if (!related) return;

        privateHistory.push(msg);

        renderPrivateMessage(
            container,
            msg,
            userNick
        );
    };

    socket.on(
        'privateMessage',
        privateHandler
    );

    sendBtn?.addEventListener(
        'click',
        () => {
            const text =
                input.value.trim();

            if (!text) return;

            socket.emit(
                'privateMessage',
                {
                    toUserId: userId,
                    text
                }
            );

            input.value = '';
        }
    );

    input?.addEventListener(
        'keypress',
        e => {
            if (e.key === 'Enter') {
                sendBtn.click();
            }
        }
    );

    closeBtn?.addEventListener(
        'click',
        () => {
            socket.off(
                'privateMessage',
                privateHandler
            );

            modal.remove();
        }
    );
}

function renderPrivateMessage(
    container,
    msg,
    userNick
) {
    const div =
        document.createElement('div');

    div.className =
        'chat-message';

    const isMine =
        String(msg.from) ===
        String(currentUser.id);

    div.innerHTML = `
        <strong>
            ${isMine
                ? 'Вы'
                : escapeHtml(userNick)
            }:
        </strong>

        ${escapeHtml(msg.text)}

        <small>
            ${escapeHtml(
                msg.date ||
                new Date().toLocaleString()
            )}
        </small>
    `;

    container.appendChild(div);

    container.scrollTop =
        container.scrollHeight;
}

// ------------------ SEARCH ------------------

async function searchUsers(query) {
    const q =
        query.trim();

    const results =
        document.getElementById(
            'friendSearchResults'
        );

    if (!results) return;

    if (!q) {
        results.innerHTML =
            '<p class="muted-text">Введите игровой ник, игровой ID или ID пользователя.</p>';
        return;
    }

    results.innerHTML =
        '<p class="muted-text">Поиск...</p>';

    const res =
        await apiCall(
            `/api/search-users?q=${encodeURIComponent(q)}`
        );

    if (!res.success || !res.users?.length) {
        results.innerHTML =
            '<p class="muted-text">Игроки не найдены.</p>';
        return;
    }

    results.innerHTML =
        res.users.map(user => `
            <div class="friend-item friend-search-item">

                <img
                    src="${getUserAvatar(user)}"
                    class="friend-avatar"
                    data-id="${escapeHtml(user.id)}"
                >

                <div class="friend-search-info">
                    <strong>
                        ${escapeHtml(
                            user.inGameNick || 'Игрок'
                        )}
                    </strong>

                    <small>
                        ID:
                        ${escapeHtml(
                            user.inGameId || user.id
                        )}
                    </small>
                </div>

                <button
                    class="add-search-friend"
                    data-id="${escapeHtml(user.id)}"
                >
                    Добавить
                </button>

            </div>
        `).join('');

    results
        .querySelectorAll('.friend-avatar')
        .forEach(img => {
            img.addEventListener(
                'click',
                () => showUserProfile(img.dataset.id)
            );
        });

    results
        .querySelectorAll('.add-search-friend')
        .forEach(btn => {
            btn.addEventListener(
                'click',
                async () => {
                    await sendFriendRequest(
                        btn.dataset.id
                    );

                    btn.disabled = true;
                    btn.textContent =
                        'Отправлено';
                }
            );
        });
}

function setupFriendSearch() {
    const input =
        document.getElementById(
            'friendSearchInput'
        );

    const btn =
        document.getElementById(
            'friendSearchBtn'
        );

    if (!input || !btn) return;

    const run = () =>
        searchUsers(input.value);

    btn.addEventListener(
        'click',
        run
    );

    input.addEventListener(
        'keypress',
        e => {
            if (e.key === 'Enter') {
                run();
            }
        }
    );
}

// ------------------ TOP ------------------

async function loadTopLeaderboard() {
    const res =
        await apiCall('/api/top-players');

    if (!res.success) return;

    topPlayersData =
        res.data;

    renderTop();
}

function renderTop() {
    const container =
        document.getElementById(
            'topView'
        );

    if (!container) return;

    if (!topPlayersData) {
        container.innerHTML =
            '<p>Загрузка...</p>';
        return;
    }

    container.innerHTML = `
        <h2>Топ игроков по победам</h2>

        <div class="top-tabs">

            <button
                class="top-tab active"
                data-period="day"
            >
                За день
            </button>

            <button
                class="top-tab"
                data-period="week"
            >
                За неделю
            </button>

            <button
                class="top-tab"
                data-period="month"
            >
                За месяц
            </button>

        </div>

        <div id="topTable"></div>
    `;

    const showPeriod = period => {
        const players =
            topPlayersData[period] || [];

        const table =
            document.getElementById(
                'topTable'
            );

        if (!table) return;

        table.innerHTML = `
            <table class="top-table">

                <thead>
                    <tr>
                        <th>#</th>
                        <th>Игрок</th>
                        <th>Победы</th>
                    </tr>
                </thead>

                <tbody>

                    ${players.map((p, idx) => `
                        <tr>

                            <td>
                                ${idx + 1}
                            </td>

                            <td>
                                <img
                                    src="${getUserAvatar(p.userData)}"
                                    class="top-avatar"
                                >

                                ${escapeHtml(
                                    p.userData.inGameNick
                                )}
                            </td>

                            <td>
                                ${p.wins || 0}
                            </td>

                        </tr>
                    `).join('')}

                </tbody>

            </table>
        `;
    };

    container
        .querySelectorAll('.top-tab')
        .forEach(tab => {
            tab.addEventListener(
                'click',
                () => {
                    container
                        .querySelectorAll('.top-tab')
                        .forEach(t =>
                            t.classList.remove(
                                'active'
                            )
                        );

                    tab.classList.add('active');

                    showPeriod(
                        tab.dataset.period
                    );
                }
            );
        });

    showPeriod('day');
}

// ------------------ CLANS ------------------

async function loadClanInfo() {
    if (!currentUser) return;

    const clanContainer =
        document.getElementById(
            'clanView'
        );

    if (!clanContainer) return;

    const res =
        await apiCall(
            `/api/clan-info?userId=${encodeURIComponent(currentUser.id)}`
        );

    if (res.success && res.clan) {
        const clan =
            res.clan;

        clanContainer.innerHTML = `
            <h2>
                Клан:
                ${escapeHtml(clan.tag)}
                |
                ${escapeHtml(clan.name)}
            </h2>

            <p>
                Создатель:
                ${escapeHtml(
                    users[clan.ownerId]?.inGameNick ||
                    clan.ownerId ||
                    '—'
                )}
            </p>

            <p>
                Участники:
                ${clan.members?.length || 0}
                /
                ${clan.maxMembers || 0}
            </p>

            <ul id="clanMembersList">
                ${(clan.members || [])
                    .map(member => `
                        <li>
                            <img
                                src="${getUserAvatar(member)}"
                                class="clan-avatar"
                            >

                            ${escapeHtml(
                                member.inGameNick || 'Игрок'
                            )}
                        </li>
                    `)
                    .join('')
                }
            </ul>

            <button
                id="leaveClanBtn"
                class="glow-btn"
            >
                Покинуть клан
            </button>
        `;

        document
            .getElementById('leaveClanBtn')
            ?.addEventListener(
                'click',
                async () => {
                    const result =
                        await apiCall(
                            '/api/leave-clan',
                            'POST',
                            {
                                userId:
                                    currentUser.id
                            }
                        );

                    if (result.success) {
                        showNotification(
                            'Вы вышли из клана',
                            'success'
                        );

                        loadClanInfo();
                    } else {
                        showNotification(
                            result.message ||
                            'Ошибка',
                            'error'
                        );
                    }
                }
            );

        return;
    }

    clanContainer.innerHTML = `
        <h2>Клан</h2>

        <p>
            Вы не состоите в клане.
        </p>

        <div>

            <input
                type="text"
                id="clanTag"
                placeholder="Тег клана (до 5 символов)"
                maxlength="5"
            >

            <input
                type="text"
                id="clanName"
                placeholder="Название клана (до 32 символов)"
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
                placeholder="ID клана для присоединения"
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
                            userId:
                                currentUser.id,

                            clanTag:
                                tag,

                            clanName:
                                name
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
                        result.message ||
                        'Ошибка',
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
                            userId:
                                currentUser.id,

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
                        result.message ||
                        'Ошибка',
                        'error'
                    );
                }
            }
        );
}

// ------------------ CHANGE NICK ------------------

async function changeInGameNick(newNick) {
    if (!currentUser || !newNick) return;

    const res =
        await apiCall(
            '/api/change-nick',
            'POST',
            {
                userId:
                    currentUser.id,

                newNick
            }
        );

    if (res.success) {
        currentUser.inGameNick =
            newNick;

        updateUI();

        showNotification(
            'Ник изменён',
            'success'
        );
    } else {
        showNotification(
            res.message ||
            'Ошибка изменения ника',
            'error'
        );
    }
}

// ------------------ NAVIGATION ------------------

function setupNavigation() {
    const btns =
        document.querySelectorAll(
            '.nav-btn'
        );

    const views = {
        play:
            document.getElementById('playView'),

        profile:
            document.getElementById('profileView'),

        history:
            document.getElementById('historyView'),

        friends:
            document.getElementById('friendsView'),

        chat:
            document.getElementById('chatView'),

        top:
            document.getElementById('topView'),

        clan:
            document.getElementById('clanView')
    };

    btns.forEach(btn => {
        btn.addEventListener(
            'click',
            () => {
                const view =
                    btn.dataset.view;

                btns.forEach(b =>
                    b.classList.remove(
                        'active'
                    )
                );

                btn.classList.add('active');

                Object.values(views)
                    .forEach(v => {
                        if (v) {
                            v.style.display =
                                'none';
                        }
                    });

                if (views[view]) {
                    views[view].style.display =
                        'block';
                }

                if (view === 'friends') {
                    loadFriends();
                }

                if (view === 'top') {
                    renderTop();
                }

                if (view === 'clan') {
                    loadClanInfo();
                }
            }
        );
    });
}

// ------------------ QUEUE BUTTONS ------------------

function setupQueueButtons() {
    document
        .querySelectorAll('.queue-mode-btn')
        .forEach(btn => {
            btn.addEventListener(
                'click',
                () => {
                    if (!currentUser) return;

                    joinQueue(
                        btn.dataset.mode,
                        btn.dataset.ranked === 'true'
                    );
                }
            );
        });

    document
        .querySelectorAll('.leave-queue-btn')
        .forEach(btn => {
            btn.addEventListener(
                'click',
                () => {
                    if (!currentUser) return;

                    leaveQueue(
                        btn.dataset.mode,
                        btn.dataset.ranked === 'true'
                    );
                }
            );
        });
}

// ------------------ AUTH UI ------------------

function showLoginForm() {
    const login =
        document.getElementById(
            'loginForm'
        );

    const register =
        document.getElementById(
            'registerForm'
        );

    if (login) login.style.display = 'block';
    if (register) register.style.display = 'none';
}

function showRegisterForm() {
    const login =
        document.getElementById(
            'loginForm'
        );

    const register =
        document.getElementById(
            'registerForm'
        );

    if (login) login.style.display = 'none';
    if (register) register.style.display = 'block';
}

// ------------------ EVENTS ------------------

document.addEventListener(
    'click',
    e => {
        if (
            e.target.closest(
                'button, .queue-mode-btn, .leave-queue-btn, .nav-btn, .friend-item button, .accept-request, .reject-request, #createPartyBtn, #joinPartyBtn, #chatSendBtn, #searchBtn'
            )
        ) {
            createParticles(
                e.clientX,
                e.clientY
            );
        }
    }
);

document
    .getElementById('doLoginBtn')
    ?.addEventListener(
        'click',
        () => {
            const username =
                document
                    .getElementById('loginUsername')
                    .value
                    .trim();

            const password =
                document
                    .getElementById('loginPassword')
                    .value;

            if (!username || !password) {
                authMessage.textContent =
                    'Введите логин и пароль';
                return;
            }

            login(
                username,
                password
            );
        }
    );

document
    .getElementById('doRegisterBtn')
    ?.addEventListener(
        'click',
        () => {
            const username =
                document
                    .getElementById('regUsername')
                    .value
                    .trim();

            const password =
                document
                    .getElementById('regPassword')
                    .value;

            const confirm =
                document
                    .getElementById('regPasswordConfirm')
                    .value;

            const inGameNick =
                document
                    .getElementById('regInGameNick')
                    .value
                    .trim();

            const inGameId =
                document
                    .getElementById('regInGameId')
                    .value
                    .trim();

            if (password !== confirm) {
                authMessage.textContent =
                    'Пароли не совпадают';
                return;
            }

            if (
                !username ||
                !password ||
                !inGameNick ||
                !inGameId
            ) {
                authMessage.textContent =
                    'Заполните все поля';
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
    .getElementById('showRegisterLink')
    ?.addEventListener(
        'click',
        e => {
            e.preventDefault();
            showRegisterForm();
        }
    );

document
    .getElementById('showLoginLink')
    ?.addEventListener(
        'click',
        e => {
            e.preventDefault();
            showLoginForm();
        }
    );

document
    .getElementById('logoutBtn')
    ?.addEventListener(
        'click',
        () => {
            localStorage.removeItem('userId');
            localStorage.removeItem('loginTime');

            socket.disconnect();

            location.reload();
        }
    );

document
    .getElementById('createPartyBtn')
    ?.addEventListener(
        'click',
        createParty
    );

document
    .getElementById('joinPartyBtn')
    ?.addEventListener(
        'click',
        () => {
            const input =
                document.getElementById(
                    'joinPartyCode'
                );

            const partyCode =
                input?.value.trim();

            if (partyCode) {
                joinParty(partyCode);
            }
        }
    );

document
    .getElementById('chatSendBtn')
    ?.addEventListener(
        'click',
        sendGlobalChat
    );

document
    .getElementById('chatInput')
    ?.addEventListener(
        'keypress',
        e => {
            if (e.key === 'Enter') {
                sendGlobalChat();
            }
        }
    );

// ------------------ AVATAR EVENTS ------------------

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
    () => avatarUpload?.click()
);

avatarUpload?.addEventListener(
    'change',
    async e => {
        const file =
            e.target.files?.[0];

        if (file) {
            await uploadAvatar(file);
        }

        e.target.value = '';
    }
);

// ------------------ PROFILE INFO ------------------

profileInfoIcon?.addEventListener(
    'mouseenter',
    () => {
        const rect =
            profileInfoIcon.getBoundingClientRect();

        if (!tooltip) return;

        tooltip.style.display = 'block';

        tooltip.style.left =
            `${rect.right + 8}px`;

        tooltip.style.top =
            `${rect.top}px`;
    }
);

profileInfoIcon?.addEventListener(
    'mouseleave',
    () => {
        if (tooltip) {
            tooltip.style.display = 'none';
        }
    }
);

// ------------------ CHANGE NICK EVENT ------------------

const changeNickBtn =
    document.getElementById(
        'changeNickBtn'
    );

const newNickInput =
    document.getElementById(
        'newInGameNick'
    );

changeNickBtn?.addEventListener(
    'click',
    () => {
        const newNick =
            newNickInput?.value.trim();

        if (!newNick) {
            showNotification(
                'Введите новый ник',
                'error'
            );
            return;
        }

        changeInGameNick(newNick);
    }
);

// ------------------ SOCKET ------------------

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
    reason => {
        console.log(
            'Socket disconnected:',
            reason
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
        document
            .getElementById('matchFoundModal')
            ?.remove();

        if (matchTimerInterval) {
            clearInterval(matchTimerInterval);
        }

        if (activeMatchInfoDiv) {
            activeMatchInfoDiv.style.display =
                'none';
        }

        currentMatch = null;

        showNotification(
            'Матч отменён, кто-то не принял',
            'error'
        );

        leaveAllQueues();

        if (currentParty) {
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

        leaveAllQueues();

        if (currentParty) {
            leaveParty(
                currentParty.id
            );
        }
    }
);

socket.on(
    'friendRequest',
    data => {
        showNotification(
            `Новая заявка в друзья от ${data.fromName}`,
            'info'
        );

        if (!currentUser) return;

        currentUser.pendingRequests =
            currentUser.pendingRequests || [];

        if (!currentUser.pendingRequests.some(
            id => String(id) === String(data.from)
        )) {
            currentUser.pendingRequests.push(
                data.from
            );
        }

        loadFriends();
    }
);

socket.on(
    'friendAdded',
    friendId => {
        if (!currentUser) return;

        currentUser.friends =
            currentUser.friends || [];

        if (!currentUser.friends.some(
            id => String(id) === String(friendId)
        )) {
            currentUser.friends.push(
                friendId
            );

            loadFriends();
        }
    }
);

socket.on(
    'partyUpdate',
    party => {
        currentParty =
            party;

        updatePartyUI();
    }
);

socket.on(
    'partyInvite',
    invite => {
        showNotification(
            `${invite.fromName} приглашает вас в пати`,
            'info'
        );

        showPartyInvite(invite);
    }
);

socket.on(
    'chatMessage',
    msg => {
        addChatMessage(msg);
    }
);

socket.on(
    'chatHistory',
    history => {
        if (!chatMessagesDiv) return;

        chatMessagesDiv.innerHTML = '';

        (history || []).forEach(
            msg => addChatMessage(msg)
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
    'queueError',
    err => {
        showNotification(
            err?.message ||
            'Ошибка очереди',
            'error'
        );
    }
);

socket.on(
    'muted',
    data => {
        showNotification(
            `Вы замьючены до ${new Date(data.until).toLocaleString()}. Причина: ${data.reason}`,
            'error'
        );
    }
);

socket.on(
    'banned',
    data => {
        showNotification(
            `Вы забанены до ${new Date(data.until).toLocaleString()}. Причина: ${data.reason}`,
            'error'
        );

        setTimeout(
            () => location.reload(),
            3000
        );
    }
);

// ------------------ START ------------------

setupNavigation();
setupFriendSearch();
setupQueueButtons();

tryAutoLogin();
