// Rejection sampling: each value 1..20 has exactly the same accepted byte count.
export function randomStoneCount(fill=bytes=>crypto.getRandomValues(bytes)){
 const bytes=new Uint8Array(1);do{fill(bytes);}while(bytes[0]>=240);return bytes[0]%20+1;
}
export function createNigiri(){return {phase:'guess',count:randomStoneCount(),guess:null,winner:null};}
export function revealNigiri(state,guess){
 if(state.phase!=='guess')throw new Error('猜先已经揭晓，不能重复猜');
 if(!['odd','even'].includes(guess))throw new Error('请选择单或双');
 const won=(state.count%2===1)===(guess==='odd');return {...state,phase:'choose',guess,winner:won?'B':'A'};
}
export function chooseNigiri(state,seat,color){
 if(state.phase!=='choose'||seat!==state.winner)throw new Error('只有猜先赢家可以选色');
 if(!['B','W'].includes(color))throw new Error('请选择黑或白');
 return {...state,phase:'ready',roles:{[seat]:color,[seat==='A'?'B':'A']:color==='B'?'W':'B'}};
}
export function publicNigiri(state){if(!state)return null;return state.phase==='guess'?{phase:'guess'}:{...state};}
