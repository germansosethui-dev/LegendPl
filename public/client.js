/* STRICT_LEAGUE_CLIENT_V5 */
const socket=io();
let me=null,party=null,currentMatch=null,pmTarget=null,pmHistory=[],queueMine={},lastCompletedMatch=null;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function avatar(u){return u?.avatar||avatarFallback()}
function toast(t,type='info'){
  const x=$('toast');if(!x)return;
  x.textContent=t;x.className=type;x.style.display='block';
  clearTimeout(toast.t);toast.t=setTimeout(()=>x.style.display='none',3500);
}
let matchAudioCtx=null;
function playMatchSound(){try{matchAudioCtx ||= new (window.AudioContext||window.webkitAudioContext)();const c=matchAudioCtx;c.resume?.();const now=c.currentTime;[0,0.18,0.36].forEach((off,i)=>{const o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.value=[880,1046,1320][i];g.gain.setValueAtTime(0.0001,now+off);g.gain.exponentialRampToValueAtTime(0.22,now+off+0.02);g.gain.exponentialRampToValueAtTime(0.0001,now+off+0.16);o.connect(g).connect(c.destination);o.start(now+off);o.stop(now+off+0.17)})}catch{}}
function avatarFallback(){return 'data:image/svg+xml;charset=UTF-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#243147"/><text x="48" y="58" text-anchor="middle" fill="#9fb5d5" font-size="34">?</text></svg>')}
document.addEventListener('pointerdown',()=>{try{matchAudioCtx ||= new (window.AudioContext||window.webkitAudioContext)();matchAudioCtx.resume?.()}catch{}},{once:false,passive:true});
async function api(url,opt={}){
  const r=await fetch(url,opt);let d={};
  try{d=await r.json()}catch{}
  if(!r.ok)throw Error(d.message||'Ошибка сервера');
  return d;
}
const post=(u,b)=>api(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
function cleanupModalRoot(){
  const root=$('modalRoot');
  if(!root)return;
  if(!root.firstElementChild){
    root.hidden=true;
    root.setAttribute('aria-hidden','true');
    root.style.display='none';
    root.style.pointerEvents='none';
    document.body.classList.remove('modal-open');
    document.body.style.overflow='';
  }
}
function closeModalRoot(){
  const root=$('modalRoot');
  if(!root)return;
  root.innerHTML='';
  cleanupModalRoot();
}
function modal(html){
  const root=$('modalRoot');
  if(!root)return null;
  root.hidden=false;
  root.removeAttribute('aria-hidden');
  root.style.display='';
  root.style.pointerEvents='auto';
  root.innerHTML=html;
  document.body.classList.add('modal-open');
  return root.firstElementChild;
}

// The app removes modal boxes with x.remove(). A MutationObserver makes sure
// the modal container itself is also hidden, so an empty invisible overlay
// can never remain on top of the page and block clicks/scrolling.
if($('modalRoot')){
  const mr=$('modalRoot');
  mr.hidden=true;
  mr.setAttribute('aria-hidden','true');
  mr.style.display='none';
  mr.style.pointerEvents='none';
  new MutationObserver(()=>queueMicrotask(cleanupModalRoot)).observe(mr,{childList:true});
  mr.addEventListener('click',e=>{
    if(e.target===mr)closeModalRoot();
  });
}

function saveSession(){localStorage.setItem('legendpl_user',me.id)}
function clearSession(){localStorage.removeItem('legendpl_user')}
async function login(){
  try{
    const d=await post('/api/login',{username:$('loginUsername').value,password:$('loginPassword').value});
    me=d.user;party=d.party;saveSession();enter();toast('Вход выполнен','success');
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
  if(me.isAdmin){$('adminNav').hidden=false;loadAdmin();}else $('adminNav').hidden=true;
}
async function boot(){
  const id=localStorage.getItem('legendpl_user');
  if(!id)return;
  try{
    const d=await api('/api/me?userId='+encodeURIComponent(id));
    me=d.user;party=d.party;enter();
  }catch(e){clearSession();$('auth').hidden=false;$('auth').style.display='flex';$('app').hidden=true;$('app').style.display='none';$('authMsg').textContent=e.message||'Сессия недействительна.'}
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

function detectClientPlatform(){
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent) ? 'phone' : 'pc';
}
function leaguePlatformAllowed(league){ return String(league||'pc')===detectClientPlatform(); }

function renderModes(){
  const host=$('modes');
  if(!host)return;

  const platform=detectClientPlatform();
  let selectedLeague=localStorage.getItem('legendpl_league')||platform;
  if(selectedLeague!==platform)selectedLeague=platform;

  const setLeague=(lg,save=true)=>{
    if(lg!==platform){
      toast(platform==='pc'?'Эта лига не для тебя. С ПК доступна только PC лига.':'Эта лига не для тебя. С телефона доступна только Phone лига.','error');
      return;
    }
    selectedLeague=lg;
    if(save)localStorage.setItem('legendpl_league',lg);
    renderLeague();
  };

  const renderLeague=()=>{
    const specs=[['1v1','1x1 Дуэль',2],['2v2','2x2 Напарники',4],['5v5','5x5 Соревновательный',10]];
    const isPC=selectedLeague==='pc';
    const title=isPC?'🖥️ PC лига':'📱 Phone лига';
    const desc=isPC?'Игры только для игроков на компьютере.':'Игры только для игроков на телефонах.';
    const badge=isPC?'PC':'PHONE';

    host.innerHTML=`
      <div class="league-switch card">
        <h3>Выберите лигу</h3>
        <div class="row">
          <button id="leaguePC" data-league="pc" class="${isPC?'active':''}" ${platform!=='pc'?'disabled':''}>🖥️ PC лига</button>
          <button id="leaguePhone" data-league="phone" class="${!isPC?'active':''}" ${platform!=='phone'?'disabled':''}>📱 Phone лига</button>
        </div>
        <p class="muted">Ваше устройство: <b>${platform==='pc'?'PC':'Phone'}</b>. Доступна только соответствующая лига.</p>
      </div>
      <section class="league-block card">
        <div class="league-title">
          <div><h2>${title}</h2><p class="muted">${desc}</p></div>
          <span class="league-badge league-${selectedLeague}">${badge}</span>
        </div>
        <div class="grid league-grid">
          ${specs.map(([m,n,need])=>`
            <div class="card mode">
              <h3>${n}</h3>
              <div class="row">
                <button class="join" data-league="${selectedLeague}" data-mode="${m}" data-ranked="false">Обычный</button>
                <button class="join" data-league="${selectedLeague}" data-mode="${m}" data-ranked="true">Ранговый</button>
              </div>
              <div class="queue">
                <span>Обычный <b id="q-${selectedLeague}-${m}-u">0/${need}</b></span>
                <span>Ранговый <b id="q-${selectedLeague}-${m}-r">0/${need}</b></span>
              </div>
              <button class="secondary leave" data-league="${selectedLeague}" data-mode="${m}" data-ranked="false" hidden>Выйти из очереди</button>
              <button class="secondary leave" data-league="${selectedLeague}" data-mode="${m}" data-ranked="true" hidden>Выйти из очереди</button>
            </div>`).join('')}
        </div>
      </section>`;

    $('leaguePC').onclick=()=>setLeague('pc');
    $('leaguePhone').onclick=()=>setLeague('phone');

    host.querySelectorAll('.join').forEach(b=>b.onclick=()=>{
      const league=b.dataset.league,mode=b.dataset.mode,ranked=b.dataset.ranked==='true';
      if(!leaguePlatformAllowed(league)){
        toast(platform==='pc'?'Эта лига не для тебя. С ПК можно играть только в PC лиге.':'Эта лига не для тебя. С телефона можно играть только в Phone лиге.','error');
        return;
      }
      if(ranked&&!rankedAllowedLocal(mode)){
        toast(`Нельзя играть в ранговый режим: сначала сыграйте 3 обычных матча в ${mode}.`,'error');
        return;
      }
      socket.emit('joinQueue',{league,mode,ranked,partyId:party?.id});
    });
    host.querySelectorAll('.leave').forEach(b=>b.onclick=()=>socket.emit('leaveQueue',{league:b.dataset.league,mode:b.dataset.mode,ranked:b.dataset.ranked==='true'}));
  };

  renderLeague();
}

function rankedAllowedLocal(m){
  const n=m==='1v1'?me.stats.unrankedMatches1v1:m==='2v2'?me.stats.unrankedMatches2v2:me.stats.unrankedMatches5v5;
  return Number(n||0)>=3;
}
function updateQueue(q){
  for(const league of ['pc','phone']) for(const m of ['1v1','2v2','5v5']){
    const need=MODES(m);const st=q?.[league]?.[m]||{};
    const u=$(`q-${league}-${m}-u`),r=$(`q-${league}-${m}-r`);
    if(u)u.textContent=(st.unranked||0)+'/'+need;
    if(r)r.textContent=(st.ranked||0)+'/'+need;
  }
}
function updateQueueMine(mine){
  queueMine=mine||{};
  document.querySelectorAll('.leave').forEach(b=>{const k=`${b.dataset.league}_${b.dataset.mode}_${b.dataset.ranked==='true'?'ranked':'unranked'}`;b.hidden=!queueMine[k]});
}
function MODES(m){return m==='1v1'?2:m==='2v2'?4:10}

function showMatch(m){
  currentMatch=m;playMatchSound();
  if(navigator.vibrate)navigator.vibrate([120,80,120,80,250]);
  let left=m.timeout||20;
  const x=modal(`<div class="modal-box match-found-box"><h2>🎯 Матч найден!</h2><p><b>${esc(m.leagueName||'Лига')}</b> · ${esc(m.mode)} · ${m.ranked?'Ранговый':'Обычный'}</p><p>Все игроки должны подтвердить матч.</p><p>Участников: <b id="acc">${m.accepted}/${m.total}</b></p><div id="mtimer" class="timer">${left}</div><div class="row"><button id="accept">Принять матч</button><button id="decline" class="danger">Отказаться</button></div></div>`);
  const t=setInterval(()=>{left--;if($('mtimer'))$('mtimer').textContent=Math.max(0,left);if(left<=0)clearInterval(t)},1000);
  $('accept').onclick=()=>{socket.emit('acceptMatch',{matchId:m.matchId});x?.remove();clearInterval(t);cleanupModalRoot()};
  $('decline').onclick=()=>{socket.emit('declineMatch',{matchId:m.matchId});x?.remove();clearInterval(t);cleanupModalRoot()};
}
function renderDraftMapButtons(root,state){
  const wrap=$('draftMaps');if(!wrap)return;
  wrap.innerHTML=state.remainingMaps.map(v=>`<button class="draft-map ${state.currentCaptain===me.id?'can-ban':''}" data-map="${esc(v)}">${esc(v)}</button>`).join('')||'<p class="muted">Карты закончились.</p>';
  wrap.querySelectorAll('[data-map]').forEach(b=>b.onclick=()=>{if(state.currentCaptain!==me.id)return toast('Сейчас ход другого капитана','error');socket.emit('draftBan',{matchId:state.matchId,map:b.dataset.map})});
}
function renderDraftState(state){
  const timer=$('draftTimer');if(timer)timer.textContent=Math.max(0,state.seconds);
  const turn=$('draftTurn');if(turn){const u=(state.captains||[]).find(x=>x?.id===state.currentCaptain);turn.innerHTML=state.currentCaptain===me.id?'<b>Ваш ход — бан карты</b>':`Ход капитана: <b>${esc(u?.inGameNick||'Игрок')}</b>`}
  const bans=$('draftBans');if(bans)bans.innerHTML=(state.mapBans||[]).length?state.mapBans.map((b,i)=>`<div class="draft-ban-row"><span>#${i+1} ${esc(b.map)}</span><small>${b.auto?'Автобан':'Капитан '+esc((state.captains||[]).find(x=>x?.id===b.userId)?.inGameNick||'')}</small></div>`).join(''):'<p class="muted">Банов пока нет.</p>';
  const counts=state.roundCounts||{};const voted=Object.keys(state.roundVotes||{}).length;const vc=$('roundVotedCount');if(vc)vc.textContent=voted;const rv=$('draftRounds');if(rv)rv.innerHTML=(state.roundOptions||[]).map(r=>`<button class="round-option ${Number(state.roundVotes?.[me.id])===Number(r)?'selected':''}" data-round="${r}">${r} раундов <span>${counts[r]||0}</span></button>`).join('');
  rv?.querySelectorAll('[data-round]').forEach(b=>b.onclick=()=>socket.emit('draftRoundVote',{matchId:state.matchId,rounds:Number(b.dataset.round)}));
  renderDraftMapButtons(null,state);
}
function renderDraftChat(){const box=$('draftChat');if(!box)return;box.innerHTML=(window._draftChat||[]).map(m=>`<div class="draft-chat-msg"><img src="${avatar(m)}"><div><b>${esc(m.nickname)}</b><span>${esc(m.text)}</span></div></div>`).join('');box.scrollTop=box.scrollHeight}
function showDraft(d){
  window._draftChat=d.chat||[];
  const x=modal(`<div class="modal-box draft-modal"><button class="close" id="closeDraft">✕</button><div class="draft-head"><div><h2>🗺 Драфт · ${esc(d.matchId)}</h2><p class="muted">${esc(d.leagueName||'Лига')} · ${esc(d.mode||'')}</p><p id="draftTurn"></p></div><div class="draft-total"><span>Осталось</span><b id="draftTimer">${d.seconds}</b><small>сек.</small></div></div>
  <div class="draft-layout"><div class="draft-main"><h3>Баны карт</h3><div id="draftMaps" class="draft-map-grid"></div><div id="draftBans" class="draft-bans"></div><h3>Количество раундов</h3><p class="muted">Проголосовало: <b id="roundVotedCount">0</b>/${d.totalParticipants||d.participants?.length||'всех игроков'}</p><div id="draftRounds" class="draft-round-grid"></div></div><div class="draft-chat-panel"><h3>💬 Чат игроков</h3><div id="draftChat" class="draft-chat"></div><div class="draft-chat-send"><input id="draftChatInput" placeholder="Сообщение"><button id="draftChatSend">➤</button></div></div></div></div>`);
  $('closeDraft').onclick=()=>{x?.remove();cleanupModalRoot()};
  renderDraftState(d);renderDraftChat();
  let last=d.seconds,ti=setInterval(()=>{last--;const el=$('draftTimer');if(el)el.textContent=Math.max(0,last);if(last<=0||!$('draftTimer'))clearInterval(ti)},1000);
  $('draftChatSend').onclick=()=>{const t=$('draftChatInput').value.trim();if(t){socket.emit('draftChat',{matchId:d.matchId,text:t});$('draftChatInput').value=''}};
  $('draftChatInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('draftChatSend').click()});
}
function showLobby(m){
  currentMatch={...m,status:'awaiting_result'};const host=m.hostCaptain||m.captains?.[0]||null;
  const hostName=host?.inGameNick||'Капитан';const hostGameId=host?.inGameId||'—';
  const x=modal(`<div class="modal-box"><button class="close" id="closeLobby">✕</button><h2>Лобби · ${esc(m.matchId)}</h2><p><b>${esc(m.leagueName||'Лига')}</b> · ${esc(m.mode)} · ${m.ranked?'Ранговый':'Обычный'} · <b>${esc(m.map)}</b> · ${m.rounds} раундов · $${m.maxMoney}</p>
  <div class="card lobby-host"><h3>🎮 Создатель игрового лобби</h3><p><b>${esc(hostName)}</b></p><p>Игровой ID: <b id="hostGameId">${esc(hostGameId)}</b></p><div class="row"><button id="copyHostId">Скопировать ID</button>${host?`<button id="pmHost" class="secondary">Написать капитану</button>`:''}</div><p class="muted">Капитан создаёт лобби в игре. Остальные игроки отправляют ему точку «.» в личные сообщения.</p></div>
  <div class="teams"><div class="team"><h3>🟥 T (террористы)</h3>${m.teamT.map(u=>`<div class="member"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button></div>`).join('')}</div>
  <div class="team"><h3>🟦 CT (спецназ)</h3>${m.teamCT.map(u=>`<div class="member"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button></div>`).join('')}</div></div>
  <div class="card"><b>Если не можете войти в игру</b><button id="cancelReq" class="danger">Запросить отмену матча</button></div>
  <div class="result-upload"><input id="shot" type="file" accept="image/*"><button id="uploadShot">Загрузить скриншот</button></div><button id="closeLobby2" class="secondary">Закрыть</button></div>`);
  x.querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
  $('closeLobby').onclick=()=>{x.remove();cleanupModalRoot()};$('closeLobby2').onclick=()=>{x.remove();cleanupModalRoot()};
  $('copyHostId').onclick=async()=>{try{await navigator.clipboard.writeText(hostGameId);toast('Игровой ID скопирован','success')}catch{toast(hostGameId,'info')}};
  if(host)$('pmHost').onclick=()=>openFriendChat(host.id);
  $('cancelReq').onclick=async()=>{const reason=await promptSafe('Причина отмены','Укажите причину');if(reason){try{await post('/api/match/'+encodeURIComponent(m.matchId)+'/cancel-request',{userId:me.id,reason});toast('Заявка отправлена администратору','success')}catch(e){toast(e.message,'error')}}};
  $('uploadShot').onclick=async()=>{const f=$('shot').files[0];if(!f)return toast('Выберите скриншот','error');const fd=new FormData();fd.append('screenshot',f);fd.append('userId',me.id);try{const d=await fetch('/api/match/'+encodeURIComponent(m.matchId)+'/screenshot',{method:'POST',body:fd}).then(r=>r.json());if(d.success)toast('Скриншот загружен','success');else toast(d.message||'Ошибка','error')}catch(e){toast('Ошибка загрузки','error')}};
}
function promptSafe(title,msg){
  const x=modal(`<div class="modal-box"><h3>${esc(title)}</h3><p>${esc(msg)}</p><input id="safePrompt" placeholder="Причина"><div class="row"><button id="pOk">Отправить</button><button id="pNo" class="secondary">Отмена</button></div></div>`);
  return new Promise(r=>{$('pOk').onclick=()=>{const v=$('safePrompt').value.trim();x.remove();r(v)};$('pNo').onclick=()=>{x.remove();r(null)}});
}
async function showProfile(id){
  try{
    const d=await api('/api/user/'+encodeURIComponent(id)),u=d.user;
    const reportCtx=getReportContext(id);
    const reportButton=id!==me.id?(reportCtx?.pending?'<button class="danger" disabled>Репорт доступен после матча</button>':reportCtx?.completed?'<button id="reportP" class="danger">Репорт за матч</button>':'<button id="reportP" class="danger">Репорт</button>'):'';
    const x=modal(`<div class="modal-box"><h2>${u.isAdmin?'👑 ':''}${esc(u.inGameNick)}</h2><img class="profile-big" src="${avatar(u)}" alt=""><p>Игровой ID: ${esc(u.inGameId)}</p>
      ${Object.entries({'1v1':'1x1','2v2':'2x2','5v5':'5x5'}).map(([m,n])=>`<div class="stat-row"><span>${n}</span><b>ELO ${u.stats[m].elo} · ${u.stats[m].wins}W/${u.stats[m].losses}L</b></div>`).join('')}
      <div class="row actions">${id!==me.id?`<button id="addF">Добавить в друзья</button>${reportButton}`:''}<button class="secondary" id="closeP">Закрыть</button></div></div>`);
    $('closeP').onclick=()=>x.remove();
    if(id!==me.id){
      $('addF').onclick=async()=>{try{await post('/api/friend-request',{fromUserId:me.id,toUserId:id});toast('Заявка отправлена','success')}catch(e){toast(e.message,'error')}};
      if($('reportP'))$('reportP').onclick=()=>reportUser(id,reportCtx?.matchId||null);
    }
  }catch(e){toast(e.message,'error')}
}
function getReportContext(targetId){
  const active=currentMatch?.participants?.find?.(u=>u?.id===targetId);
  if(currentMatch?.league==='phone'&&active?.platform==='pc'&&currentMatch?.status!=='resolved')return {pending:true,matchId:currentMatch.matchId};
  if(lastCompletedMatch?.league==='phone'&&lastCompletedMatch?.participants?.some(u=>u?.id===targetId&&u?.platform==='pc'))return {completed:true,matchId:lastCompletedMatch.matchId};
  return null;
}
async function reportUser(id,matchId=null){
  const x=modal(`<div class="modal-box"><h3>Репорт игрока</h3><p>Выберите причину:</p><button class="reportReason" data-r="Токсичность">Токсичность</button><button class="reportReason" data-r="Читы">Читы</button><button class="reportReason" data-r="Багаюз">Багаюз</button><button class="reportReason" data-r="Игра не в своей лиге">Игра не в своей лиге</button><button id="closeReport" class="secondary">Отмена</button></div>`);
  x.querySelectorAll('.reportReason').forEach(b=>b.onclick=async()=>{try{await post('/api/report',{reporterId:me.id,targetId:id,reason:b.dataset.r,matchId});x.remove();toast('Репорт отправлен','success')}catch(e){toast(e.message,'error')}});
  $('closeReport').onclick=()=>x.remove();
}
async function loadFriends(){
  try{
    const d=await api('/api/friends?userId='+me.id);window._friends=d.friends||[];
    $('requests').innerHTML=d.requests.map(u=>`<div class="friend"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button><button data-a="${u.id}">Принять</button></div>`).join('')||'<p class="muted">Нет заявок</p>';
    $('friendsList').innerHTML=d.friends.map(u=>`<div class="friend"><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button><button class="pm" data-id="${u.id}">💬</button></div>`).join('')||'<p class="muted">Нет друзей</p>';
    document.querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
    $('requests').querySelectorAll('[data-a]').forEach(b=>b.onclick=async()=>{await post('/api/friend-accept',{userId:me.id,friendId:b.dataset.a});loadFriends()});
    $('friendsList').querySelectorAll('.pm').forEach(b=>b.onclick=()=>openFriendChat(b.dataset.id));
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
  try{const d=await api('/api/me?userId='+me.id);me=d.user;party=d.party;renderMe();renderHistory();renderParty()}catch(e){}
}
async function loadTop(mode){
  try{
    const d=await api('/api/top?mode='+mode);
    $('topList').innerHTML=d.users.map((u,i)=>`<div class="top-player"><b>#${i+1}</b><img src="${avatar(u)}" alt=""><button class="profile-link" data-id="${u.id}">${esc(u.inGameNick)}</button><span><b>${u.elo}</b> ELO · ${u.wins} W</span></div>`).join('')||'<p class="muted">Нет игроков.</p>';
    $('topList').querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
  }catch(e){toast(e.message,'error')}
}
let adminLoaded=false;
async function adminApi(path,opt={}){return api(path+(path.includes('?')?'&':'?')+'adminId='+encodeURIComponent(me.id),opt)}
function adminEsc(s){return esc(s)}
function adminTabs(){document.querySelectorAll('[data-admin-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('.admin-section').forEach(x=>x.hidden=true);const m={matches:'adminMatches',cancels:'adminCancels',reports:'adminReports',users:'adminUsers'};$(m[b.dataset.adminTab]).hidden=false})}
async function loadAdmin(){if(!me?.isAdmin)return;const status=$('adminStatus');if(!status)return;try{status.textContent='Админ-доступ подтверждён';status.className='card success';adminTabs();await Promise.all([adminStats(),adminMatches(),adminCancels(),adminReports(),adminUsers()]);adminLoaded=true}catch(e){status.textContent='Ошибка загрузки админ-панели: '+e.message;status.className='card danger'}}
async function adminStats(){const d=await adminApi('/api/admin/stats');$('adminStats').innerHTML=[['Онлайн',d.online],['Игроки',d.users],['Матчи',d.matches],['Репорты',d.reports],['Отмены',d.cancelRequests]].map(x=>`<div class="card"><span>${x[0]}</span><h2>${x[1]}</h2></div>`).join('')}
async function adminMatches(){
  const d=await adminApi('/api/admin/matches');
  const html=d.matches.map(m=>{
    const teamT=m.teamT.map(u=>`<div class="member"><img src="${avatar(u)}"><span>${adminEsc(u.inGameNick)}</span></div>`).join('');
    const teamCT=m.teamCT.map(u=>`<div class="member"><img src="${avatar(u)}"><span>${adminEsc(u.inGameNick)}</span></div>`).join('');
    const shots=(m.screenshots||[]).map(s=>`<a href="${s.url}" target="_blank"><img src="${s.url}"></a>`).join('');
    const canEdit=m.status==='resolved'&&m.resolvedAt&&(Date.now()-Number(m.resolvedAt)<=3*60*60*1000);
    let controls='';
    if(m.status!=='resolved') controls=`<div class="row"><button onclick="adminResolveMatch('${m.id}','T')">Победа T</button><button onclick="adminResolveMatch('${m.id}','CT')">Победа CT</button><button class="danger" onclick="adminCancelMatch('${m.id}')">Отменить матч</button></div><div class="admin-elo">${m.participants.map(u=>`<label>${adminEsc(u.inGameNick)}<input type="number" step="1" id="aelo-${m.id}-${u.id}" value="0"></label>`).join('')}</div>`;
    else if(canEdit) controls=`<div class="card success"><b>Результат подтверждён ${new Date(m.resolvedAt).toLocaleString('ru-RU')}</b><p>Изменение доступно ещё ${Math.max(0,Math.ceil((3*60*60*1000-(Date.now()-Number(m.resolvedAt)))/60000))} мин.</p></div><div class="row"><button onclick="adminResolveMatch('${m.id}','T')">Изменить: победа T</button><button onclick="adminResolveMatch('${m.id}','CT')">Изменить: победа CT</button><button class="danger" onclick="adminCancelMatch('${m.id}')">Отменить матч</button></div><div class="admin-elo">${m.participants.map(u=>`<label>${adminEsc(u.inGameNick)}<input type="number" step="1" id="aelo-${m.id}-${u.id}" value="${Number(m.eloChanges?.[u.id]||0)}"></label>`).join('')}</div>`;
    return `<article class="card admin-match"><h3>${adminEsc(m.id)}</h3><p>${adminEsc(m.mode)} · ${m.ranked?'Ранговый':'Обычный'} · <b>${adminEsc(m.map||'Драфт')}</b> · ${m.rounds||'—'} раундов</p><p>Статус: ${adminEsc(m.status)}</p><div class="teams"><div class="team"><b>T</b>${teamT}</div><div class="team"><b>CT</b>${teamCT}</div></div><div class="admin-shots">${shots}</div>${controls}</article>`;
  }).join('');
  $('adminMatches').innerHTML='<h2>Матчи</h2>'+(html||'<p>Нет активных матчей.</p>');
}
async function adminAsk(title,text){return new Promise(resolve=>{const x=modal(`<div class="modal-box"><h3>${adminEsc(title)}</h3><p>${adminEsc(text)}</p><input id="adminAskInput" placeholder="Введите текст"><div class="row"><button id="adminAskOk">Подтвердить</button><button id="adminAskNo" class="secondary">Отмена</button></div></div>`);$('adminAskOk').onclick=()=>{const v=$('adminAskInput').value.trim();x.remove();cleanupModalRoot();resolve(v)};$('adminAskNo').onclick=()=>{x.remove();cleanupModalRoot();resolve(null)}})}
async function adminResolveMatch(mid,w){const changes={};document.querySelectorAll(`[id^="aelo-${mid}-"]`).forEach(i=>changes[i.id.split('-').pop()]=Number(i.value||0));try{await post('/api/admin/match/'+encodeURIComponent(mid)+'/resolve',{adminId:me.id,winnerTeam:w,eloChanges:changes});toast('Результат сохранён','success');await loadAdmin()}catch(e){toast(e.message,'error')}}
async function adminCancelMatch(mid){const r=await adminAsk('Отмена матча','Укажите причину отмены');if(r===null)return;try{await post('/api/admin/match/'+encodeURIComponent(mid)+'/cancel',{adminId:me.id,reason:r||'Отменено администратором'});toast('Матч отменён','success');await loadAdmin()}catch(e){toast(e.message,'error')}}
async function adminRestriction(uid,action){
  if(action==='unban'||action==='unmute'){try{await post('/api/admin/action',{adminId:me.id,targetUserId:uid,action});toast(action==='unban'?'Игрок разбанен':'Игрок размучен','success');await loadAdmin()}catch(e){toast(e.message,'error')}return}
  const x=modal(`<div class="modal-box"><h3>${action==='ban'?'🔴 Бан игрока':'🔇 Мут игрока'}</h3><p>Выберите срок.</p><div class="row"><input id="restrictionAmount" type="number" min="1" value="1" placeholder="Срок"><select id="restrictionUnit"><option value="1">Минуты</option><option value="60">Часы</option></select></div><input id="restrictionReason" placeholder="Причина"><div class="row"><button id="restrictionOk">Выдать</button><button id="restrictionNo" class="secondary">Отмена</button></div></div>`);
  $('restrictionOk').onclick=async()=>{const amount=Math.max(1,Number($('restrictionAmount').value||1));const unit=Number($('restrictionUnit').value||1);const minutes=Math.round(amount*unit);const reason=$('restrictionReason').value.trim();x.remove();cleanupModalRoot();try{await post('/api/admin/action',{adminId:me.id,targetUserId:uid,action,minutes,reason});toast(action==='ban'?'Бан выдан':'Мут выдан','success');await loadAdmin()}catch(e){toast(e.message,'error')}};
  $('restrictionNo').onclick=()=>{x.remove();cleanupModalRoot()};
}
async function adminCancels(){const d=await adminApi('/api/admin/cancel-requests');$('adminCancels').innerHTML='<h2>Заявки на отмену</h2>'+(d.requests.length?d.requests.map(r=>`<div class="card"><b>${adminEsc(r.id)}</b><p>Матч: ${adminEsc(r.matchId)}</p><p>Игрок: ${adminEsc(r.user?.inGameNick||'—')}</p><p>${adminEsc(r.reason)}</p>${r.status==='open'?`<div class="row"><button onclick="adminAnswerCancel('${r.id}','approved')">Одобрить</button><button class="danger" onclick="adminAnswerCancel('${r.id}','rejected')">Отклонить</button></div>`:`<p class="muted">${adminEsc(r.status)}</p>`}</div>`).join(''):'<p>Нет заявок.</p>')}
async function adminAnswerCancel(id,status){await post('/api/admin/cancel-request/'+id,{adminId:me.id,status});await loadAdmin()}
async function adminReports(){const d=await adminApi('/api/admin/reports');$('adminReports').innerHTML='<h2>Репорты</h2>'+(d.reports.length?d.reports.map(r=>`<div class="card"><b>${adminEsc(r.id)}</b><p>${adminEsc(r.reporter?.inGameNick||'—')} → ${adminEsc(r.target?.inGameNick||'—')}</p><p>Причина: ${adminEsc(r.reason)}</p><p>Статус: ${adminEsc(r.status)}</p>${r.status==='open'?`<button onclick="adminCloseReport('${r.id}')">Закрыть</button>`:''}</div>`).join(''):'<p>Нет репортов.</p>')}
async function adminCloseReport(id){await post('/api/admin/report/'+id,{adminId:me.id,status:'closed'});await loadAdmin()}
async function adminUsers(){const d=await adminApi('/api/admin/users');$('adminUsers').innerHTML='<h2>Игроки</h2>'+(d.users.length?d.users.map(u=>{const ban=!!u.ban,mute=!!u.mute;return `<div class="member admin-user"><img src="${avatar(u)}"><div class="admin-user-info"><b>${u.isAdmin?'<span class="admin">ADMIN</span> ':''}${adminEsc(u.inGameNick)}</b><div class="muted">${adminEsc(u.username)} · ID ${u.id} · ELO 1v1 ${u.stats['1v1'].elo}</div>${ban?`<div class="restriction-badge ban-badge">БАН до ${new Date(u.ban.until).toLocaleString('ru-RU')} · ${adminEsc(u.ban.reason||'без причины')}</div>`:''}${mute?`<div class="restriction-badge mute-badge">МУТ до ${new Date(u.mute.until).toLocaleString('ru-RU')} · ${adminEsc(u.mute.reason||'без причины')}</div>`:''}</div>${!u.isAdmin?`${ban?`<button class="success" onclick="adminRestriction('${u.id}','unban')">Разбан</button>`:`<button class="danger" onclick="adminRestriction('${u.id}','ban')">Бан</button>`}${mute?`<button class="success" onclick="adminRestriction('${u.id}','unmute')">Размут</button>`:`<button onclick="adminRestriction('${u.id}','mute')">Мут</button>`}`:''}</div>`}).join(''):'<p>Нет игроков.</p>')}

function showPostMatchReports(d){
  lastCompletedMatch=d;currentMatch=null;
  const targets=(d.participants||[]).filter(u=>u?.id!==me.id&&u?.platform==='pc');
  if(d.league!=='phone'||!targets.length)return;
  const x=modal(`<div class="modal-box post-match-report"><button class="close" id="closePostReports">✕</button><h2>🏁 Матч завершён</h2><p>Это была <b>Phone лига</b>. Репорт на игрока с ПК доступен только сейчас, после завершения катки.</p><div id="postReportPlayers"></div><button class="secondary" id="postReportClose2">Закрыть</button></div>`);
  const box=$('postReportPlayers');
  box.innerHTML=targets.map(u=>`<div class="card post-report-player"><div class="member"><img src="${avatar(u)}"><b>${esc(u.inGameNick)}</b><span class="platform-tag pc-tag">PC</span></div><button class="danger post-report-btn" data-id="${u.id}">Репорт</button></div>`).join('');
  box.querySelectorAll('.post-report-btn').forEach(b=>b.onclick=()=>reportUser(b.dataset.id,d.matchId));
  $('closePostReports').onclick=()=>{x.remove();cleanupModalRoot()};$('postReportClose2').onclick=()=>{x.remove();cleanupModalRoot()};
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
  const u=(window._friends||[]).find(x=>x.id===id)||{};
  $('pmTitle').innerHTML=`<span class="pm-head"><img src="${avatar(u)}" alt=""><b>${esc(u.inGameNick||'Игрок')}</b></span>`;
  renderPM();
}
async function openFriendChat(id){
  const navBtn=document.querySelector('.nav[data-view="messages"]');
  if(navBtn)navBtn.click();
  try{await loadFriends();await loadPMData()}catch{}
  openPM(id);
}
function renderPM(){
  if(!pmTarget)return;
  const u=(window._friends||[]).find(x=>x.id===pmTarget)||{};
  $('pmMessages').innerHTML=pmHistory.filter(m=>(m.from===me.id&&m.to===pmTarget)||(m.to===me.id&&m.from===pmTarget)).map(m=>{const mine=m.from===me.id;const who=mine?me:u;return `<div class="pm-msg ${mine?'mine':''}"><img src="${avatar(who)}" alt=""><div><b>${esc(who.inGameNick||'Игрок')}</b><span>${esc(m.text)}</span></div></div>`}).join('');
  $('pmMessages').scrollTop=$('pmMessages').scrollHeight;
}

/* HARDENED MOBILE SIDE-MENU CLOSE */
function closeSideMenu(){
  const side=$('side');
  if(!side)return;

  // Remove every common "open" state.
  side.classList.remove('open','active','show','visible');
  side.removeAttribute('open');
  side.setAttribute('aria-hidden','true');

  // Close common overlay classes too.
  ['menuOverlay','sideOverlay','overlay','drawerOverlay'].forEach(id=>{
    const el=$(id);
    if(el){
      el.classList.remove('open','active','show','visible');
      el.setAttribute('aria-hidden','true');
    }
  });

  // Force the mobile drawer closed. CSS can still override on desktop;
  // on small screens these inline properties guarantee it disappears.
  if(window.innerWidth<=900){
    side.style.transform='translateX(-110%)';
    side.style.left='0';
    side.style.visibility='hidden';
    side.style.pointerEvents='none';
  }

  document.body.classList.remove('menu-open','side-open','drawer-open','no-scroll');
  document.body.style.overflow='';
}

/* Re-open helper for the hamburger button. */
function openSideMenu(){
  const side=$('side');
  if(!side)return;
  side.classList.add('open');
  side.removeAttribute('aria-hidden');
  if(window.innerWidth<=900){
    side.style.transform='translateX(0)';
    side.style.left='0';
    side.style.visibility='visible';
    side.style.pointerEvents='auto';
  }
  document.body.classList.add('menu-open');
}

/* Keep the menu state correct after resize/orientation changes. */
window.addEventListener('resize',()=>{
  const side=$('side');
  if(!side)return;
  if(window.innerWidth>900){
    side.style.transform='';
    side.style.left='';
    side.style.visibility='';
    side.style.pointerEvents='';
    side.removeAttribute('aria-hidden');
  }
});

function nav(){
  document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>{
    // Close FIRST, before changing the active view.
    closeSideMenu();

    document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    b.classList.add('active');
    const view=$(b.dataset.view);
    if(view)view.classList.add('active');

    // Close again after the view is rendered/activated.
    requestAnimationFrame(closeSideMenu);

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
$('nickBtn').onclick=async()=>{try{const d=await post('/api/change-nick',{userId:me.id,newNick:$('nickInput').value});if(d.success){me=d.user;renderMe();toast('Ник изменён','success')}}catch(e){toast(e.message,'error')}};
$('avatarBtn').onclick=()=>$('avatarInput').click();
$('avatarInput').onchange=async()=>{const f=$('avatarInput').files[0];if(!f)return;const fd=new FormData();fd.append('avatar',f);fd.append('userId',me.id);try{const d=await fetch('/api/upload-avatar',{method:'POST',body:fd}).then(r=>r.json());if(d.success){me.avatar=d.avatar;me.stats.avatar=d.avatar;renderMe();toast('Аватар изменён','success')}}catch(e){toast('Ошибка загрузки аватара','error')}};
$('authMenuBtn').onclick=()=>$('authMenu').classList.toggle('open');

/* Hamburger: use the same forceful open/close helpers. */
$('menuBtn').onclick=()=>{
  const side=$('side');
  if(!side)return;
  if(side.classList.contains('open') || side.style.visibility==='visible'){
    closeSideMenu();
  }else{
    openSideMenu();
  }
};

socket.on('accountBanned',d=>{clearSession();closeModalRoot();$('app').hidden=true;$('app').style.display='none';$('auth').hidden=false;$('auth').style.display='flex';$('authMsg').textContent=d.message||'Вы забанены.'});
socket.on('chatBlocked',d=>toast(d.message||'Вы не можете писать в чат.','error'));
socket.on('queueUpdate',updateQueue);
socket.on('queueMembership',updateQueueMine);
socket.on('queueError',d=>toast(d.message||'Ошибка очереди','error'));
socket.on('matchFound',showMatch);
socket.on('matchAcceptedUpdate',d=>{if($('acc'))$('acc').textContent=d.accepted+'/'+d.total});
socket.on('matchCancelled',d=>{currentMatch=null;closeModalRoot();toast(d.reason||'Матч отменён','error')});
socket.on('draftStart',showDraft);socket.on('draftUpdate',d=>renderDraftState(d));socket.on('draftChat',m=>{window._draftChat ||= [];window._draftChat.push(m);renderDraftChat()});socket.on('draftFinished',d=>{toast(`Драфт завершён: ${d.map} · ${d.rounds} раундов`,'success')});
socket.on('matchLobby',showLobby);
socket.on('matchResolved',async d=>{
  lastCompletedMatch=d;currentMatch=null;
  showPostMatchReports(d);
  try{const u=(await api('/api/me?userId='+me.id)).user;me=u;renderMe();renderHistory();toast(`Матч завершён. ELO: ${d.eloChanges?.[me.id]>=0?'+':''}${d.eloChanges?.[me.id]||0}`,'success')}catch{}
});
socket.on('partyUpdate',p=>{party=p;renderParty()});
socket.on('partyInvite',inv=>{
  const x=modal(`<div class="modal-box"><h3>Приглашение в пати</h3><p>${esc(inv.fromName)} приглашает вас в пати.</p><div class="row"><button id="joinInv">Принять</button><button id="noInv" class="secondary">Отклонить</button></div></div>`);
  $('joinInv').onclick=()=>{socket.emit('partyInviteAccept',{partyId:inv.partyId});x.remove()};
  $('noInv').onclick=()=>x.remove();
});
socket.on('friendRequest',()=>{toast('Новая заявка в друзья','info');loadFriends()});
socket.on('friendChanged',()=>loadFriends());
socket.on('userUpdated',u=>{if(me&&u?.id===me.id){me=u;renderMe();}});
socket.on('chatHistory',h=>{$('globalChat').innerHTML='';(h||[]).forEach(addChat)});
socket.on('chatMessage',addChat);
socket.on('privateHistory',h=>{pmHistory=h||[];renderDialogs();renderPM()});
socket.on('privateMessage',m=>{pmHistory.push(m);renderDialogs();if(pmTarget)renderPM();if(pmTarget!==m.from&&pmTarget!==m.to)toast('Новое личное сообщение','info')});
function addChat(m){
  $('globalChat').insertAdjacentHTML('beforeend',`<div class="msg chat-msg"><img class="chat-avatar" src="${avatar(m)}" alt=""><button class="profile-link" data-id="${m.userId}">${m.isAdmin?'<b class="admin">ADMIN</b> ':''}${esc(m.nickname)}</button>: <span>${esc(m.text)}</span></div>`);
  $('globalChat').querySelectorAll('.profile-link').forEach(b=>b.onclick=()=>showProfile(b.dataset.id));
}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>loadTop(b.dataset.mode));

// Universal close behavior: ESC closes dialogs/menus; clicking outside the
// auth menu closes it; navigation always closes the drawer.
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    closeModalRoot();
    closeSideMenu();
    const am=$('authMenu');
    if(am)am.classList.remove('open');
  }
});
document.addEventListener('click',e=>{
  const am=$('authMenu');
  const btn=$('authMenuBtn');
  if(am && am.classList.contains('open') && !am.contains(e.target) && e.target!==btn){
    am.classList.remove('open');
  }
});
window.addEventListener('pagehide',()=>{closeModalRoot();closeSideMenu()});

boot();
