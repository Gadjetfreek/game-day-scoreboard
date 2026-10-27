(function(){
"use strict";
var ESPN="https://site.api.espn.com/apis/site/v2/sports/";
var LEAGUES=[
 {k:"cfb",path:"football/college-football",label:"College Football",short:"CFB",sport:"fb"},
 {k:"nfl",path:"football/nfl",label:"NFL",short:"NFL",sport:"fb"},
 {k:"nba",path:"basketball/nba",label:"NBA",short:"NBA",sport:"bb"},
 {k:"nhl",path:"hockey/nhl",label:"NHL",short:"NHL",sport:"hk"},
 {k:"mlb",path:"baseball/mlb",label:"MLB",short:"MLB",sport:"mlb"}
];
var LG={};LEAGUES.forEach(function(l){LG[l.k]=l;});
var GRID_MS=25000, GAME_MS=15000;
var mode="direct"; // switches to "proxy" if the browser can't reach ESPN directly
var games={}, leagueOK={}, leagueErr={}, lastOk=0, lastErr=null, prevScores={};
var view={name:"home",league:load("gd_league","all"),tab:"live",gid:null,glg:null,detail:null,detailErr:null,detailOk:0};
var timer=null, fromHome=false;

function load(k,d){try{var v=localStorage.getItem(k);return v==null?d:JSON.parse(v);}catch(e){return d;}}
function save(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function clean(s){return String(s||"").replace(/\s+/g," ").trim();}
function hex(c){return /^[0-9a-fA-F]{6}$/.test(c||"")?"#"+c:"#666";}
function $(id){return document.getElementById(id);}

function fetchT(url,ms){
  var ctl=window.AbortController?new AbortController():null;
  var t=setTimeout(function(){ctl&&ctl.abort();},ms||12000);
  return fetch(url,{signal:ctl?ctl.signal:undefined,cache:"no-store"}).then(function(r){clearTimeout(t);if(!r.ok)throw new Error("HTTP "+r.status);return r.json();},function(e){clearTimeout(t);throw e;});
}
function api(path,params){
  var qs=Object.keys(params||{}).map(function(k){return k+"="+encodeURIComponent(params[k]);}).join("&");
  var direct=ESPN+path+(qs?"?"+qs:"");
  var proxy="proxy.php?p="+encodeURIComponent(path)+(qs?"&"+qs:"");
  if(mode==="proxy") return fetchT(proxy);
  return fetchT(direct).catch(function(e){
    return fetchT(proxy).then(function(j){mode="proxy";return j;},function(){throw e;});
  });
}

/* ---------- parsing ---------- */
function recOf(t){var r=t.records||t.record||[];return (r[0]&&(r[0].summary||r[0].displayValue))||"";}
function teamOf(t){
  var tm=t.team||{}; var rk=(t.curatedRank&&t.curatedRank.current)||t.rank;
  var logo=tm.logo||(tm.logos&&tm.logos[0]&&tm.logos[0].href)||"";
  return {id:tm.id||t.id,abbr:tm.abbreviation||"",name:tm.shortDisplayName||tm.nickname||tm.displayName||"",full:tm.displayName||"",
    color:tm.color,logo:logo,rank:(rk&&rk<=25)?rk:null,score:t.score!=null?String(t.score):"",rec:recOf(t),
    ls:(t.linescores||[]).map(function(l){return l.displayValue!=null?l.displayValue:String(l.value!=null?l.value:"");}),
    winner:!!t.winner};
}
function ddText(sit){
  if(!sit)return "";
  if(sit.downDistanceText)return sit.downDistanceText;
  if(sit.shortDownDistanceText)return sit.shortDownDistanceText;
  if(sit.down>0){var o=["","1st","2nd","3rd","4th"][sit.down]||sit.down+"th";return o+" & "+(sit.distance===0?"Goal":sit.distance);}
  return "";
}
function parseEvent(e,lg){
  var c=e.competitions[0], st=e.status||c.status, ty=st.type||{};
  var cs={};(c.competitors||[]).forEach(function(t){cs[t.homeAway]=t;});
  if(!cs.away||!cs.home)return null;
  var nets=[];(c.broadcasts||[]).forEach(function(b){(b.names||[]).forEach(function(n){nets.push(n);});});
  var g={id:e.id,lg:lg,state:ty.state,detail:ty.shortDetail||ty.detail||"",completedText:ty.description||"",
    clock:st.displayClock||"",period:st.period||0,net:c.broadcast||nets.join(", "),ts:e.date,
    venue:(c.venue&&c.venue.fullName)||"",away:teamOf(cs.away),home:teamOf(cs.home),name:e.name||""};
  var s=c.situation;
  if(s&&ty.state==="in"){
    g.sit={dd:ddText(s),poss:s.possession||null,red:!!s.isRedZone,last:clean(s.lastPlay&&s.lastPlay.text),
      possText:s.possessionText||"",balls:s.balls,strikes:s.strikes,outs:s.outs,on1:s.onFirst,on2:s.onSecond,on3:s.onThird,
      batter:s.batter&&s.batter.athlete&&s.batter.athlete.shortName,pitcher:s.pitcher&&s.pitcher.athlete&&s.pitcher.athlete.shortName};
  }
  return g;
}
function startText(ts){
  var d=new Date(ts); if(isNaN(d))return "";
  var now=new Date(), same=d.toDateString()===now.toDateString();
  var t=d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"});
  return same?t:d.toLocaleDateString([], {weekday:"short"})+" "+t;
}
function statusText(g){return g.state==="pre"?startText(g.ts):g.detail;}
function periodLabel(lg,p){
  if(lg==="mlb")return "Inn "+p;
  if(lg==="nhl")return p>3?(p===4?"OT":"SO"):"P"+p;
  return p>4?(p===5?"OT":(p-4)+"OT"):"Q"+p;
}
function stripClock(x){return String(x||"").replace(/^\(\d{1,2}:\d{2}\)\s*/,"");}

function parseSummary(s,lg){
  var out={};
  var hc=s.header&&s.header.competitions&&s.header.competitions[0];
  if(hc){
    var ev={id:s.header.id,date:hc.date,status:hc.status,competitions:[{competitors:hc.competitors,broadcasts:[],venue:(s.gameInfo&&s.gameInfo.venue)||null,status:hc.status}]};
    var g=parseEvent(ev,lg); if(g){
      var nets=[];(hc.broadcasts||[]).forEach(function(b){var n=(b.media&&b.media.shortName)||(b.names&&b.names[0]);if(n&&nets.indexOf(n)<0)nets.push(n);});
      g.net=nets.join(", ");
      hc.competitors.forEach(function(t){if(t.possession)g.possId=(t.team||{}).id||t.id;});
      out.game=g;
    }
  }
  var ids={};
  if(out.game){ids[out.game.away.id]=out.game.away.abbr;ids[out.game.home.id]=out.game.home.abbr;}
  var plays=[];
  if(s.drives){
    var dr=s.drives, all=[], seen={};
    (dr.previous||[]).concat(dr.current?[dr.current]:[]).forEach(function(d){
      var ab=(d.team&&d.team.abbreviation)||"";
      (d.plays||[]).forEach(function(p){if(seen[p.id])return;seen[p.id]=1;all.push([p,ab]);});
    });
    all.slice(-25).reverse().forEach(function(x){var p=x[0];
      plays.push({c:(p.clock&&p.clock.displayValue)||"",p:(p.period&&p.period.number)||0,tm:x[1],x:clean(p.text),dd:(p.start&&(p.start.downDistanceText||p.start.shortDownDistanceText))||"",sc:!!p.scoringPlay,a:p.awayScore,h:p.homeScore});
    });
    var cur=dr.current||((dr.previous||[])[ (dr.previous||[]).length-1 ]);
    if(cur){
      var ps=cur.plays||[], last=ps[ps.length-1]||{}, end=last.end||{};
      out.drive={tm:(cur.team&&cur.team.abbreviation)||"",tmId:cur.team&&cur.team.id,desc:cur.description||"",n:cur.offensivePlays||0,yds:cur.yards||0,
        time:(cur.timeElapsed&&cur.timeElapsed.displayValue)||"",startYTE:ps.length&&ps[0].start?ps[0].start.yardsToEndzone:(cur.start&&cur.start.yardsToEndzone),
        ytE:end.yardsToEndzone, dd:end.downDistanceText||end.shortDownDistanceText||ddText(end), possText:end.possessionText||"",
        last:clean(last.text), isCurrent:!!dr.current};
    }
    out.scoring=(s.scoringPlays||[]).map(function(p){return {c:(p.clock&&p.clock.displayValue)||"",p:(p.period&&p.period.number)||0,tm:(p.team&&p.team.abbreviation)||"",x:clean(p.text),a:p.awayScore,h:p.homeScore};});
  } else if(s.plays&&s.plays.length){
    s.plays.slice(-25).reverse().forEach(function(p){
      plays.push({c:(p.clock&&p.clock.displayValue)||"",p:(p.period&&p.period.number)||0,tm:ids[(p.team||{}).id]||"",x:clean(p.text),sc:!!p.scoringPlay,a:p.awayScore,h:p.homeScore});
    });
    out.scoring=s.plays.filter(function(p){return p.scoringPlay;}).slice(-30).map(function(p){return {c:(p.clock&&p.clock.displayValue)||"",p:(p.period&&p.period.number)||0,tm:ids[(p.team||{}).id]||"",x:clean(p.text),a:p.awayScore,h:p.homeScore};});
  }
  out.plays=plays;
  var bt=(s.boxscore&&s.boxscore.teams)||[];
  function flat(t){var o={},keys=[];(t.statistics||[]).forEach(function(st){
    if(st.stats){st.stats.forEach(function(x){var k=x.label||x.abbreviation||x.name;if(k&&!(k in o)){o[k]=x.displayValue;keys.push(k);}});}
    else{var k=st.label||st.name;if(k&&!(k in o)){o[k]=st.displayValue;keys.push(k);}}});return {o:o,keys:keys};}
  if(bt.length===2&&out.game){
    var a=bt.filter(function(t){return t.homeAway==="away"||(t.team&&t.team.id===out.game.away.id);})[0]||bt[0];
    var h=bt[0]===a?bt[1]:bt[0]; var fa=flat(a),fh=flat(h);
    out.stats=fa.keys.slice(0,20).map(function(k){return [k,fa.o[k],fh.o[k]!=null?fh.o[k]:""];});
  }
  var L=[];
  (s.leaders||[]).forEach(function(tl){var ab=(tl.team&&tl.team.abbreviation)||"";
    (tl.leaders||[]).slice(0,3).forEach(function(cat){var top=(cat.leaders||[])[0];
      if(top)L.push({tm:ab,cat:cat.displayName||"",who:(top.athlete&&(top.athlete.shortName||top.athlete.displayName))||"",v:top.displayValue||""});});});
  out.leaders=L;
  return out;
}

/* ---------- data loading ---------- */
function loadLeague(l){
  return api(l.path+"/scoreboard").then(function(j){
    Object.keys(games).forEach(function(id){if(games[id].lg===l.k)delete games[id];});
    (j.events||[]).forEach(function(e){try{var g=parseEvent(e,l.k);if(g)games[g.id]=g;}catch(x){}});
    leagueOK[l.k]=Date.now(); leagueErr[l.k]=null;
  },function(e){leagueErr[l.k]=String(e&&e.message||e);throw e;});
}
function refreshGrid(){
  var targets=LEAGUES;
  return Promise.all(targets.map(function(l){return loadLeague(l).then(function(){return 1;},function(){return 0;});})).then(function(r){
    var ok=r.reduce(function(a,b){return a+b;},0);
    if(ok>0){lastOk=Date.now();lastErr=ok<targets.length?"Some leagues failed to load":null;} else lastErr="Couldn't reach ESPN";
    if(view.name==="home")renderHome();
    tick();
  });
}
function refreshGame(){
  var id=view.gid, l=LG[view.glg]; if(!l)return Promise.resolve();
  var p1=api(l.path+"/summary",{event:id}).then(function(s){
    if(view.gid!==id)return; view.detail=parseSummary(s,l.k); view.detailErr=null; view.detailOk=Date.now(); lastOk=Date.now(); lastErr=null;
  },function(e){if(view.gid===id){view.detailErr=String(e&&e.message||e);lastErr="Couldn't reach ESPN";}});
  var p2=loadLeague(l).catch(function(){});
  return Promise.all([p1,p2]).then(function(){if(view.name==="game"&&view.gid===id)renderGame();tick();});
}
function schedule(){
  clearTimeout(timer);
  if(document.hidden)return;
  var ms=view.name==="game"?GAME_MS:GRID_MS;
  timer=setTimeout(function(){(view.name==="game"?refreshGame():refreshGrid()).then(schedule,schedule);},ms);
}
function refreshNow(){clearTimeout(timer);(view.name==="game"?refreshGame():refreshGrid()).then(schedule,schedule);}
document.addEventListener("visibilitychange",function(){if(!document.hidden)refreshNow();else clearTimeout(timer);});

function ago(ts){var s=Math.max(0,Math.round((Date.now()-ts)/1000));return s<60?s+"s ago":Math.floor(s/60)+"m ago";}
function tick(){
  var el=$("liveInd"),tx=$("liveTxt");
  var ts=view.name==="game"?(view.detailOk||lastOk):lastOk;
  if(!ts){el.className="live-ind"+(lastErr?" err":"");tx.textContent=lastErr?"Can't reach ESPN — retrying":"Connecting…";return;}
  var stale=Date.now()-ts>90000;
  if(lastErr&&stale){el.className="live-ind err";tx.textContent="Connection issue · last update "+ago(ts);}
  else{el.className="live-ind ok";tx.textContent="Live · updated "+ago(ts);}
}
setInterval(tick,1000);

/* ---------- ordering ---------- */
function ordKey(g){
  var now=Date.now(), t=Date.parse(g.ts)||0, ranked=(g.away.rank||g.home.rank||g.lg!=="cfb")?0:1;
  if(g.state==="in")return [0,ranked,t];
  if(g.state==="pre"&&t-now<3*3600e3)return [1,t,ranked];
  if(g.state==="post"&&now-t<14*3600e3)return [2,-t,ranked];
  if(g.state==="pre")return [3,t,ranked];
  return [4,-t,ranked];
}
function cmp(a,b){var x=ordKey(a),y=ordKey(b);for(var i=0;i<3;i++){if(x[i]!==y[i])return x[i]-y[i];}return 0;}
function pool(lg){return Object.keys(games).map(function(k){return games[k];}).filter(function(g){return lg==="all"||g.lg===lg;}).sort(cmp);}
function slotsFor(lg){
  var p=pool(lg), picks=load("gd_picks",{}), saved=(picks[lg]||[]).slice(0,6), used={}, out=[];
  for(var i=0;i<6;i++){var id=saved[i]; if(id&&games[id]&&(lg==="all"||games[id].lg===lg)&&!used[id]){out.push(id);used[id]=1;} else out.push(null);}
  var fill=p.filter(function(g){return !used[g.id];}).map(function(g){return g.id;});
  for(i=0;i<6;i++){if(!out[i]&&fill.length)out[i]=fill.shift();}
  return out.filter(Boolean);
}

/* ---------- rendering: home ---------- */
function badge(g){return g.state==="in"?'<span class="badge live">Live</span>':g.state==="post"?'<span class="badge">Final</span>':'<span class="badge pre">Upcoming</span>';}
function teamRow(t,g,lose,poss){
  return '<div class="team"><span class="bar" style="background:'+hex(t.color)+'"></span>'+
   (t.logo?'<img class="logo" loading="lazy" alt="" src="'+esc(t.logo)+'">':'')+
   '<span class="tname"><span class="ab">'+(t.rank?'<span class="rk">'+t.rank+'</span>':'')+esc(t.abbr)+(poss?'<span class="poss">●</span>':'')+'</span><span class="rec">'+esc(t.rec)+'</span></span>'+
   (g.state!=="pre"?'<span class="sc'+(lose?' lose':'')+'" data-k="'+g.id+t.abbr+'">'+esc(t.score)+'</span>':'')+'</div>';
}
function tile(g){
  var a=+g.away.score,h=+g.home.score, post=g.state==="post";
  var poss=g.sit&&g.sit.poss;
  var sub="";
  if(g.sit){ if(LG[g.lg].sport==="fb")sub=g.sit.dd||""; else if(g.lg==="mlb"&&g.sit.outs!=null)sub=g.sit.outs+" out"+(g.sit.outs===1?"":"s"); }
  return '<button class="tile'+(g.state==="in"?' live':'')+'" data-gid="'+g.id+'" data-lg="'+g.lg+'">'+
    '<div class="trow"><span class="meta">'+LG[g.lg].short+(g.net?' · '+esc(g.net):'')+'</span>'+badge(g)+'</div>'+
    teamRow(g.away,g,post&&a<h,poss&&poss===g.away.id)+teamRow(g.home,g,post&&h<a,poss&&poss===g.home.id)+
    '<div class="tfoot"><span class="st'+(g.state==="in"?' live':'')+'">'+esc(statusText(g))+'</span><span class="sit">'+esc(sub)+'</span></div></button>';
}
var homeShellLg=null;
function renderHome(){
  var app=$("app"), lg=view.league;
  var all=pool("all");
  if(lg!=="all"&&!all.some(function(g){return g.lg===lg;})&&Object.keys(leagueOK).length===LEAGUES.length){/* keep chosen league, show empty */}
  if(homeShellLg!==lg||!$("grid")){
    homeShellLg=lg;
    app.innerHTML='<div class="chips" id="chips"></div><div id="errs"></div><div class="grid" id="grid"></div><details class="edit" id="edit"><summary>Choose the six games</summary><div id="editBody"></div></details>';
  }
  var counts={all:all.length};LEAGUES.forEach(function(l){counts[l.k]=all.filter(function(g){return g.lg===l.k;}).length;});
  var chips=[{k:"all",label:"Top games"}].concat(LEAGUES).filter(function(c){return counts[c.k]>0||c.k===lg||c.k==="all";});
  $("chips").innerHTML=chips.map(function(c){return '<button class="chip'+(c.k===lg?' on':'')+'" data-lg="'+c.k+'">'+esc(c.label)+'<span class="n">'+counts[c.k]+'</span></button>';}).join("");
  var errs=LEAGUES.filter(function(l){return leagueErr[l.k];});
  $("errs").innerHTML=(!lastOk&&lastErr)?'<div class="err-box">Couldn’t load scores from ESPN. Retrying automatically every '+(GRID_MS/1000)+' seconds.</div>':
    (errs.length?'<div class="err-box">Couldn’t refresh: '+errs.map(function(l){return l.short;}).join(", ")+'. Showing the last scores we received; retrying.</div>':'');
  var ids=slotsFor(lg);
  if(!lastOk&&!ids.length){$("grid").innerHTML='<div class="loading" style="grid-column:1/-1">'+(lastErr?'No data yet.':'Loading live scores…')+'</div>';}
  else if(!ids.length){$("grid").innerHTML='<div class="empty" style="grid-column:1/-1">No '+esc(lg==="all"?"":(LG[lg]||{}).label||"")+' games on ESPN’s scoreboard right now.</div>';}
  else{
    $("grid").innerHTML=ids.map(function(id){return tile(games[id]);}).join("");
    // flash changed scores
    ids.forEach(function(id){var g=games[id];[g.away,g.home].forEach(function(t){var k=id+t.abbr;if(prevScores[k]!=null&&prevScores[k]!==t.score){var el=document.querySelector('[data-k="'+k+'"]');el&&el.closest(".tile").classList.add("flash");}prevScores[k]=t.score;});});
  }
  var ae=document.activeElement;
  if(!(ae&&ae.tagName==="SELECT"&&$("editBody").contains(ae))){
    var p=pool(lg), picks=load("gd_picks",{});
    $("editBody").innerHTML=ids.map(function(id,i){
      return '<label>Square '+(i+1)+'</label><select data-slot="'+i+'">'+p.map(function(g){
        var lab=LG[g.lg].short+" · "+g.away.abbr+(g.state!=="pre"?" "+g.away.score:"")+" at "+g.home.abbr+(g.state!=="pre"?" "+g.home.score:"")+" · "+statusText(g);
        return '<option value="'+g.id+'"'+(g.id===id?' selected':'')+'>'+esc(lab)+'</option>';}).join("")+'</select>';
    }).join("")+'<div class="row"><span>Your picks are saved on this device. Default: live games first, then games starting soon, then recent finals.</span>'+(picks[lg]?'<button class="btn" id="resetPicks">Reset</button>':'')+'</div>';
  }
}

/* ---------- rendering: game ---------- */
function fieldSVG(drive,off,def){
  if(!drive||drive.ytE==null||!off||!def)return "";
  var W=700,H=130,ez=56,x0=ez,x1=W-ez,top=30,bot=100,mid=(top+bot)/2;
  function X(yd){return x0+(x1-x0)*yd/100;}
  var ball=100-drive.ytE, start=drive.startYTE!=null?100-drive.startYTE:null;
  var m=/& (\d+)/.exec(drive.dd||""), toGo=m?+m[1]:null;
  var s='<svg class="field" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Ball on field">';
  s+='<rect x="'+x0+'" y="'+top+'" width="'+(x1-x0)+'" height="'+(bot-top)+'" fill="#1d5e34"/>';
  s+='<rect x="0" y="'+top+'" width="'+ez+'" height="'+(bot-top)+'" fill="'+hex(off.color)+'" opacity=".8"/><rect x="'+x1+'" y="'+top+'" width="'+ez+'" height="'+(bot-top)+'" fill="'+hex(def.color)+'" opacity=".8"/>';
  s+='<text x="'+ez/2+'" y="'+(mid+5)+'" text-anchor="middle" font-size="15" font-weight="800" fill="#fff" transform="rotate(-90 '+ez/2+' '+mid+')">'+esc(off.abbr)+'</text>';
  s+='<text x="'+(x1+ez/2)+'" y="'+(mid+5)+'" text-anchor="middle" font-size="15" font-weight="800" fill="#fff" transform="rotate(90 '+(x1+ez/2)+' '+mid+')">'+esc(def.abbr)+'</text>';
  for(var yd=10;yd<100;yd+=10){s+='<line x1="'+X(yd)+'" x2="'+X(yd)+'" y1="'+top+'" y2="'+bot+'" stroke="rgba(255,255,255,.35)"/><text x="'+X(yd)+'" y="'+(bot+20)+'" text-anchor="middle" font-size="13" fill="#9a9aa6">'+(yd<=50?yd:100-yd)+'</text>';}
  if(start!=null&&drive.isCurrent)s+='<rect x="'+Math.min(X(start),X(ball))+'" y="'+(mid-6)+'" width="'+Math.abs(X(ball)-X(start))+'" height="12" rx="6" fill="#4da3ff" opacity=".85"/>';
  if(toGo&&ball+toGo<100)s+='<line x1="'+X(ball+toGo)+'" x2="'+X(ball+toGo)+'" y1="'+top+'" y2="'+bot+'" stroke="#ffd23f" stroke-width="4"/>';
  s+='<line x1="'+X(ball)+'" x2="'+X(ball)+'" y1="'+top+'" y2="'+bot+'" stroke="#4da3ff" stroke-width="3"/>';
  s+='<ellipse cx="'+X(ball)+'" cy="'+mid+'" rx="11" ry="7" fill="#8b4513" stroke="#fff" stroke-width="2"/>';
  s+='<text x="'+X(ball)+'" y="'+(top-9)+'" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">'+esc(drive.possText||"")+'</text>';
  return s+'</svg>';
}
function basesSVG(s){
  function b(x,y,on){return '<rect x="'+(x-9)+'" y="'+(y-9)+'" width="18" height="18" transform="rotate(45 '+x+' '+y+')" fill="'+(on?'#ffd23f':'none')+'" stroke="#9a9aa6" stroke-width="2"/>';}
  return '<svg class="bases" viewBox="0 0 70 56">'+b(35,14,s.on2)+b(56,34,s.on1)+b(14,34,s.on3)+'</svg>';
}
function playList(list,lg,n){
  if(!list||!list.length)return '<div class="empty">No plays yet.</div>';
  return '<ul class="plays">'+list.slice(0,n).map(function(p){
    var meta=[p.tm,p.dd].filter(Boolean).join(" · ");
    return '<li class="'+(p.sc?'score':'')+'"><span class="t">'+esc((p.p?periodLabel(lg,p.p)+" ":"")+(lg==="mlb"?"":p.c))+'</span><span class="x">'+esc(stripClock(p.x))+(meta?'<small>'+esc(meta)+'</small>':'')+'</span>'+
      (p.sc?(p.a!=null?'<span class="s">'+p.a+'-'+p.h+'</span>':'<span class="pill">SCORE</span>'):'')+'</li>';}).join("")+'</ul>';
}
function renderGame(){
  var app=$("app"), d=view.detail, base=games[view.gid];
  var g=(d&&d.game)||base;
  var html='<div class="backbar"><button class="back" id="backBtn">‹ Back to scores</button></div>';
  if(!g){
    html+=view.detailErr?'<div class="err-box">Couldn’t load this game from ESPN ('+esc(view.detailErr)+'). Retrying every '+(GAME_MS/1000)+' seconds.</div>':'<div class="loading">Loading game…</div>';
    app.innerHTML=html;return;
  }
  if(base&&base.sit&&g!==base)g.sit=base.sit;
  if(base&&base.net&&!g.net)g.net=base.net;
  var l=LG[g.lg], isFb=l.sport==="fb", a=+g.away.score,h=+g.home.score, post=g.state==="post";
  document.title=g.away.abbr+" "+(g.state!=="pre"?g.away.score+"-"+g.home.score+" ":"vs ")+g.home.abbr+" · Game Day";
  function bt(t){return '<div class="bt">'+(t.logo?'<img alt="" src="'+esc(t.logo)+'">':'<span class="bar" style="width:40px;height:6px;min-height:6px;background:'+hex(t.color)+'"></span>')+'<div class="ab">'+(t.rank?'<span class="rk">'+t.rank+'</span>':'')+esc(t.abbr)+'</div><div class="rec">'+esc(t.name)+(t.rec?' · '+esc(t.rec):'')+'</div></div>';}
  html+='<div class="board"><span class="tbar" style="left:0;background:'+hex(g.away.color)+'"></span><span class="tbar" style="right:0;background:'+hex(g.home.color)+'"></span>';
  html+='<div class="lgline">'+l.short+(g.venue?' · '+esc(g.venue):'')+'</div><div class="bs">'+bt(g.away)+
    '<div class="bsc'+(post&&a<h?' lose':'')+'">'+(g.state!=="pre"?esc(g.away.score):'')+'</div>'+
    '<div class="mid">'+badge(g)+'<span class="clk">'+esc(statusText(g))+'</span>'+(g.net?'<span>'+esc(g.net)+'</span>':'')+'</div>'+
    '<div class="bsc'+(post&&h<a?' lose':'')+'">'+(g.state!=="pre"?esc(g.home.score):'')+'</div>'+bt(g.home)+'</div>';
  var np=Math.max(g.away.ls.length,g.home.ls.length,g.lg==="mlb"?9:g.lg==="nhl"?3:4);
  if(g.state!=="pre"){
    var cols=[];for(var i=1;i<=np;i++)cols.push(g.lg==="mlb"?i:periodLabel(g.lg,i).replace(/^[QP]/,""));
    html+='<div class="lswrap"><table class="ls"><tr><th></th>'+cols.map(function(c){return '<th>'+c+'</th>';}).join("")+'<th>T</th></tr>'+
      [g.away,g.home].map(function(t){var r='<tr><td>'+esc(t.abbr)+'</td>';for(var i=0;i<np;i++)r+='<td>'+esc(t.ls[i]!=null?t.ls[i]:"–")+'</td>';return r+'<td>'+esc(t.score)+'</td></tr>';}).join("")+'</table></div>';
  }
  html+='</div>';
  if(view.detailErr)html+='<div class="err-box">Live update failed ('+esc(view.detailErr)+'). Showing the last data received; retrying.</div>';
  var tabs=[["live",g.state==="in"?"Live":g.state==="post"?"Recap":"Preview"]];
  if(d&&((d.stats&&d.stats.length&&g.state!=="pre")||(d.leaders&&d.leaders.length)))tabs.push(["stats","Stats"]);
  if(d&&d.plays&&d.plays.length)tabs.push(["plays","Plays"]);
  if(d&&d.scoring&&d.scoring.length)tabs.push(["scoring","Scoring"]);
  var tab=tabs.some(function(t){return t[0]===view.tab;})?view.tab:"live";
  html+='<div class="tabs">'+tabs.map(function(t){return '<button class="tab'+(t[0]===tab?' on':'')+'" data-tab="'+t[0]+'">'+t[1]+'</button>';}).join("")+'</div>';
  if(!d&&!view.detailErr)html+='<div class="loading">Loading game details…</div>';
  if(tab==="live"){
    var dv=d&&d.drive;
    if(g.state==="in"&&isFb&&dv){
      var offIsAway=dv.tmId?dv.tmId===g.away.id:dv.tm===g.away.abbr, off=offIsAway?g.away:g.home, def=offIsAway?g.home:g.away;
      var ddt=dv.dd||(g.sit&&g.sit.dd)||"";
      html+='<div class="card"><h3>Current drive · '+esc(off.abbr)+'</h3><div class="dd">'+esc(ddt||(dv.n===0?"Change of possession":""))+(g.sit&&g.sit.red?' <span class="badge live">Red zone</span>':'')+'</div>'+
        '<div class="dmeta"><span><b>'+dv.n+'</b> plays</span><span><b>'+dv.yds+'</b> yds</span><span><b>'+esc(dv.time||"0:00")+'</b></span></div>'+fieldSVG(dv,off,def)+'</div>';
    }
    if(g.state==="in"&&g.lg==="mlb"&&g.sit){
      html+='<div class="card"><h3>At bat</h3><div style="display:flex;align-items:center;justify-content:space-between;gap:12px">'+
        '<div class="count"><span><b>'+(g.sit.balls!=null?g.sit.balls:0)+'-'+(g.sit.strikes!=null?g.sit.strikes:0)+'</b>Count</span><span><b>'+(g.sit.outs!=null?g.sit.outs:0)+'</b>Outs</span></div>'+basesSVG(g.sit)+'</div>'+
        ((g.sit.batter||g.sit.pitcher)?'<div class="dmeta" style="margin-top:8px">'+(g.sit.batter?'<span>Batter <b>'+esc(g.sit.batter)+'</b></span>':'')+(g.sit.pitcher?'<span>Pitcher <b>'+esc(g.sit.pitcher)+'</b></span>':'')+'</div>':'')+'</div>';
    }
    var last=(g.sit&&g.sit.last)||(d&&d.plays&&d.plays[0]&&g.state==="in"?d.plays[0].x:"");
    if(g.state==="in"&&last)html+='<div class="card"><h3>Last play</h3><div class="lastplay">'+esc(stripClock(last))+'</div></div>';
    if(d&&d.plays&&d.plays.length&&g.state!=="pre")html+='<div class="card"><h3>'+(post?'Final plays':'Recent plays')+'</h3>'+playList(d.plays,g.lg,6)+'</div>';
    if(post&&d&&d.scoring&&d.scoring.length)html+='<div class="card"><h3>Scoring summary</h3>'+playList(d.scoring.slice(-8).reverse().map(function(s){s.sc=true;return s;}),g.lg,8)+'</div>';
    if(g.state==="pre"){
      html+='<div class="card"><h3>Game info</h3><dl class="kv"><dt>Start</dt><dd>'+esc(new Date(g.ts).toLocaleString([], {weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}))+'</dd>'+(g.venue?'<dt>Venue</dt><dd>'+esc(g.venue)+'</dd>':'')+(g.net?'<dt>TV</dt><dd>'+esc(g.net)+'</dd>':'')+'</dl></div>';
      if(d&&d.leaders&&d.leaders.length)html+=leadersCard(d.leaders,"Season leaders");
    }
  }
  if(tab==="stats"&&d){
    if(d.stats&&d.stats.length&&g.state!=="pre")html+='<div class="card"><h3>Team stats</h3><table class="stats"><tr><th>'+esc(g.away.abbr)+'</th><th></th><th>'+esc(g.home.abbr)+'</th></tr>'+d.stats.map(function(r){return '<tr><td>'+esc(r[1])+'</td><td>'+esc(r[0])+'</td><td>'+esc(r[2])+'</td></tr>';}).join("")+'</table></div>';
    if(d.leaders&&d.leaders.length)html+=leadersCard(d.leaders,g.state==="pre"?"Season leaders":"Game leaders");
  }
  if(tab==="plays"&&d)html+='<div class="card"><h3>Play by play · most recent first</h3>'+playList(d.plays,g.lg,25)+'</div>';
  if(tab==="scoring"&&d)html+='<div class="card"><h3>Scoring plays</h3>'+playList(d.scoring.map(function(s){s.sc=true;return s;}),g.lg,40)+'</div>';
  app.innerHTML=html;
}
function leadersCard(L,title){
  return '<div class="card"><h3>'+esc(title)+'</h3>'+L.map(function(x){return '<div class="ldr"><span class="c">'+esc(x.cat)+' · '+esc(x.tm)+'</span><span class="w">'+esc(x.who)+'</span><span></span><span class="v">'+esc(x.v)+'</span></div>';}).join("")+'</div>';
}

/* ---------- routing & events ---------- */
function route(){
  var m=/^#\/g\/(\w+)\/(\d+)/.exec(location.hash);
  if(m&&LG[m[1]]){
    var changed=view.gid!==m[2];
    view.name="game";view.glg=m[1];view.gid=m[2];
    if(changed){view.detail=null;view.detailErr=null;view.detailOk=0;view.tab="live";}
    homeShellLg=null; window.scrollTo(0,0); renderGame(); refreshNow();
  } else {
    var wasGame=view.name==="game";
    view.name="home";view.gid=null;view.detail=null;document.title="Game Day Scoreboard";homeShellLg=null;renderHome();
    if(wasGame){window.scrollTo(0,load("gd_scroll",0));}
    if(!lastOk||Date.now()-lastOk>GRID_MS)refreshNow();else schedule();
  }
  tick();
}
window.addEventListener("hashchange",route);
document.addEventListener("click",function(e){
  var t=e.target.closest("[data-gid]");
  if(t){save("gd_scroll",window.scrollY);fromHome=true;location.hash="#/g/"+t.getAttribute("data-lg")+"/"+t.getAttribute("data-gid");return;}
  t=e.target.closest(".chip");
  if(t){view.league=t.getAttribute("data-lg");save("gd_league",view.league);renderHome();return;}
  t=e.target.closest(".tab");
  if(t){view.tab=t.getAttribute("data-tab");renderGame();return;}
  if(e.target.closest("#backBtn")){if(fromHome&&history.length>1){fromHome=false;history.back();}else{location.hash="#/";}return;}
  if(e.target.closest("#resetPicks")){var p=load("gd_picks",{});delete p[view.league];save("gd_picks",p);homeShellLg=null;renderHome();return;}
  if(e.target.closest("#brand")){location.hash="#/";}
});
document.addEventListener("change",function(e){
  var s=e.target.closest("select[data-slot]"); if(!s)return;
  var lg=view.league, cur=slotsFor(lg), i=+s.getAttribute("data-slot"), v=s.value, j=cur.indexOf(v);
  if(j>=0&&j!==i)cur[j]=cur[i]; cur[i]=v;
  var p=load("gd_picks",{});p[lg]=cur;save("gd_picks",p);
  s.blur(); renderHome();
});
route();
})();
