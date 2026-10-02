const socket=io();
let me=null,party=null,currentMatch=null,pmTarget=null,pmHistory=[],queueMine={};
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function avatar(u){
  const src=u?.avatar||'';
  if(src)return src;
  return 'data:image/svg+xml;charset=UTF-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="#243147"/><text x="40" y="49" text-anchor="middle" fill="#9fb5d5" font-size="28">?</text></svg>');
}
function toast(t,type='info'){
  const x=$('toast');if(!x)return;
  x.textContent=t;x.className=type;x.style.display='block';
  clearTimeout(toast.t);toast.t=setTimeout(()=>x.style.display='none',3500);
}
async function api(url,opt={}){
  const r=await fetch(url,opt);let d={};
  try{d=await r.json()}catch{}
  if(!r.ok)throw Error(d.message||'Ошибка сервера');
  return d;
}
const post=(u,b)=>api(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
function modal(html){
  const root=$('modalRoot');
  root.innerHTML=html;
  // Принудительно держим модальное окно по центру экрана, а не внизу длинного списка.
  root.style.position='fixed';
  root.style.inset='0';
  root.style.display='flex';
  root.style.alignItems='center';
  root.style.justifyContent='center';
  root.style.overflowY='auto';
  root.style.boxSizing='border-box';
  root.style.zIndex='9999';
  const box=root.firstElementChild;
  if(box){
    box.style.margin='auto';
    box.style.maxHeight='calc(100vh - 24px)';
    box.style.overflowY='auto';
    box.style.boxSizing='border-box';
  }
  return box;
}
function closeModal(){
  const root=$('modalRoot');
  if(!root)return;
  root.innerHTML='';
  root.style.display='none';
}
function saveSession(){localStorage.setItem('legendpl_user',me.id)}
function clearSession(){localStorage.removeItem('legendpl_user')}
function normalizeAdmin(u){
  // Для аккаунта ыж1 показываем админ-раздел на клиенте.
  // Сервер всё равно должен проверять права на API.
  if(u && String(u.username||'').toLowerCase()==='ыж1')u.isAdmin=true;
  return u;
}
async function login(){
  try{
    const d=await post('/api/login',{username:$('loginUsername').value,password:$('loginPassword').value});
    me=normalizeAdmin(d.user);party=d.party;saveSession();enter();toast('Вход выполнен','success');
  }catch(e){$('authMsg').textContent=e.message}
}
async function register(){
  if($('regPassword').value!==$('regConfirm').value){$('authMsg').textContent='Пароли не совпадают';return}
  try{
    const d=await post('/api/register',{username:$('regUsername').value,password:$('regPassword').value,inGameNick:$('regNick').value,inGameId:$('regId').value});
    $('authMsg').textContent=d.message;$('showLogin').click();
  }catch(e){$('authMsg').textContent=e.message}
}
async function enter(){
  $('auth').hidden=true;$('auth').style.display='none';
  $('app').hidden=false;$('app').style.display='block';
  socket.emit('auth',me.id);
  renderMe();renderParty();renderModes();loadFriends();loadTop('1v1');loadHistory();loadPMData();
  if(me.isAdmin)$('adminNav').hidden=false;
}
async function boot(){
  const id=localStorage.getItem('legendpl_user');
  if(!id)return;
  try{
    const d=await api('/api/me?userId='+encodeURIComponent(id));
    me=normalizeAdmin(d.user);party=d.party;enter();
  }catch(e){clearSession();$('auth').hidden=false;$('auth').style.display='flex';$('app').hidden=true;$('app').style.display='none'}
}
function renderMe(){
  if(!me)return;
  $('myAvatar').src=avatar(me);$('myNick').textContent=me.inGameNick;
  $('myLevel').textContent='Уровень '+(me.stats['1v1'].level||1);
  $('profileAvatar').src=avatar(me);$('profileNick').textContent=(me.isAdmin?'👑 ADMIN · ':'')+me.inGameNick;
  $('profileIds').textContent=`Логин: ${me.username} · ID: ${me.id} · Game ID: ${me.inGameId}`;
  const g=$('statsGrid');
  g.innerHTML=Object.entries({'1v1':'1x1 Дуэль','2v2':'2x2 Напарники','5v5':'5x5 Соревновательный'}).map(([m,n])=>{
    const s=me.stats[m]||{};
    return `<div class="card"><h3>${n}</h3><p>ELO: <b>${s.elo??100}</b></p><p>Матчи: ${s.matches||0}</p><p>Победы: ${s.wins||0}</p><p>Поражения: ${s.losses||0}</p><p>Стрик: ${s.streak||0}</p><p>K/D: ${s.kd||0}</p></div>`;
  }).join('');
}
function renderParty(){
  if(!party){
    $('partyStatus').textContent='Вы не состоите в пати';
    $('leaveParty').hidden=true;$('partyMembers').innerHTML='';
    $('partyFriends').innerHTML='';
    return;
  }
  $('partyStatus').innerHTML=`Пати <b>${esc(party.id)}</b> · ${party.members.length}/5`;
  $('leaveParty').hidden=false;
  $('partyMembers').innerHTML=party.members.map(u=>`
    <div class="member"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button></div>`).join('');
  $('partyMembers').querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
  renderPartyFriends();
}
function renderPartyFriends(){
  const friends=window._friends||[];
  if(!party){$('partyFriends').innerHTML='';return}
  const members=new Set((party.members||[]).map(x=>x.id));
  const candidates=friends.filter(u=>!members.has(u.id));
  $('partyFriends').innerHTML=candidates.length
    ? `<div class="muted party-invite-title">Пригласить друга в пати</div>`+
      candidates.map(u=>`<div class="friend"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button><button class="invite" data-id="${u.id}">Пригласить</button></div>`).join('')
    : '<p class="muted">Нет друзей, которых можно пригласить.</p>';
  $('partyFriends').querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
  $('partyFriends').querySelectorAll('.invite').forEach(b=>b.onclick=()=>sendInvite(b.dataset.id));
}
async function sendInvite(id){
  try{await post('/api/invite-party',{fromUserId:me.id,targetUserId:id});toast('Приглашение отправлено','success')}
  catch(e){toast(e.message,'error')}
}
async function createParty(){
  try{
    const d=await post('/api/create-party',{userId:me.id});
    party=d.party;renderParty();await loadFriends();toast('Пати создана','success');
  }catch(e){toast(e.message,'error')}
}
async function leaveParty(){
  if(!party)return;
  try{await post('/api/leave-party',{userId:me.id,partyId:party.id});party=null;renderParty()}
  catch(e){toast(e.message,'error')}
}
function renderModes(){
  const specs=[['1v1','1x1 Дуэль',2],['2v2','2x2 Напарники',4],['5v5','5x5 Соревновательный',10]];
  $('modes').innerHTML=specs.map(([m,n,need])=>`
    <div class="card mode">
      <h3>${n}</h3>
      <div class="row"><button class="join" data-mode="${m}" data-ranked="false">Обычный</button><button class="join" data-mode="${m}" data-ranked="true">Ранговый</button></div>
      <div class="queue"><span>Обычный <b id="q-${m}-u">0/${need}</b></span><span>Ранговый <b id="q-${m}-r">0/${need}</b></span></div>
      <button class="secondary leave" data-mode="${m}" data-ranked="false" hidden>Выйти из очереди</button>
      <button class="secondary leave" data-mode="${m}" data-ranked="true" hidden>Выйти из очереди</button>
    </div>`).join('');
  $('modes').querySelectorAll('.join').forEach(b=>b.onclick=()=>{
    const mode=b.dataset.mode,ranked=b.dataset.ranked==='true';
    if(ranked&&!rankedAllowedLocal(mode)){
      toast(`Нельзя играть в ранговый режим: сначала сыграйте 3 обычных матча в ${mode}.`,'error');return;
    }
    socket.emit('joinQueue',{mode,ranked,partyId:party?.id});
  });
  $('modes').querySelectorAll('.leave').forEach(b=>b.onclick=()=>{
    socket.emit('leaveQueue',{mode:b.dataset.mode,ranked:b.dataset.ranked==='true'});
  });
}
function rankedAllowedLocal(m){
  const n=m==='1v1'?me.stats.unrankedMatches1v1:m==='2v2'?me.stats.unrankedMatches2v2:me.stats.unrankedMatches5v5;
  return Number(n||0)>=3;
}
function updateQueue(q){
  for(const m of ['1v1','2v2','5v5']){
    const need=MODES(m);
    $('q-'+m+'-u').textContent=(q[m]?.unranked||0)+'/'+need;
    $('q-'+m+'-r').textContent=(q[m]?.ranked||0)+'/'+need;
  }
}
function updateQueueMine(mine){
  queueMine=mine||{};
  document.querySelectorAll('.leave').forEach(b=>{
    const k=b.dataset.mode+'_'+(b.dataset.ranked==='true'?'ranked':'unranked');
    b.hidden=!queueMine[k];
  });
}
function MODES(m){return m==='1v1'?2:m==='2v2'?4:10}
function showMatch(m){
  currentMatch=m;let left=m.timeout||20;
  const x=modal(`<div class="modal-box"><h2>🎯 Матч найден</h2><p>Все игроки должны подтвердить матч.</p><p>Участников: <b id="acc">${m.accepted}/${m.total}</b></p><div id="mtimer" class="timer">${left}</div><div class="row"><button id="accept">Принять</button><button id="decline" class="danger">Отказаться</button></div></div>`);
  const t=setInterval(()=>{left--;if($('mtimer'))$('mtimer').textContent=Math.max(0,left);if(left<=0)clearInterval(t)},1000);
  $('accept').onclick=()=>{socket.emit('acceptMatch',{matchId:m.matchId});closeModal();clearInterval(t)};
  $('decline').onclick=()=>{socket.emit('declineMatch',{matchId:m.matchId});closeModal();clearInterval(t)};
}
function showDraft(d){
  const x=modal(`<div class="modal-box"><h2>🗺 Драфт матча</h2><p>Все игроки голосуют отдельно за карту и количество раундов. Побеждает вариант с наибольшим числом голосов.</p><h3>Карта</h3><div id="mapVotes" class="vote-grid">${d.mapOptions.map(v=>`<button data-map="${esc(v)}">${esc(v)}</button>`).join('')}</div><h3>Раунды</h3><div id="roundVotes" class="vote-grid">${d.roundOptions.map(v=>`<button data-round="${v}">${v}</button>`).join('')}</div><div class="timer">Осталось: <b id="draftTimer">${d.seconds}</b> сек.</div></div>`);
  x.querySelectorAll('[data-map]').forEach(b=>b.onclick=()=>{
    socket.emit('draftVote',{matchId:d.matchId,map:b.dataset.map});
    x.querySelectorAll('[data-map]').forEach(z=>z.classList.remove('selected'));b.classList.add('selected');
  });
  x.querySelectorAll('[data-round]').forEach(b=>b.onclick=()=>{
    socket.emit('draftVote',{matchId:d.matchId,rounds:Number(b.dataset.round)});
    x.querySelectorAll('[data-round]').forEach(z=>z.classList.remove('selected'));b.classList.add('selected');
  });
  let n=d.seconds;const ti=setInterval(()=>{n--;if($('draftTimer'))$('draftTimer').textContent=Math.max(0,n);if(n<=0)clearInterval(ti)},1000);
}
function showLobby(m){
  currentMatch=m;
  const x=modal(`<div class="modal-box"><button class="close" id="closeLobby">✕</button><h2>Лобби · ${esc(m.matchId)}</h2><p>${esc(m.mode)} · ${m.ranked?'Ранговый':'Обычный'} · <b>${esc(m.map)}</b> · ${m.rounds} раундов · $${m.maxMoney}</p>
  <div class="teams"><div class="team"><h3>🟥 T (террористы)</h3>${m.teamT.map(u=>`<div class="member"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button></div>`).join('')}</div>
  <div class="team"><h3>🟦 CT (спецназ)</h3>${m.teamCT.map(u=>`<div class="member"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button></div>`).join('')}</div></div>
  <div class="card"><b>Если не можете войти в игру</b><button id="cancelReq" class="danger">Запросить отмену матча</button></div>
  <div class="result-upload"><input id="shot" type="file" accept="image/*"><button id="uploadShot">Загрузить скриншот</button></div><button id="closeLobby2" class="secondary">Закрыть</button></div>`);
  x.querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
  $('closeLobby').onclick=closeModal;$('closeLobby2').onclick=closeModal;
  $('cancelReq').onclick=async()=>{
    const reason=await promptSafe('Причина отмены','Укажите причину');
    if(reason){try{await post('/api/match/'+encodeURIComponent(m.matchId)+'/cancel-request',{userId:me.id,reason});toast('Заявка отправлена администратору','success')}catch(e){toast(e.message,'error')}}
  };
  $('uploadShot').onclick=async()=>{
    const f=$('shot').files[0];if(!f)return toast('Выберите скриншот','error');
    const fd=new FormData();fd.append('screenshot',f);fd.append('userId',me.id);
    try{const d=await fetch('/api/match/'+encodeURIComponent(m.matchId)+'/screenshot',{method:'POST',body:fd}).then(r=>r.json());if(d.success)toast('Скриншот загружен','success');else toast(d.message||'Ошибка','error')}catch(e){toast('Ошибка загрузки','error')}
  };
}
function promptSafe(title,msg){
  const x=modal(`<div class="modal-box"><h3>${esc(title)}</h3><p>${esc(msg)}</p><input id="safePrompt" placeholder="Причина"><div class="row"><button id="pOk">Отправить</button><button id="pNo" class="secondary">Отмена</button></div></div>`);
  return new Promise(r=>{$('pOk').onclick=()=>{const v=$('safePrompt').value.trim();closeModal();r(v)};$('pNo').onclick=()=>{closeModal();r(null)}});
}
async function showProfile(id){
  try{
    const d=await api('/api/user/'+encodeURIComponent(id)),u=d.user;
    const x=modal(`<div class="modal-box"><h2>${u.isAdmin?'👑 ':''}${esc(u.inGameNick)}</h2><img class="profile-big" src="${avatar(u)}" alt=""><p>Игровой ID: ${esc(u.inGameId)}</p>
      ${Object.entries({'1v1':'1x1','2v2':'2x2','5v5':'5x5'}).map(([m,n])=>`<div class="stat-row"><span>${n}</span><b>ELO ${u.stats[m].elo} · ${u.stats[m].wins}W/${u.stats[m].losses}L</b></div>`).join('')}
      <div class="row actions">${id!==me.id?`<button id="addF">Добавить в друзья</button><button id="reportP" class="danger">Репорт</button>`:''}<button class="secondary" id="closeP">Закрыть</button></div></div>`);
    $('closeP').onclick=closeModal;
    if(id!==me.id){
      $('addF').onclick=async()=>{try{await post('/api/friend-request',{fromUserId:me.id,toUserId:id});toast('Заявка отправлена','success')}catch(e){toast(e.message,'error')}};
      $('reportP').onclick=()=>reportUser(id);
    }
  }catch(e){toast(e.message,'error')}
}
async function reportUser(id){
  const x=modal(`<div class="modal-box"><h3>Репорт игрока</h3><p>Выберите причину:</p><button class="reportReason" data-r="Токсичность">Токсичность</button><button class="reportReason" data-r="Читы">Читы</button><button class="reportReason" data-r="Багаюз">Багаюз</button><button id="closeReport" class="secondary">Отмена</button></div>`);
  x.querySelectorAll('.reportReason').forEach(b=>b.onclick=async()=>{try{await post('/api/report',{reporterId:me.id,targetId:id,reason:b.dataset.r});closeModal();toast('Репорт отправлен','success')}catch(e){toast(e.message,'error')}});
  $('closeReport').onclick=closeModal;
}
async function loadFriends(){
  try{
    const d=await api('/api/friends?userId='+me.id);window._friends=d.friends||[];
    $('requests').innerHTML=d.requests.map(u=>`<div class="friend"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button><button data-a="${u.id}">Принять</button></div>`).join('')||'<p class="muted">Нет заявок</p>';
    $('friendsList').innerHTML=d.friends.map(u=>`<div class="friend"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button><button class="pm" data-id="${u.id}">💬</button></div>`).join('')||'<p class="muted">Нет друзей</p>';
    document.querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
    $('requests').querySelectorAll('[data-a]').forEach(b=>b.onclick=async()=>{await post('/api/friend-accept',{userId:me.id,friendId:b.dataset.a});loadFriends()});
    $('friendsList').querySelectorAll('.pm').forEach(b=>b.onclick=()=>openPM(b.dataset.id));
    renderPartyFriends();
  }catch(e){toast(e.message,'error')}
}
async function searchUsers(){
  try{
    const d=await api('/api/search-users?q='+encodeURIComponent($('userSearch').value));
    $('searchResults').innerHTML=d.users.map(u=>`<div class="friend"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)} · ${esc(u.inGameId)}</button></div>`).join('')||'<p class="muted">Ничего не найдено.</p>';
    $('searchResults').querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
  }catch(e){toast(e.message,'error')}
}
function renderHistory(){
  const all=me.stats.matchHistory||[];
  $('historyList').innerHTML=all.length?all.map(m=>`<div class="card"><b>${esc(m.matchId)}</b><p>${esc(m.mode)} · ${m.ranked?'Ранговый':'Обычный'} · ${esc(m.map||'—')} · ${m.rounds||'—'} раундов</p><p>${m.won?'🏆 Победа':'❌ Поражение'} · ${m.eloDelta>=0?'+':''}${m.eloDelta} ELO → ${m.eloAfter}</p></div>`).join(''):'<div class="card">Матчей пока нет.</div>';
}
async function loadHistory(){
  try{const d=await api('/api/me?userId='+me.id);me=normalizeAdmin(d.user);party=d.party;renderMe();renderHistory();renderParty()}catch(e){}
}
async function loadTop(mode){
  try{
    const d=await api('/api/top?mode='+mode);
    $('topList').innerHTML=d.users.map((u,i)=>`<div class="top-player"><b>#${i+1}</b><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button><span><b>${u.elo}</b> ELO · ${u.wins} W</span></div>`).join('')||'<p class="muted">Нет игроков.</p>';
    $('topList').querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
  }catch(e){toast(e.message,'error')}
}
async function loadPMData(){
  try{
    const d=await api('/api/private-messages?userId='+me.id);
    pmHistory=d.messages||[];renderDialogs();
    if(pmTarget)renderPM();
  }catch(e){pmHistory=[];renderDialogs()}
}
function renderDialogs(){
  const ids=new Set();
  pmHistory.forEach(m=>{if(m.from===me.id)ids.add(m.to);else if(m.to===me.id)ids.add(m.from)});
  const friends=window._friends||[];
  const usersById=Object.fromEntries(friends.map(u=>[u.id,u]));
  const rows=[...ids].map(id=>{
    const u=usersById[id];
    const arr=pmHistory.filter(m=>m.from===id||m.to===id);
    const last=arr[arr.length-1];
    return {id,u,last};
  }).sort((a,b)=>(b.last?.timestamp||0)-(a.last?.timestamp||0));
  $('dialogs').innerHTML=rows.length?rows.map(r=>`<button class="dialog-row" data-id="${r.id}"><img src="${avatar(r.u||{})}" alt=""><span><b>${esc(r.u?.inGameNick||'Игрок')}</b><small>${esc(r.last?.text||'')}</small></span></button>`).join(''):'<p class="muted">Выберите друга во вкладке «Друзья», чтобы начать переписку.</p>';
  $('dialogs').querySelectorAll('.dialog-row').forEach(b=>b.onclick=()=>openPM(b.dataset.id));
}
function openPM(id){
  pmTarget=id;$('pmBox').hidden=false;
  const u=(window._friends||[]).find(x=>x.id===id);
  $('pmTitle').textContent='Личные сообщения · '+(u?.inGameNick||'Игрок');
  renderPM();
}
function renderPM(){
  if(!pmTarget)return;
  $('pmMessages').innerHTML=pmHistory.filter(m=>(m.from===me.id&&m.to===pmTarget)||(m.to===me.id&&m.from===pmTarget)).map(m=>`<div class="msg ${m.from===me.id?'mine':''}">${esc(m.text)}</div>`).join('');
  $('pmMessages').scrollTop=$('pmMessages').scrollHeight;
}
function closeSideMenu(){
  const side=$('side');
  if(side){
    side.classList.remove('open');
    side.removeAttribute('open');
    side.style.removeProperty('transform');
  }
}
function nav(){
  document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    b.classList.add('active');
    const view=$(b.dataset.view);
    if(view)view.classList.add('active');
    // Закрываем боковое меню после любого выбора вкладки.
    closeSideMenu();
    if(b.dataset.view==='friends')loadFriends();
    if(b.dataset.view==='messages'){loadFriends().then(loadPMData)}
    if(b.dataset.view==='history')loadHistory();
    if(b.dataset.view==='top')loadTop('1v1');
  });
}
nav();
$('loginBtn').onclick=login;$('regBtn').onclick=register;
$('showReg').onclick=()=>{$('loginForm').hidden=true;$('regForm').hidden=false};
$('showLogin').onclick=()=>{$('loginForm').hidden=false;$('regForm').hidden=true};
$('logout').onclick=()=>{clearSession();location.reload()};
$('createParty').onclick=createParty;$('leaveParty').onclick=leaveParty;
$('searchBtn').onclick=searchUsers;
$('chatSend').onclick=()=>{const t=$('chatInput').value;if(t.trim()){socket.emit('chatMessage',{text:t});$('chatInput').value=''}};
$('pmSend').onclick=()=>{const t=$('pmInput').value;if(t.trim()&&pmTarget){socket.emit('privateMessage',{toUserId:pmTarget,text:t});$('pmInput').value=''}};
$('nickBtn').onclick=async()=>{try{const d=await post('/api/change-nick',{userId:me.id,newNick:$('nickInput').value});if(d.success){me=normalizeAdmin(d.user);renderMe();toast('Ник изменён','success')}}catch(e){toast(e.message,'error')}};
$('avatarBtn').onclick=()=>$('avatarInput').click();
$('avatarInput').onchange=async()=>{const f=$('avatarInput').files[0];if(!f)return;const fd=new FormData();fd.append('avatar',f);fd.append('userId',me.id);try{const d=await fetch('/api/upload-avatar',{method:'POST',body:fd}).then(r=>r.json());if(d.success){me.avatar=d.avatar;me.stats.avatar=d.avatar;renderMe();toast('Аватар изменён','success')}}catch(e){toast('Ошибка загрузки аватара','error')}};
$('authMenuBtn').onclick=()=>$('authMenu').classList.toggle('open');
$('menuBtn').onclick=()=>{
  const side=$('side');
  if(side)side.classList.toggle('open');
};
socket.on('queueUpdate',updateQueue);
socket.on('queueMembership',updateQueueMine);
socket.on('queueError',d=>toast(d.message||'Ошибка очереди','error'));
socket.on('matchFound',showMatch);
socket.on('matchAcceptedUpdate',d=>{if($('acc'))$('acc').textContent=d.accepted+'/'+d.total});
socket.on('matchCancelled',d=>{currentMatch=null;closeModal();toast(d.reason||'Матч отменён','error')});
socket.on('draftStart',showDraft);socket.on('draftUpdate',()=>{});
socket.on('matchLobby',showLobby);
socket.on('matchResolved',async d=>{
  try{const u=(await api('/api/me?userId='+me.id)).user;me=normalizeAdmin(u);renderMe();renderHistory();toast(`Матч завершён. ELO: ${d.eloChanges?.[me.id]>=0?'+':''}${d.eloChanges?.[me.id]||0}`,'success')}catch{}
});
socket.on('partyUpdate',p=>{party=p;renderParty()});
socket.on('partyInvite',inv=>{
  const x=modal(`<div class="modal-box"><h3>Приглашение в пати</h3><p>${esc(inv.fromName)} приглашает вас в пати.</p><div class="row"><button id="joinInv">Принять</button><button id="noInv" class="secondary">Отклонить</button></div></div>`);
  $('joinInv').onclick=()=>{socket.emit('partyInviteAccept',{partyId:inv.partyId});closeModal()};
  $('noInv').onclick=closeModal;
});
socket.on('friendRequest',()=>{toast('Новая заявка в друзья','info');loadFriends()});
socket.on('friendChanged',()=>loadFriends());
socket.on('chatHistory',h=>{$('globalChat').innerHTML='';(h||[]).forEach(addChat)});
socket.on('chatMessage',addChat);
socket.on('privateHistory',h=>{pmHistory=h||[];renderDialogs();renderPM()});
socket.on('privateMessage',m=>{pmHistory.push(m);renderDialogs();if(pmTarget)renderPM();if(pmTarget!==m.from&&pmTarget!==m.to)toast('Новое личное сообщение','info')});
function addChat(m){
  $('globalChat').insertAdjacentHTML('beforeend',`<div class="msg chat-msg"><img class="chat-avatar" src="${avatar(m)}" alt=""><button class="profile-link" data-id="${m.userId}">${m.isAdmin?'<b class="admin">ADMIN</b> ':''}${esc(m.nickname)}</button>: <span>${esc(m.text)}</span></div>`);
  $('globalChat').querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>loadTop(b.dataset.mode));
boot();