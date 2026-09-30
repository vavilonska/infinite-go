import {add,fraction,weightText} from './engine.js';
const NS='http://www.w3.org/2000/svg';
function svgEl(tag,attrs={}){const e=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;}
// A prefix trie, not a parent-ID graph: shared histories are actual junctions.
export function createTree(container,onSelect){
 const svg=svgEl('svg',{'aria-label':'可缩放时间线树',role:'img'}),scene=svgEl('g');svg.append(scene);container.append(svg);
 let x=30,y=40,z=1,folded=new Set(),lastGame;const pointers=new Map();let gesture,dragged=false;
 const transform=()=>scene.setAttribute('transform',`translate(${x},${y}) scale(${z})`);
 const center=()=>{const a=[...pointers.values()];return {x:a.reduce((s,p)=>s+p.x,0)/a.length,y:a.reduce((s,p)=>s+p.y,0)/a.length,d:a.length>1?Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y):0};};
 svg.addEventListener('pointerdown',e=>{const r=svg.getBoundingClientRect();pointers.set(e.pointerId,{x:e.clientX-r.left,y:e.clientY-r.top});gesture=center();dragged=false;if(e.target===svg)svg.setPointerCapture(e.pointerId);});
 svg.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;const r=svg.getBoundingClientRect();pointers.set(e.pointerId,{x:e.clientX-r.left,y:e.clientY-r.top});const c=center();if(Math.abs(c.x-gesture.x)+Math.abs(c.y-gesture.y)>2)dragged=true;if(c.d&&gesture.d){const next=Math.min(3,Math.max(.03,z*c.d/gesture.d));x=c.x-(gesture.x-x)*next/z;y=c.y-(gesture.y-y)*next/z;z=next;}else{x+=c.x-gesture.x;y+=c.y-gesture.y;}gesture=c;transform();});
 const end=e=>{pointers.delete(e.pointerId);if(pointers.size)gesture=center();setTimeout(()=>{dragged=false;},0);};svg.addEventListener('pointerup',end);svg.addEventListener('pointercancel',end);
 function zoom(f,cx=container.clientWidth/2,cy=container.clientHeight/2){const n=Math.min(3,Math.max(.03,z*f));x=cx-(cx-x)*n/z;y=cy-(cy-y)*n/z;z=n;transform();}
 svg.addEventListener('wheel',e=>{e.preventDefault();const r=svg.getBoundingClientRect();zoom(e.deltaY<0?1.12:1/1.12,e.clientX-r.left,e.clientY-r.top);},{passive:false});
 function render(game){lastGame=game;scene.replaceChildren();const root={key:'root',depth:0,ply:0,children:new Map(),lines:[],weight:fraction(0)};
  for(const l of game.lines){let n=root;n.weight=add(n.weight,l.weight);n.lines.push(l);for(let i=0;i<l.history.length;i++){const m=l.history[i],k=JSON.stringify(m);if(!n.children.has(k))n.children.set(k,{key:n.key+'/'+k,depth:i+1,ply:n.ply+(m.type==='resume'?0:1),children:new Map(),lines:[],weight:fraction(0)});n=n.children.get(k);n.weight=add(n.weight,l.weight);n.lines.push(l);}n.leaf=l;}
  function compress(n){while(n.children.size===1&&!n.leaf&&n!==root)n=[...n.children.values()][0];return {raw:n,children:folded.has(n.key)?[]:[...n.children.values()].map(compress)};}
  const r=compress(root),nodes=[],links=[];let row=0;
  function layout(n,level){n.x=n.raw.ply*175;if(!n.children.length)n.y=row++*92;else{n.children.forEach(c=>{layout(c,level+1);links.push([n,c]);});n.y=(n.children[0].y+n.children.at(-1).y)/2;}nodes.push(n);}layout(r,0);
  for(const[a,b]of links)scene.append(svgEl('path',{class:'link',d:`M${a.x+150},${a.y+30} C${a.x+170},${a.y+30} ${b.x-20},${b.y+30} ${b.x},${b.y+30}`}));
  for(const n of nodes){const raw=n.raw,l=raw.leaf,g=svgEl('g',{class:'node'+(l?' leaf':''),transform:`translate(${n.x},${n.y})`,tabindex:0,role:'button','aria-label':l?`时间线 ${l.id}`:`第 ${raw.ply} 手分叉节点`});g.append(svgEl('rect',{width:150,height:62,rx:10}));const title=svgEl('text',{x:12,y:23});title.textContent=l?`#${l.id} · ${l.status==='settled'?(l.archived?'认输归档':'已结算'):l.status==='scoring'?'待计分':'进行中'}`:raw.depth?`分叉节点 · ${raw.ply} 手`:'共同起点';const detail=svgEl('text',{x:12,y:44});detail.textContent=`${weightText(raw.weight)} · ${raw.ply} 手`;g.append(title,detail);
   const select=()=>onSelect(raw.lines[0].id,raw.depth);g.addEventListener('click',e=>{if(!dragged&&!e.target.classList.contains('fold'))select();});g.addEventListener('keydown',e=>{if(e.key==='Enter')select();});
   if(raw.children.size>1){const f=svgEl('circle',{cx:143,cy:5,r:11,class:'fold',tabindex:0,role:'button','aria-label':'折叠或展开分支'}),t=svgEl('text',{x:139,y:9,'pointer-events':'none'});t.textContent=folded.has(raw.key)?'+':'−';const toggle=e=>{e.stopPropagation();if(dragged)return;folded.has(raw.key)?folded.delete(raw.key):folded.add(raw.key);render(lastGame);};f.addEventListener('click',toggle);f.addEventListener('keydown',e=>{if(e.key==='Enter')toggle(e);});g.append(f,t);}scene.append(g);
  }transform();
 }
 return {render,zoom,reset(){x=30;y=40;z=1;transform();}};
}
