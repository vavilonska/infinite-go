import * as E from './engine.js';
import {boardAnnotations,branchDescription} from './annotations.js';
import {createTree} from './tree.js';
import {setupAI} from './ai.js';
import {createNigiri,revealNigiri,chooseNigiri} from './nigiri.js';
import {hostGameURL} from './host-address.js';
import {STATIC_HOST} from './deployment.js';
import {MatchmakingClient,matchmakingCapabilities,saveQueueSession,loadQueueSession,clearQueueSession} from './matchmaking-client.js';
import {DEFAULT_REMOTE_ENDPOINT,ONLINE_PLAY_URL} from './remote-config.js';
import {RemoteRoomClient,remoteEndpoint,remoteCode,saveRemoteSession,loadRemoteSession,lastRemoteSession,clearActiveRemoteSession} from './remote-room.js';
const $=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
let ai=null,localNigiri=null,remoteClient=null,remoteState='idle',connectionEpoch=0;
const ANDROID_OFFLINE=location.hostname==='appassets.androidplatform.net';
let roomStorage=null;try{roomStorage=sessionStorage;}catch{}
let game=E.createGame(),selected=1,index=0,pending=null,session=null,busy=false,polling=false,connecting=false,networkLost=false;
let currentMode=null,gameMode='same-screen',page='menu',hasGame=false,queueClient=null,queueStatus='idle',queueSupported=false,capabilityEpoch=0,capabilityController=null;
const MODES={'same-screen':['同屏双人','共用一台设备，轮流执黑白'],'ai':['AI 对弈','连接自己的 AI 服务，再选择人机或机机'],'lan':['局域网对弈','同一网络，打开房主的游戏页面'],'friends':['远程朋友','创建房间，把房间码发给朋友'],'matchmaking':['远程匹配','匿名寻找相同规则的对手，猜单双决定选色']};
const treePanel=document.querySelector('.tree-panel'),overview=document.createElement('details');overview.className='overview';overview.open=false;const summary=document.createElement('summary');summary.textContent='时间线树 · 展开 / 收起';overview.append(summary,treePanel);document.querySelector('aside').insertBefore(overview,document.querySelector('aside').children[1]);
const confirmBar=document.createElement('div');confirmBar.className='actions move-actions';confirmBar.innerHTML='<button id="confirmMove">确认落子</button><button id="pass" class="ghost">停一手</button><button id="cancelMove" class="ghost">取消预览</button>';document.querySelector('.board-wrap').after(confirmBar);
const tree=createTree($('tree'),(id,depth)=>{selected=id;index=depth;pending=null;render();});
function message(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
function chosenLimit(){const v=$('branchLimit').value;return v==='none'?null:v==='custom'?Number($('customLimit').value):Number(v);}
function chosenC(){return $('compensationC').value==='custom'?$('customC').value.trim():$('compensationC').value;}
function chosenPruning(){const mode=$('pruningMode').value;return {pruningMode:mode,compensationC:mode==='komi'?chosenC():'32'};}
function updatePruningControls(){const active=$('pruningMode').value==='komi';$('compensationControls').hidden=!active;$('compensationHint').hidden=!active;$('customC').hidden=$('compensationC').value!=='custom';$('branchLimit').disabled=active;$('customLimit').disabled=active;if(active)try{const info=E.compensationInfo(chosenC()),percent=Number(info.actualMin.n)/Number(info.actualMin.d)*100,raw=Number(info.rawMinimumCompensation.n)/Number(info.rawMinimumCompensation.d),rounded=Number(info.roundedMinimumCompensation.n)/Number(info.roundedMinimumCompensation.d);$('compensationHint').textContent=`实际最低新生叶 ${E.weightText(info.actualMin)}（${Number(percent.toPrecision(7)).toString()}%）· 原始最小补偿 ${raw} 目 · 半目向上取整 ${rounded} 目；本模式不用手动门槛`;}catch(e){$('compensationHint').textContent=e.message;}}
function currentLine(){return E.lineById(game,selected);}
function canAct(){const l=currentLine();return !connecting&&!(session?.mode==='remote'&&remoteState!=='connected')&&!(session&&!session.role)&&localNigiri?.phase!=='guess'&& !ai?.isAITurn(selected)&&E.canActOn(game,selected,session?.role);}
function stoneSymbol(color){const stone=document.createElement('span');stone.className='stone-symbol '+(color==='B'?'black':'white');stone.setAttribute('aria-hidden','true');return stone;}
function colorName(c){return c==='B'?'黑':'白';}
function element(tag,attrs){const e=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;}
function board(){const l=currentLine(),annotations=boardAnnotations(l,index,game.size),s=annotations.state,n=game.size,pad=27,gap=32,end=pad+(n-1)*gap,max=end+pad,svg=$('board');$('branchOrigin').textContent=branchDescription(game,l);$('branchOrigin').hidden=annotations.branchMove===null;svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${max} ${max}`);svg.append(element('rect',{x:0,y:0,width:max,height:max,fill:'#d6b47d',rx:8}));
 for(let a=0;a<n;a++){const q=pad+a*gap;svg.append(element('path',{d:`M${pad},${q}H${end}M${q},${pad}V${end}`,stroke:'#765a35','stroke-width':.8}));const label=element('text',{x:q,y:16,'text-anchor':'middle',fill:'#745933','font-size':10});label.textContent='ABCDEFGHJKLMNOPQRST'[a];svg.append(label);const num=element('text',{x:11,y:q+3,'text-anchor':'middle',fill:'#745933','font-size':9});num.textContent=n-a;svg.append(num);}
 const stars=n===9?[2,4,6]:n===13?[3,6,9]:[3,9,15];for(const a of stars)for(const b of stars)svg.append(element('circle',{cx:pad+a*gap,cy:pad+b*gap,r:2.1,fill:'#765a35'}));
 for(let i=0;i<n*n;i++){const x=pad+i%n*gap,y=pad+Math.floor(i/n)*gap,c=s.board[i];if(c){svg.append(element('circle',{cx:x,cy:y,r:14,fill:c==='B'?'#18202b':'#fff8e9',stroke:c==='B'?'#070e19':'#c4b9a4','stroke-width':1.3}));if($('showMoveNumbers').checked){const label=element('text',{x,y:y+.5,'text-anchor':'middle','dominant-baseline':'central',fill:c==='B'?'#fff8e9':'#18202b','font-size':String(annotations.numbers[i]).length>3?8: String(annotations.numbers[i]).length>2?10:12,'font-weight':700,'pointer-events':'none',class:'move-number'});label.textContent=annotations.numbers[i];svg.append(label);}if(annotations.branchAt===i)svg.append(element('circle',{cx:x,cy:y,r:15.3,fill:'none',stroke:'#c57a00','stroke-width':2.5,class:'branch-origin','pointer-events':'none'}));if(index===l.history.length&&l.dead.includes(i))svg.append(element('path',{d:`M${x-7},${y-7}l14,14m0,-14l-14,14`,stroke:'#f25f76','stroke-width':3}));}if(pending===i)svg.append(element('circle',{cx:x,cy:y,r:13,fill:s.toPlay==='B'?'#18202b88':'#fff8e999',stroke:'#2d8994','stroke-width':3,'stroke-dasharray':'3 2'}));const last=l.history[index-1];if(last?.type==='play'&&last.at===i)svg.append(element('circle',{cx:x,cy:y,r:$('showMoveNumbers').checked?11:4,fill:$('showMoveNumbers').checked?'none':c==='B'?'#70ead2':'#744dcc',stroke:c==='B'?'#70ead2':'#744dcc','stroke-width':1.5,'stroke-dasharray':$('showMoveNumbers').checked?'2 2':'none',class:'last-move','pointer-events':'none'}));const hit=element('rect',{x:x-16,y:y-16,width:32,height:32,class:'hit',tabindex:0,role:'gridcell','aria-label':`${'ABCDEFGHJKLMNOPQRST'[i%n]}${n-Math.floor(i/n)} ${c?colorName(c)+'子':'空'}${c&&$('showMoveNumbers').checked?' · 第 '+annotations.numbers[i]+' 手':''}`});const click=()=>{if(l.status==='scoring'&&index===l.history.length){act({type:'toggleDead',id:selected,at:i});return;}if(!canAct()){message(E.turnInfo(game,selected).waiting?E.turnInfo(game,selected).reason:'请选择你本轮尚未操作、且当前轮到你颜色的时间线',true);return;}try{E.apply(s,{type:'play',at:i,color:s.toPlay},n);pending=i;board();$('confirmMove').disabled=false;message(`预览 ${'ABCDEFGHJKLMNOPQRST'[i%n]}${n-Math.floor(i/n)}，点击“确认落子”提交`);}catch(e){message(e.message,true);}};hit.addEventListener('click',click);hit.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();click();}});svg.append(hit);}
}
function render(){renderNigiri();if(!game.lines.some(l=>l.id===selected))selected=game.lines[0].id;const l=currentLine();index=Math.min(index,l.history.length);$('round').textContent=`● 黑第 ${game.turns.B.epoch} 轮 · 剩 ${game.turns.B.pending.length} 线　○ 白第 ${game.turns.W.epoch} 轮 · 剩 ${game.turns.W.pending.length} 线`;$('lineTitle').textContent=`时间线 #${selected} · 权重 ${E.weightText(l.weight)}`;const turn=E.turnInfo(game,selected);$('turn').classList.toggle('turn-waiting',turn.waiting);$('turn').textContent=l.status==='playing'?turn.reason:l.status==='scoring'?'双方计分':`${l.result.winner==='draw'?'平局':colorName(l.result.winner)+'胜'}`;if(turn.canPlay)$('turn').replaceChildren(stoneSymbol(turn.toPlay),document.createTextNode(' '+colorName(turn.toPlay)+'方可下'));
 $('history').max=l.history.length;$('history').value=index;$('historyLabel').textContent=`第 ${index} / ${l.history.length} 步${index<l.history.length?(E.canBranch(game,l)?' · 历史预览：不同落子将创建分支，旧线保留':' · 已到分叉门槛，仅可继续当前叶'):' · 最新局面'} · 门槛 ${game.pruningMode==='komi'?E.weightText(E.compensationInfo(game.compensationC).actualMin)+'（新生叶）':game.branchLimitExponent==null?'不限制':'1/'+String(2n**BigInt(game.branchLimitExponent))}`;$('confirmMove').disabled=pending===null||!canAct()||busy;$('pass').disabled=!canAct()||busy;$('prune').disabled=!canAct()||busy||game.pruningMode==='none'||index===0;$('prev').disabled=index===0;$('next').disabled=index===l.history.length;$('scoring').hidden=l.status!=='scoring'||index!==l.history.length;
 if(l.status==='scoring'){const sc=E.score(game,selected);$('scorePreview').textContent=`黑 ${sc.B} · 白 ${sc.W}（含当前贴目 ${E.effectiveKomi(game,l)}） · 已确认：${l.approvals.map(colorName).join('、')||'无'}`;for(const c of ['B','W'])$('approve'+c).disabled=l.approvals.includes(c)||!!(session&&session.role!==c)||busy||(session?.mode==='remote'&&remoteState!=='connected');}
 const t=E.totals(game);$('totals').replaceChildren();for(const[k,label]of Object.entries({B:'黑胜权重',W:'白胜权重',draw:'平局权重',unsettled:'未结算权重'})){const d=document.createElement('div');d.className='stat';const b=document.createElement('strong');b.textContent=E.weightText(t[k]);const span=document.createElement('span');span.textContent=label;d.append(b,span);$('totals').append(d);}$('matchResult').textContent=E.majority(t.B)?'黑方已锁定胜利':E.majority(t.W)?'白方已锁定胜利':t.unsettled.n==='0'?'对局结束 · 整体平局':'无限可能，尚未定局';
 $('pruningLedger').textContent=`剪枝模式：${{none:'不剪枝',resign:'认输剪枝',komi:'贴目补偿'}[game.pruningMode||'none']} · 本盘白贴目 ${E.effectiveKomi(game,l)} · 累计调整 ${game.komiCompensation?E.weightText(game.komiCompensation):'0/1'} 目`;$('archives').replaceChildren();for(const entry of game.archives||[]){const p=document.createElement('p');p.className='muted';p.textContent=`第 ${entry.round} 轮 · ${colorName(entry.actor)}方 ${entry.mode==='resign'?'认输':'贴目补偿'}剪枝 · ${entry.lines.length} 叶 · 原权重 ${E.weightText(entry.subtreeWeight)} · 白贴目调整 ${E.weightText(entry.komiDelta)}`;$('archives').append(p);}$('archivePanel').hidden=!(game.archives||[]).length;
 $('lines').replaceChildren();const done=game.lines.filter(l=>l.status==='settled').length;const settled=E.add(E.add(t.B,t.W),t.draw);$('lineCount').textContent=`完成 ${done} / ${game.lines.length} · 已结算 ${Number(BigInt(settled.n)*10000n/BigInt(settled.d))/100}%`; for(const line of game.lines){const b=document.createElement('button');const availability=E.turnInfo(game,line.id);b.className='line-item'+(line.id===selected?' selected':'')+(availability.waiting?' turn-waiting':'');const left=document.createElement('span');left.textContent=`${selected===line.id?'▶ ':''}#${line.id} · ${E.weightText(line.weight)}`;const right=document.createElement('small');right.textContent=`${line.history.length} 步 · ${line.status==='settled'?(line.archived?'认输归档':'已结算'):line.status==='scoring'?'待计分':availability.reason}`;if(availability.canPlay){right.textContent=right.textContent.replace(/● |○ /,'');right.prepend(stoneSymbol(availability.toPlay),document.createTextNode(' '));}b.append(left,right);b.onclick=()=>{selected=line.id;index=line.history.length;pending=null;render();};$('lines').append(b);}
 $('connection').textContent=session?`${session.mode==='remote'?'远程':'局域网'} ${session.code} · ${session.role?colorName(session.role)+'方':'待选色'}`:DEFAULT_REMOTE_ENDPOINT?'在线服务':STATIC_HOST?'静态同屏版':'同屏模式';$('new').disabled=!!session||connecting;$('load').disabled=!!session||connecting;renderRoomControls();renderNavigation();board();tree.render(game);ai?.update();
}
function localAction(a){switch(a.type){case'play':return E.play(game,a.id,a.index,a.at);case'toggleDead':return E.toggleDead(game,a.id,a.at);case'approveScore':return E.approveScore(game,a.id,a.color);case'resume':return E.resume(game,a.id);case'prune':return E.prune(game,a.id,a.index,E.replay(E.lineById(game,a.id).history,game.size).toPlay);}}
async function request(path,body,auth=true){
 const target=session,epoch=connectionEpoch;
 if(auth&&target?.mode==='remote'){
  const client=remoteClient,kind=path.split('/').at(-1);
  try{return await client.mutate(kind,body);}catch(e){if(epoch===connectionEpoch&&session===target&&e.snapshot)accept(e.snapshot,target);throw e;}
 }
 if(STATIC_HOST)throw new Error('这是静态同屏版；局域网对战请打开房主 Node 服务提供的页面');
 const response=await fetch(new URL(path.replace(/^\//,''),import.meta.url),{method:body===undefined?'GET':'POST',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(auth&&target?{Authorization:'Bearer '+target.token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});let data;
 try{data=await response.json();}catch{throw new Error('请用 node server.js 启动局域网房间服务');}
 if(epoch!==connectionEpoch||auth&&session!==target)throw new Error('已离开原房间');
 if(!response.ok){if(data.game)accept(data,target);throw new Error(data.error||'网络请求失败');}return data;
}
function accept(data,target=session){
 if(!target||session!==target||data.code!==target.code||data.revision<target.revision)return;
 const changed=target.revision!==data.revision;
 // Validate data before replacing the usable local export. Remote operators are
 // an explicit trust boundary, but malformed snapshots must not erase a game.
 const nextGame=changed&&target.mode==='remote'?E.importGame(JSON.stringify(data.game)):data.game;
 target.revision=data.revision;target.role=data.role;target.seat=data.seat;target.setup=data.setup;target.players=data.players;target.expiresAt=data.expiresAt;target.limits=data.limits;
 if(changed){game=nextGame;const l=game.lines.find(l=>l.id===selected);index=l?.history.length??0;pending=null;render();}
 renderRoomInfo();
}
function defaultRemoteService(){return $('remoteServiceMode').value==='default';}
function renderRoomInfo(){
 if(session){
  if(session.matchmaking){$('roomInfo').textContent=`匿名匹配房间 ${session.code} · ${session.role?'你执'+colorName(session.role):'请完成猜单双与选色'}。返回玩法会保持连接；退出请点断开连接。`;return;}
  const who=`房间 ${session.code} · 你是${session.role?colorName(session.role)+'方':'席位 '+session.seat+'（待选色）'} · ${session.players?.W?'双方已加入':'等待另一方加入'}`;
  $('roomInfo').textContent=session.mode==='remote'?`${who}。${defaultRemoteService()?'朋友打开本网页，选择默认在线服务':'朋友需选择同一自定义服务'}，并输入此 12 位房间码。${Number.isFinite(session.expiresAt)?'到期时间：'+new Date(session.expiresAt).toLocaleString()+'。':''}`:`${who}。让另一设备打开同一电脑的局域网地址，单个空房可直接加入；多房间才需房间码`;
 }else $('roomInfo').textContent=$('networkMode').value==='remote'?`${defaultRemoteService()?'创建后把本网页和房间码发给朋友，双方选择默认在线服务即可':'创建后把本网页、房间码和自定义服务地址发给朋友'}。每房仅限两人；房间码请只给要加入的朋友。`:STATIC_HOST?'静态网页不提供局域网房间服务器。请启动 Node 服务，并打开房主地址上的同套页面；不要从本 HTTPS 页面直连 HTTP 局域网后端。':'用 Node 启动房间服务后，同 Wi-Fi 的另一台设备打开电脑的局域网地址。单个可加入房间无需手输码；无需账号';
}
function renderRoomControls(){
 const remote=$('networkMode').value==='remote',disabled=!!session||connecting||!!queueClient;
 $('remoteOptions').hidden=!remote;$('remoteAndroid').hidden=!ANDROID_OFFLINE;
 $('networkMode').disabled=disabled;$('remoteServiceMode').disabled=disabled;$('remoteEndpoint').disabled=disabled;$('roomCode').disabled=disabled;$('new').disabled=disabled;$('load').disabled=disabled;
 $('remoteCustomService').hidden=defaultRemoteService();
 $('remoteConfigNote').textContent=defaultRemoteService()?'双方使用本网页的默认在线服务，无需填写服务地址。':'请填写你或朋友部署的兼容 HTTPS 房间服务，只含完整源地址，不含路径或参数。双方必须选择同一自定义服务。';
 $('roomCode').maxLength=remote?12:8;$('roomCode').placeholder=remote?'远程房间码（12 位，必填）':'房间码（单局可留空）';
 $('host').textContent=remote?'同意连接并随机创建房间':'随机创建房间';$('join').textContent=remote?'同意连接并加入 / 恢复':'加入房间';
 $('host').disabled=disabled||(remote?ANDROID_OFFLINE||navigator.onLine===false:STATIC_HOST);$('join').disabled=$('host').disabled;
 $('leave').disabled=!session&&!connecting;$('copyRoom').hidden=!session||gameMode==='matchmaking';$('connectedActions').hidden=!session&&!connecting;
 $('friendSetup').hidden=currentMode==='matchmaking'||!!session;$('matchmakingSetup').hidden=currentMode!=='matchmaking'||!!session;$('remoteOptions').hidden=!remote||!!session;
 $('startMatchmaking').disabled=disabled||!queueSupported||ANDROID_OFFLINE||navigator.onLine===false;$('startMatchmaking').hidden=!!queueClient;$('cancelMatchmaking').hidden=!queueClient;$('cancelMatchmaking').disabled=queueStatus==='cancelling';
 for(const id of ['size','komi','pruningMode','compensationC','customC','branchLimit','customLimit','colorSetup','hostColor'])$(id).disabled=disabled||(id==='branchLimit'||id==='customLimit')&&$('pruningMode').value==='komi';
 $('resume').disabled=busy||session?.mode==='remote'&&remoteState!=='connected';
 renderRoomInfo();
}
function remoteStatusUpdate(client,status){
 if(remoteClient!==client)return;
 remoteState=status.state;
 $('remoteStatus').textContent={connecting:'正在连接远程房间…',connected:'远程已连接 · 实时同步',offline:'当前离线，联网后会自动重连；可先导出当前棋局',paused:'页面在后台，已暂停同步；回来后会先刷新棋局',reconnecting:`连接中断，${status.delay?Math.ceil(status.delay/1000)+' 秒后':''}自动重连；请等待同步完成后再落子`,ended:status.reason}[status.state]||'';
 if(status.state==='ended')message(status.reason,true);
 if(session?.mode==='remote')render();
}
async function act(a){if(busy||connecting)return;const epoch=connectionEpoch,target=session;if(a.type==='play'&&((session&&!session.role)||localNigiri?.phase==='guess')){message('请先完成猜先与选色',true);return false;}busy=true;try{if(session){const data=await request(`/api/rooms/${session.code}/actions`,{...a,revision:session.revision});if(epoch!==connectionEpoch||session!==target)return false;accept(data,target);}else{const id=localAction(a);if(a.type==='play')selected=id;if(a.type==='prune'||!game.lines.some(l=>l.id===selected))selected=game.queue[0]||game.lines[0].id;index=currentLine().history.length;}pending=null;message(a.type==='play'?'已落子。可自由选择本轮尚未操作且轮到自己颜色的时间线':'已更新棋局');return true;}catch(e){if(epoch===connectionEpoch)message(e.status===507?'远程房间已达资源上限，棋局已保留。请导出 JSON，回到同屏继续。':e.message,true);return false;}finally{if(epoch===connectionEpoch){busy=false;render();}}}
$('confirmMove').onclick=()=>{if(pending!==null)act({type:'play',id:selected,index,at:pending});};$('cancelMove').onclick=()=>{pending=null;render();message('已取消落子预览');};$('pass').onclick=()=>act({type:'play',id:selected,index,at:null});$('history').oninput=e=>{index=Number(e.target.value);pending=null;render();};$('prev').onclick=()=>{index--;pending=null;render();};$('next').onclick=()=>{index++;pending=null;render();};$('live').onclick=()=>{index=currentLine().history.length;pending=null;render();};$('current').onclick=()=>{const choices=E.eligibleIds(game,session?.role).filter(id=>!ai?.isAITurn(id));if(choices.length){selected=choices[0];index=currentLine().history.length;pending=null;render();}else message('暂无你可操作的时间线，请查看黑白棋子标识或等待对方行动');};
for(const c of ['B','W'])$('approve'+c).onclick=()=>act({type:'approveScore',id:selected,color:c});$('resume').onclick=()=>act({type:'resume',id:selected});
$('pruningMode').onchange=updatePruningControls;$('compensationC').onchange=updatePruningControls;$('customC').oninput=updatePruningControls;
$('prune').onclick=()=>{try{const actor=E.replay(currentLine().history,game.size).toPlay,info=E.pruningInfo(game,selected,index,actor);const consequence=info.mode==='resign'?`这些权重将实际判给${colorName(E.other(actor))}方`:`剩余未结算盘的白贴目调整 ${E.weightText(info.komiDelta)} 目，剩余权重按比例归一化`;if(confirm(`剪除这个完整历史子树的 ${info.affectedIds.length} 条叶，原总权重 ${E.weightText(info.subtreeWeight)}？${consequence}。归档路线不可复活。`))act({type:'prune',id:selected,index});}catch(e){message(e.message,true);}};
$('branchLimit').onchange=()=>{$('customLimit').hidden=$('branchLimit').value!=='custom';};
$('new').onclick=()=>{if(session||queueClient||connecting)return;if(game.lines.some(l=>l.history.length)&&!confirm('新对局会替换当前同屏对局，请先导出保存。继续？'))return;try{game=E.createGame(Number($('size').value),Number($('komi').value),chosenLimit(),chosenPruning());selected=1;index=0;pending=null;localNigiri=null;ai?.reset();hasGame=true;gameMode=currentMode||'same-screen';page='play';if(currentMode==='ai')$('aiPlayDetails').open=true;syncSetupFromGame();updateRoute(false);render();focusPage();message('新对局已准备好');}catch(e){message(e.message,true);}};
$('save').onclick=()=>{const blob=new Blob([E.exportGame(game)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='infinite-go.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};$('load').onchange=async e=>{const f=e.target.files[0];if(!f||session)return;try{if(f.size>10_000_000)throw new Error('导入文件过大（上限 10 MB）');const loaded=E.importGame(await f.text());if(game.lines.some(l=>l.history.length)&&!confirm('导入会替换当前同屏对局。继续？'))return;game=loaded;localNigiri=null;selected=game.lines[0].id;index=currentLine().history.length;pending=null;ai?.reset();hasGame=true;gameMode=currentMode==='ai'?'ai':'same-screen';currentMode=gameMode;page='play';syncSetupFromGame();updateRoute(false);render();message('已导入并验证保存文件');}catch(e){message(e.message,true);}finally{e.target.value='';}};
$('help').onclick=()=>{$('modeHelp').hidden=false;$('rules').open=true;$('rules').scrollIntoView({behavior:'smooth'});};$('zoomIn').onclick=()=>tree.zoom(1.2);$('zoomOut').onclick=()=>tree.zoom(1/1.2);$('resetTree').onclick=()=>tree.reset();
async function connect(join){
 if(connecting||session||queueClient)return;
 if(game.lines.some(l=>l.history.length)&&!confirm('连接房间将替换当前棋局。请先导出保存。继续？'))return;
 const remote=$('networkMode').value==='remote',epoch=++connectionEpoch;
 connecting=true;renderRoomControls();
 let candidate=null;
 try{
  let code=$('roomCode').value.trim().toUpperCase(),data;
  const options={size:Number($('size').value),komi:Number($('komi').value),branchLimitExponent:chosenLimit(),...chosenPruning(),colorSetup:$('colorSetup').value,hostColor:$('hostColor').value};
  if(remote){
   if(ANDROID_OFFLINE)throw new Error('请在系统浏览器打开在线游戏页面使用远程房间');
   if(navigator.onLine===false)throw new Error('当前离线；同屏模式仍可使用，联网后再连接远程房间');
   const endpoint=remoteEndpoint($('remoteEndpoint').value);$('remoteEndpoint').value=endpoint;
   if(join)code=remoteCode(code);
   candidate=new RemoteRoomClient({endpoint,onSnapshot:data=>{if(remoteClient!==candidate||session?.mode!=='remote')return;try{accept(data);}catch{candidate.end('远程棋局数据无效，已保留当前副本，请导出保存');}},onStatus:status=>remoteStatusUpdate(candidate,status)});
   remoteClient=candidate;remoteState='connecting';$('remoteStatus').textContent='正在连接所选 HTTPS 服务…';
   const saved=join?loadRemoteSession(roomStorage,endpoint,code):null;
   data=saved?await candidate.resume(saved):join?await candidate.join(code):await candidate.create(options);
  }else{
   if(join&&!code){const listing=await request('/api/rooms',undefined,false);const available=listing.rooms.filter(r=>!r.players.W);if(available.length!==1)throw new Error(available.length?'有多个房间，请输入其中一个房间码：'+available.map(r=>r.code).join('、'):'没有可加入的房间，请先在房主设备创建');code=available[0].code;}
   data=await request(join?`/api/rooms/${encodeURIComponent(code)}/join`:'/api/rooms',join?{}:options,false);
  }
  if(epoch!==connectionEpoch){candidate?.close();return;}
  // Import validation precedes committing a remote session or replacing the board.
  if(remote)E.importGame(JSON.stringify(data.game));
  localNigiri=null;session={mode:remote?'remote':'lan',...(remote?{endpoint:candidate.endpoint}:{}),code:data.code,token:data.token||candidate?.room.token,role:data.role,seat:data.seat,setup:data.setup,revision:-1};
  ai?.reset();selected=1;hasGame=true;gameMode=currentMode|| (remote?'friends':'lan');page='play';accept(data);$('roomCode').value=data.code;syncSetupFromGame();updateRoute(false);
  if(remote){
   const persisted=saveRemoteSession(roomStorage,{...candidate.room,expiresAt:data.expiresAt});
   $('remoteStorage').textContent=persisted?'重连凭据已保存在当前标签页；刷新后需点“加入 / 恢复”。关闭标签页后可能丢失。分享游戏页面和房间码即可；使用自定义服务时，另行告诉朋友所选服务。不要分享浏览器存储内容。':'此浏览器不允许会话存储：刷新或关闭后可能无法恢复席位，请随时导出当前棋局。';
   candidate.start();message('已进入远程朋友房间。请等待实时连接就绪后落子；结束前请导出 JSON');
  }else{try{roomStorage?.setItem('infinite-go-room',JSON.stringify(session));}catch{}message('已连接局域网房间。房间数据仅保存在主机内存，结束前请导出');}
 }catch(e){
  candidate?.close();if(epoch===connectionEpoch){if(remoteClient===candidate)remoteClient=null;remoteState='idle';if(remote)$('remoteStatus').textContent='未连接：'+e.message;message(e.message,true);}
 }finally{if(epoch===connectionEpoch){connecting=false;render();}}
}
$('host').onclick=()=>connect(false);$('join').onclick=()=>connect(true);
$('leave').onclick=()=>{connectionEpoch++;remoteClient?.close();remoteClient=null;remoteState='idle';session=null;connecting=false;busy=false;networkLost=false;localNigiri=null;ai?.reset();try{roomStorage?.removeItem('infinite-go-room');}catch{}clearActiveRemoteSession(roomStorage);gameMode='same-screen';currentMode='same-screen';page='play';hasGame=true;syncSetupFromGame();updateRoute(false);$('remoteStatus').textContent='已断开远程连接';render();message('已回到同屏模式，保留当前棋局副本；可导出或继续落子');};
$('networkMode').onchange=()=>{if(!session&&!connecting){$('remoteStatus').textContent='';renderRoomControls();}};
let customRemoteEndpoint='';
$('remoteServiceMode').onchange=()=>{if(session||connecting||queueClient)return;$('remoteEndpoint').value=defaultRemoteService()?DEFAULT_REMOTE_ENDPOINT:customRemoteEndpoint;$('remoteStatus').textContent='尚未连接。确认所选服务后，再点同意连接';renderRoomControls();if(currentMode==='matchmaking')checkMatchmaking();};
$('remoteEndpoint').oninput=()=>{if(!session&&!connecting&&!queueClient){queueSupported=false;customRemoteEndpoint=$('remoteEndpoint').value;$('remoteStatus').textContent='尚未连接。请确认这是你信任的服务地址，再点同意连接';renderRoomControls();if(currentMode==='matchmaking'){$('matchmakingStatus').textContent='填好服务地址后，点击检查服务';$('retryMatchmaking').hidden=false;capabilityEpoch++;capabilityController?.abort();}}};
$('copyRoom').onclick=async()=>{if(!session)return;try{await navigator.clipboard.writeText(session.code);message(session.mode==='remote'?(defaultRemoteService()?'已复制房间码。朋友打开本网页，选择默认在线服务并输入房间码即可':'已复制房间码。朋友还需选择相同的自定义服务'):'已复制房间码。朋友需打开相同的局域网页面');}catch{message('房间码：'+session.code+'，可手动复制');}};
setInterval(async()=>{if(!session||session.mode==='remote'||busy||polling)return;const target=session,epoch=connectionEpoch;polling=true;try{const data=await request(`/api/rooms/${target.code}`);if(session!==target||epoch!==connectionEpoch)return;accept(data,target);if(networkLost){networkLost=false;message('局域网连接已恢复');}}catch(e){if(session===target&&epoch===connectionEpoch){networkLost=true;message(`连接中断：${e.message}。正在等待主机恢复，可导出当前副本`,true);}}finally{polling=false;}},1500);
window.addEventListener('offline',()=>{remoteClient?.setOnline(false);queueClient?.setOnline(false);renderRoomControls();});
window.addEventListener('online',()=>{remoteClient?.setOnline(true);queueClient?.setOnline(true);renderRoomControls();});
// Mobile browsers can silently suspend a socket. A visible page gets a fresh
// authenticated snapshot instead of assuming the old socket is still current.
document.addEventListener('visibilitychange',()=>{remoteClient?.setPaused?.(document.visibilityState!=='visible');if(document.visibilityState==='visible'&&navigator.onLine!==false)queueClient?.reconnect();});
window.addEventListener('pageshow',event=>{if(event.persisted&&navigator.onLine!==false){remoteClient?.reconnect();queueClient?.reconnect();}});
$('networkMode').value=STATIC_HOST||DEFAULT_REMOTE_ENDPOINT?'remote':'lan';
$('remoteServiceMode').options[0].disabled=!DEFAULT_REMOTE_ENDPOINT;
$('remoteServiceMode').value=DEFAULT_REMOTE_ENDPOINT?'default':'custom';
$('remoteEndpoint').value=DEFAULT_REMOTE_ENDPOINT;
ai=setupAI({staticHost:STATIC_HOST,getGame:()=>game,getSelected:()=>selected,isLAN:()=>!!session,isSetupPending:()=>localNigiri?.phase==='guess',perform:act,onChange:render,message});
const sharedCode=new URLSearchParams(location.search).get('room')||'';
$('roomCode').value=sharedCode.slice(0,12);
let remoteSaved=lastRemoteSession(roomStorage);
if(sharedCode&&sharedCode.toUpperCase()!==remoteSaved?.code)remoteSaved=null;
if(sharedCode.length===12)$('networkMode').value='remote';
if(remoteSaved&&(!sharedCode||sharedCode.toUpperCase()===remoteSaved.code)){$('networkMode').value='remote';$('remoteEndpoint').value=remoteSaved.endpoint;$('remoteServiceMode').value=DEFAULT_REMOTE_ENDPOINT&&remoteSaved.endpoint===remoteEndpoint(DEFAULT_REMOTE_ENDPOINT)?'default':'custom';if(!defaultRemoteService())customRemoteEndpoint=remoteSaved.endpoint;$('roomCode').value=remoteSaved.code;$('remoteStatus').textContent='发现本标签页保存的房间。确认所选服务后，点击“同意连接并加入 / 恢复”';$('roomPanel').open=true;}
syncSetupFromGame();render();try{const saved=JSON.parse(roomStorage?.getItem('infinite-go-room'));if(!STATIC_HOST&&saved?.code&&saved?.token&&saved.mode!=='remote'&&!remoteSaved){session={...saved,mode:'lan',revision:-1};hasGame=true;gameMode='lan';currentMode='lan';page='play';$('networkMode').value='lan';const target=session,epoch=connectionEpoch;request(`/api/rooms/${session.code}`).then(data=>{if(session===target&&epoch===connectionEpoch){accept(data,target);syncSetupFromGame();}}).catch(e=>{if(session!==target||epoch!==connectionEpoch)return;session=null;render();message('房间未恢复：'+e.message,true);});}}catch{}

$('showMoveNumbers').addEventListener('change',board);

function renderNigiri(){
 const state=session?.setup??localNigiri,started=game.lines.some(l=>l.history.length),canGuess=state?.phase==='guess'&&(!session||session.seat==='B'),canChoose=state?.phase==='choose'&&(!session||session.seat===state.winner);
 $('startNigiri').hidden=!!session;$('startNigiri').disabled=connecting||started||!!localNigiri||ai?.mode()==='ai-ai';
 $('guessOdd').hidden=!canGuess;$('guessEven').hidden=!canGuess;$('chooseBlack').hidden=!canChoose||started;$('chooseWhite').hidden=!canChoose||started;
 for(const id of ['guessOdd','guessEven','chooseBlack','chooseWhite'])$(id).disabled=busy||connecting||session?.mode==='remote'&&remoteState!=='connected';
 $('nigiriStones').replaceChildren();
 if(!state){$('nigiriStatus').textContent=session?'手动选色：已分配黑白。':'可选猜先：先隐藏生成 1–20 颗棋子，猜中者优先选色；同屏仅作双方约定。机机可跳过。';return;}
 if(state.phase==='guess'){$('nigiriStatus').textContent=session?'棋子数量已在房间服务器生成并隐藏，加入者（席位 B）猜单双。揭晓后赢家选黑白。':'棋子数量已生成并隐藏，请猜单或双。';return;}
 const won=state.winner==='B';$('nigiriStatus').textContent=`揭晓 ${state.count} 颗（${state.count%2?'单':'双'}），猜${state.guess==='odd'?'单':'双'}，${won?'猜中':'猜错'}。${session?'席位 '+state.winner+' 获得选色权':won?'猜方优先选色':'另一方优先选色'}${state.phase==='ready'?'，已选色。':session?'，选色前不能落子。':'；同屏可自由约定执色。'}`;
 for(let i=0;i<state.count;i++)$('nigiriStones').append(stoneSymbol('B'));
}
$('startNigiri').onclick=()=>{if(session||game.lines.some(l=>l.history.length)||localNigiri)return;localNigiri=createNigiri();ai?.reset();render();};
async function nigiriAction(type,value){if(busy||connecting)return;const target=session,epoch=connectionEpoch;try{
 if(session){busy=true;render();const data=await request(`/api/rooms/${session.code}/setup`,{type,revision:session.revision,...(type==='guess'?{guess:value}:{color:value})});if(target===session&&epoch===connectionEpoch)accept(data,target);}
 else {if(game.lines.some(l=>l.history.length))throw new Error('开局后不能改变猜先结果');if(!localNigiri)throw new Error('请先开始猜先');localNigiri=type==='guess'?revealNigiri(localNigiri,value):chooseNigiri(localNigiri,localNigiri.winner,value);
 if(ai?.mode()==='human-ai'){
  if(localNigiri.phase==='choose'&&localNigiri.winner==='A')localNigiri=chooseNigiri(localNigiri,'A','B');
  if(localNigiri.phase==='ready')ai.setHumanColor(localNigiri.roles.B);
 }
 render();}
 }catch(e){if(epoch===connectionEpoch)message(e.message,true);}finally{if(epoch===connectionEpoch){busy=false;render();}}}
$('guessOdd').onclick=()=>nigiriAction('guess','odd');$('guessEven').onclick=()=>nigiriAction('guess','even');$('chooseBlack').onclick=()=>nigiriAction('choose','B');$('chooseWhite').onclick=()=>nigiriAction('choose','W');

$('openHost').onclick=()=>{try{const url=hostGameURL($('hostAddress').value,$('hostPort').value);if(game.lines.some(l=>l.history.length)&&!confirm('打开房主页面会离开当前对局，请先导出。继续？'))return;location.assign(url);}catch(e){message(e.message,true);}};
if(STATIC_HOST&&'serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').then(registration=>{const notify=()=>{if(!navigator.serviceWorker.controller)return;let note=$('updateAvailable');if(!note){note=document.createElement('p');note.id='updateAvailable';note.className='panel muted';note.setAttribute('role','status');$('modeMenu').append(note);}note.textContent='新版本已准备好。请先导出当前棋局，再关闭本站所有标签页并重新打开，即可更新。';};if(registration.waiting)notify();registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed')notify();});});}).catch(()=>{});

if(!STATIC_HOST&&location.hash.includes('localAI='))import('./local-ai/panel.js').then(({setupLocalAI})=>setupLocalAI({onConnect:url=>ai.connectURL(url),onDisconnect:()=>ai.disconnect()})).catch(()=>message('本机 AI 设置面板未能加载，请重新打开桌面启动器',true));

function syncSetupFromGame(){
 $('size').value=game.size;$('komi').value=game.komi;$('pruningMode').value=game.pruningMode||'none';
 const c=game.compensationC||'32';$('compensationC').value=['8','32','256'].includes(c)?c:'custom';$('customC').value=c;
 const exp=game.branchLimitExponent;$('branchLimit').value=exp==null?'none':exp<=9?String(exp):'custom';$('customLimit').hidden=exp==null||exp<=9;if(exp>9)$('customLimit').value=exp;updatePruningControls();
}
function updateRoute(push=false){
 const state={infiniteGo:true,mode:currentMode,page};
 if(push)history.pushState(state,'',location.href);else history.replaceState(state,'',location.href);
}
function focusPage(){requestAnimationFrame(()=>{(page==='menu'?$('menuTitle'):$('modeTitle')).focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});if(page==='play')tree.render(game);});}
function renderNavigation(){
 const playing=page==='play',network=['lan','friends','matchmaking'].includes(currentMode),menu=page==='menu';
 $('modeMenu').hidden=!menu;$('modeWorkspace').hidden=menu;$('setupView').hidden=playing;$('playView').hidden=!playing;
 $('modeTitle').textContent=MODES[currentMode]?.[0]||'同屏双人';$('modeSubtitle').textContent=playing?'棋局进行中 · 返回玩法会保留当前棋局':MODES[currentMode]?.[1]||'';
 $('openGameTools').hidden=!playing;$('setupHelp').hidden=playing;$('lanHostEntry').hidden=currentMode!=='lan';$('localStartActions').hidden=network;$('continueLocal').hidden=!hasGame||!!session;
 $('new').textContent=hasGame?'按这些设置开始新局':'开始对局';$('editSetup').disabled=!!session||connecting||!!queueClient;
 $('savedGameBanner').hidden=!hasGame&&!session;$('savedGameTitle').textContent=session?'联机房间仍保持连接':'当前棋局已保留';$('savedGameDetail').textContent=session?'返回棋局继续；如需退出，请在棋局工具中明确断开连接。':`${MODES[gameMode]?.[0]||'同屏双人'} · ${game.size} 路 · ${game.lines.length} 条时间线`;
 $('roomControls').hidden=!network&&!session;$('roomHeading').textContent=currentMode==='matchmaking'?'匿名匹配':currentMode==='lan'?'局域网房间':'远程朋友房间';
 const roomSlot=playing?$('playConnectionSlot'):$('networkSetupSlot');if($('roomControls').parentNode!==roomSlot)roomSlot.append($('roomControls'));
 if(session)$('roomPanel').open=true;
 $('onlineEditionPanel').hidden=!!DEFAULT_REMOTE_ENDPOINT||!['friends','matchmaking'].includes(currentMode)||playing;
 $('onlinePlayLink').hidden=!ONLINE_PLAY_URL;if(ONLINE_PLAY_URL)$('onlinePlayLink').href=ONLINE_PLAY_URL;
 $('onlineEditionStatus').textContent=ONLINE_PLAY_URL?'两个网页均提供朋友房间与匿名匹配，房间和匹配池互不相通；和朋友选择同一个。新标签页打开，当前棋局仍保留。':'在线联机版地址尚未配置。也可展开下方设置，连接你信任的兼容 HTTPS 服务。';
 if(!DEFAULT_REMOTE_ENDPOINT&&['friends','matchmaking'].includes(currentMode)&&!session)$('roomHeading').textContent='高级选项 · 自定义 HTTPS 服务';
 $('roomInfo').hidden=currentMode==='matchmaking'&&!session;
 const aiPanel=document.querySelector('.ai-panel');if(aiPanel){const slot=playing?$('aiPlaySlot'):$('aiSetupSlot');if(aiPanel.parentNode!==slot)slot.append(aiPanel);aiPanel.hidden=currentMode!=='ai';}
 $('aiPlayDetails').hidden=currentMode!=='ai';
 $('activeRulesSummary').textContent=`${game.size} 路 · 贴目 ${game.komi} · ${ {none:'不剪枝',resign:'认输剪枝',komi:'贴目补偿剪枝'}[game.pruningMode||'none']} · 分叉 ${game.branchLimitExponent==null?'不限制':'门槛 1/'+String(2n**BigInt(game.branchLimitExponent))}`;
 const setup=session?.setup??localNigiri;const setupRequired=setup&&setup.phase!=='ready';
 if(setupRequired)$('nigiriPanel').hidden=false;
 else if(game.lines.some(l=>l.history.length)||session)$('nigiriPanel').hidden=true;
 $('showNigiri').disabled=!!session||game.lines.some(l=>l.history.length);$('backToModes').disabled=queueStatus==='cancelling';
}
async function selectMode(mode,{push=true}={}){
 if(!MODES[mode])return;
 if(session&&mode!==gameMode){currentMode=gameMode;page='play';updateRoute(false);render();focusPage();message('当前房间仍保持连接。请先在棋局工具中断开，再切换玩法。');$('gameTools').open=true;return;}
 if(queueClient&&mode!==currentMode){if(!await cancelQueue())return;}
 capabilityEpoch++;capabilityController?.abort();currentMode=mode;page=session?'play':'setup';$('modeHelp').hidden=true;$('nigiriPanel').hidden=true;
 $('networkMode').value=mode==='lan'?'lan':'remote';$('roomPanel').open=!!session||!['friends','matchmaking'].includes(mode)||!!DEFAULT_REMOTE_ENDPOINT;
 if(mode!=='ai'&&ai?.mode()!=='human'){$('aiMode').value='human';$('aiMode').onchange();}
 updateRoute(push);render();focusPage();
 if(mode==='matchmaking'&&!session){if($('remoteEndpoint').value.trim())checkMatchmaking();else{$('matchmakingStatus').textContent='填写自定义 HTTPS 服务，再点击检查服务';$('retryMatchmaking').hidden=false;}}
}
async function goToMenu({route=true}={}){
 if(queueClient&&!await cancelQueue())return;
 capabilityEpoch++;capabilityController?.abort();ai?.reset();page='menu';currentMode=null;$('modeHelp').hidden=true;
 if(route)updateRoute(false);render();focusPage();
}
for(const button of document.querySelectorAll('[data-mode]'))button.onclick=()=>selectMode(button.dataset.mode);
$('backToModes').onclick=()=>goToMenu();
$('resumeGame').onclick=()=>{currentMode=gameMode;page='play';updateRoute(true);render();focusPage();};
$('continueLocal').onclick=()=>{currentMode=gameMode;page='play';updateRoute(false);render();focusPage();};
$('editSetup').onclick=()=>{if(session)return;ai?.reset();page='setup';syncSetupFromGame();updateRoute(false);render();focusPage();};
$('openGameTools').onclick=()=>{$('gameTools').open=!$('gameTools').open;if($('gameTools').open)$('gameTools').scrollIntoView({behavior:'smooth',block:'start'});};
$('setupHelp').onclick=()=>{$('modeHelp').hidden=!$('modeHelp').hidden;if(!$('modeHelp').hidden){$('rules').open=true;$('modeHelp').scrollIntoView({behavior:'smooth',block:'start'});}};
$('showNigiri').onclick=()=>{$('nigiriPanel').hidden=false;$('nigiriPanel').scrollIntoView({behavior:'smooth',block:'start'});};
window.addEventListener('popstate',async event=>{
 const next=event.state;
 if(!next?.infiniteGo||next.page==='menu'){await goToMenu({route:false});return;}
 if(queueClient&&next.mode!==currentMode&&!await cancelQueue())return;
 await selectMode(next.mode,{push:false});if(next.page==='play'&&hasGame){page='play';render();focusPage();}
});

async function checkMatchmaking(){
 const epoch=++capabilityEpoch;capabilityController?.abort();capabilityController=new AbortController();const controller=capabilityController;queueSupported=false;$('retryMatchmaking').hidden=true;
 if(currentMode!=='matchmaking'||page==='menu'||queueClient)return;
 if(ANDROID_OFFLINE){$('matchmakingStatus').textContent='请在系统浏览器打开在线游戏页面使用匹配';renderRoomControls();return;}
 $('matchmakingStatus').textContent='正在检查所选服务的匹配能力…';renderRoomControls();
 const timer=setTimeout(()=>controller.abort(),10000);
 try{
  const endpoint=remoteEndpoint($('remoteEndpoint').value),caps=await matchmakingCapabilities(endpoint,{signal:controller.signal});
  if(epoch!==capabilityEpoch||currentMode!=='matchmaking')return;
  queueSupported=caps.supported;
  const saved=loadQueueSession(roomStorage,endpoint);
  $('matchmakingStatus').textContent=queueSupported?saved?'发现本标签页的排队记录。点击同意连接可恢复同一次匹配。':'服务支持匹配。按上方棋局设置寻找对手，最多等待 5 分钟。':'所选服务尚未支持匹配，需要更新后端。远程朋友房间仍可使用。';
  $('startMatchmaking').textContent=saved?'同意连接并恢复匹配':'同意连接并开始匹配';$('retryMatchmaking').hidden=queueSupported;
 }catch(error){if(epoch===capabilityEpoch){$('matchmakingStatus').textContent=error.name==='AbortError'?'检查超时，请重试或选择可用服务。':error.message;$('retryMatchmaking').hidden=false;}}
 finally{clearTimeout(timer);if(epoch===capabilityEpoch)renderRoomControls();}
}
function queueOptions(){return {size:Number($('size').value),komi:Number($('komi').value),branchLimitExponent:chosenLimit(),...chosenPruning(),rules:'infinite-go-v2'};}
function queueUpdate(client,status){
 if(queueClient!==client)return;queueStatus=status.status;
 const remaining=Number.isFinite(status.expiresAt)?Math.max(0,Math.ceil((status.expiresAt-Date.now())/1000)):null;
 const labels={starting:'正在加入匹配队列…',waiting:`正在寻找相同规则的对手${remaining!==null?' · 最多还需等待 '+Math.ceil(remaining/60)+' 分钟':''}`,matching:'已找到对手，正在准备房间…',matched:'匹配成功，正在进入棋局…',cancelling:'正在确认取消…',cancelled:'已取消匹配',expired:'本次匹配已超时，请重新开始',offline:'网络已断开。恢复后检查同一次排队；长时间离线会退出队列。',reconnecting:'连接中断，正在恢复同一次排队…',ended:status.error,'cancel-failed':status.error};
 $('matchmakingStatus').textContent=labels[status.status]||status.error||'';
 if(['waiting','matching','reconnecting','offline'].includes(status.status))saveQueueSession(roomStorage,{endpoint:client.endpoint,token:client.token,options:client.options,confirmed:client.confirmed,expiresAt:client.expiresAt||Date.now()+300000});
 if(['cancelled','expired','ended'].includes(status.status)){clearQueueSession(roomStorage,client.endpoint);client.close();queueClient=null;queueStatus='idle';}
 renderRoomControls();renderNavigation();
}
function adoptMatchedRoom(client,data){
 if(queueClient!==client)return;
 try{
  E.importGame(JSON.stringify(data.game));
  const candidate=new RemoteRoomClient({endpoint:client.endpoint,onSnapshot:data=>{if(remoteClient===candidate&&session?.mode==='remote')try{accept(data);}catch{candidate.end('远程棋局数据无效，请导出保留的副本');}},onStatus:status=>remoteStatusUpdate(candidate,status)});
  candidate.adopt(data);saveRemoteSession(roomStorage,{...candidate.room,expiresAt:data.expiresAt});clearQueueSession(roomStorage,client.endpoint);client.close();queueClient=null;queueStatus='idle';
  connectionEpoch++;remoteClient=candidate;remoteState='connecting';session={mode:'remote',matchmaking:true,endpoint:client.endpoint,code:data.code,token:data.token,role:data.role,seat:data.seat,setup:data.setup,revision:-1};
  hasGame=true;gameMode=currentMode='matchmaking';page='play';selected=1;localNigiri=null;ai?.reset();accept(data);syncSetupFromGame();$('roomCode').value=data.code;updateRoute(false);candidate.start();render();focusPage();
  message('匹配成功。请完成猜单双和选色，连接就绪后开始对局。');
 }catch(error){client.matched=false;queueStatus='handoff-failed';$('retryMatchmaking').hidden=false;$('retryMatchmaking').textContent='重试进入房间';$('matchmakingStatus').textContent='匹配房间未能载入：'+error.message+'。请保留此标签页并重试恢复。';message('匹配房间未能载入，当前棋局仍已保留',true);}
}
async function startQueue(){
 if(queueClient||session||connecting||!queueSupported)return;
 if(game.lines.some(l=>l.history.length)&&!confirm('匹配成功后将替换当前棋局，请先导出保存。继续？'))return;
 try{
  const endpoint=remoteEndpoint($('remoteEndpoint').value),saved=loadQueueSession(roomStorage,endpoint),options=saved?.options||queueOptions();
  E.createGame(options.size,options.komi,options.branchLimitExponent,options);
  const client=new MatchmakingClient({endpoint,...(saved?{token:saved.token}:{}),onStatus:status=>queueUpdate(client,status),onMatched:data=>adoptMatchedRoom(client,data)});
  queueClient=client;saveQueueSession(roomStorage,{endpoint,token:client.token,options,confirmed:saved?.confirmed===true,expiresAt:saved?.expiresAt||Date.now()+300000});
  if(saved)await client.resume(saved);else await client.start(options);
 }catch(error){if(!queueClient)message(error.message,true);else if(queueClient.status==='ended')message(error.message,true);}
 finally{renderRoomControls();}
}
async function cancelQueue(){
 const client=queueClient;if(!client)return true;
 try{
  const result=await client.cancel();
  if(['matched','matching'].includes(result.status)){$('matchmakingStatus').textContent='对手已匹配成功，正在进入房间。可进入后明确断开连接。';message('匹配已成功，无法取消排队；已保留房间。');updateRoute(false);return false;}
  clearQueueSession(roomStorage,client.endpoint);if(queueClient===client)queueClient=null;queueStatus='idle';renderRoomControls();return true;
 }catch{message('取消尚未确认。请重试取消；保留此页面可继续恢复排队状态。',true);renderRoomControls();return false;}
}
$('startMatchmaking').onclick=startQueue;$('cancelMatchmaking').onclick=cancelQueue;$('retryMatchmaking').onclick=()=>queueClient?queueClient.reconnect():checkMatchmaking();
// The menu is network quiet. Shared room codes and explicit local AI launchers
// open their own setup without contacting a remote service automatically.
if(sharedCode||remoteSaved){currentMode=$('networkMode').value==='lan'?'lan':'friends';page='setup';}
if(!STATIC_HOST&&location.hash.includes('localAI=')){currentMode='ai';page='setup';}
updateRoute(false);renderNavigation();
