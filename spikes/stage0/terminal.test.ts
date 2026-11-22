import test from 'node:test';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
const a=process.env.STAGE0_TERMINAL_A,b=process.env.STAGE0_TERMINAL_B;const token='stage0-terminal-only';
async function api(base:string,path:string,method='GET',body?:unknown){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});assert.ok(r.ok,`${method} ${path}: ${r.status}`);return r.json() as Promise<any>}
test('Open Terminal: auth, PTY create/resize/IO/reconnect/delete, execute/cancel and container isolation',{skip:!a||!b,timeout:45000},async()=>{
 assert.equal((await fetch(a+'/api/terminals')).status,401);
 const t1=await api(a!,'/api/terminals','POST'),t2=await api(a!,'/api/terminals','POST');assert.notEqual(t1.id,t2.id);
 try{
 const ws=new WebSocket(a!.replace('http:','ws:')+'/api/terminals/'+t1.id);ws.binaryType='arraybuffer';let output='';
 ws.addEventListener('message',e=>{output+=typeof e.data==='string'?e.data:new TextDecoder().decode(e.data)});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WS open timeout')),5000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('WS error'))},{once:true})});
 try{ws.send(JSON.stringify({type:'auth',token}));ws.send(JSON.stringify({type:'resize',cols:101,rows:33}));ws.send(new TextEncoder().encode("stty size; printf 'PTY_%s\\n' OK\n"));
 for(let i=0;i<40&&!output.includes('33 101');i++)await delay(100);assert.match(output,/33 101/);assert.match(output,/PTY_OK/);
 }finally{ws.close()}
 await delay(200);
 const resumed=new WebSocket(a!.replace('http:','ws:')+'/api/terminals/'+t1.id);resumed.binaryType='arraybuffer';let replay='';
 resumed.addEventListener('message',e=>{replay+=typeof e.data==='string'?e.data:new TextDecoder().decode(e.data)});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('reconnect timeout')),5000);resumed.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true})});
 try{resumed.send(JSON.stringify({type:'auth',token}));resumed.send(new TextEncoder().encode("printf 'RE%s\\n' CONNECTED\n"));for(let i=0;i<40&&!replay.includes('RECONNECTED');i++)await delay(100);assert.match(replay,/RECONNECTED/)}finally{resumed.close()}
 const marker='runoza-'+randomUUID();const written=await api(a!,'/execute?wait=3','POST',{command:`printf isolated > /tmp/${marker}; id -u`});assert.equal(written.exit_code,0);assert.match(JSON.stringify(written),/1000/);
 const absent=await api(b!,'/execute?wait=3','POST',{command:`test ! -e /tmp/${marker}`});assert.equal(absent.exit_code,0);
 const shared=await api(a!,'/execute?wait=3','POST',{command:`test -e /tmp/${marker}`});assert.equal(shared.exit_code,0); // Isolation is per container, not PTY.
 const running=await api(a!,'/execute?wait=0','POST',{command:'sleep 60'});assert.equal(running.status,'running');await api(a!,'/execute/'+running.id+'?force=true','DELETE');const ended=await api(a!,'/execute/'+running.id+'/status');assert.equal(ended.status,'killed');
 await api(a!,'/execute?wait=3','POST',{command:`rm /tmp/${marker}`});
 }finally{for(const t of [t1,t2])await api(a!,'/api/terminals/'+t.id,'DELETE')}
 assert.equal((await fetch(a+'/api/terminals/'+t1.id,{headers:{Authorization:`Bearer ${token}`}})).status,404);
});

test('Open Terminal: environment recreation removes prior workspace files',{skip:!a,timeout:45000},async()=>{
 const marker='lease-'+randomUUID();await api(a!,'/execute?wait=3','POST',{command:`echo private > /tmp/${marker}`});
 execFileSync('docker',['compose','-p','runoza-stage0','-f','spikes/stage0/compose.yaml','--profile','terminal','up','-d','--force-recreate','terminal-a'],{stdio:'pipe'});
 let ready=false;for(let i=0;i<50;i++){try{const r=await api(a!,'/execute?wait=3','POST',{command:`test ! -e /tmp/${marker}`});assert.equal(r.exit_code,0);ready=true;break}catch{await delay(300)}}assert.ok(ready);
});
