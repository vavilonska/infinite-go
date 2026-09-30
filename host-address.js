export function hostGameURL(address,port='8000'){
 const input=String(address).trim(),p=String(port).trim();
 if(!input||!/^\d{1,5}$/.test(p)||Number(p)<1||Number(p)>65535)throw new Error('请输入房主地址和 1–65535 端口');
 const explicit=/^https?:\/\//i.test(input);let host=input;
 if(!explicit&&host.includes(':')&&!host.startsWith('['))host='['+host+']';
 let url;try{url=new URL(explicit?host:'http://'+host);}catch{throw new Error('房主地址格式无效，请填 IP 或主机名，不含路径');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('只允许 HTTP / HTTPS 房主地址，不含账号、路径或查询参数');
 url.port=String(Number(p));return url.href;
}
