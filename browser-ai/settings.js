export const DEFAULT_BROWSER_SETTINGS=Object.freeze({visits:32,maxTimeMs:3000,batchSize:1,maxChildren:32,threads:1,backend:'wasm'});
export function browserSettings(input={}){
 const allowed=Object.keys(DEFAULT_BROWSER_SETTINGS);if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error('不支持的浏览器引擎参数');
 const s={...DEFAULT_BROWSER_SETTINGS,...Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined))};for(const [key,min,max] of [['visits',16,256],['maxTimeMs',100,20000],['batchSize',1,4],['maxChildren',8,64],['threads',1,4]])if(!Number.isSafeInteger(s[key])||s[key]<min||s[key]>max)throw new Error(`${key} 必须是 ${min}–${max} 的整数`);
 if(s.visits%16)throw new Error('visits 必须是 16 的倍数');if(![1,2,4].includes(s.threads))throw new Error('线程数请选择 1、2 或 4');if(!['wasm','webgpu','cpu'].includes(s.backend))throw new Error('计算后端不支持');if(s.backend!=='wasm'&&s.threads!==1)throw new Error('此线程选项只适用于 WASM');return s;
}
