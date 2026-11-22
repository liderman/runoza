import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {dictionaries,translator} from './locales';
import {Agent} from '@earendil-works/pi-agent-core';
import {normalizeContext,type Model} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
test('EN/RU keys and per-instance locale isolation',()=>{
 assert.deepEqual(Object.keys(dictionaries.en).sort(),Object.keys(dictionaries.ru).sort());
 const en=translator('en'),ru=translator('ru');assert.equal(en('empty'),'Clear');assert.equal(ru('empty'),'Очистить');assert.equal(en('empty'),'Clear');
});
test('Fastify + Pi agent streams from an OpenAI-compatible fixture without tools',async()=>{
 const server=Fastify();let calls=0;
 server.post('/v1/chat/completions',async(req,reply)=>{
  calls++;const body=req.body as {stream:boolean;tools?:unknown[]};assert.equal(body.stream,true);assert.ok(!body.tools?.length);
  reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream'});
  for(const delta of [{role:'assistant',content:''},{content:'Привет '},{content:'Runoza'}])reply.raw.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  reply.raw.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');reply.raw.end('data: [DONE]\n\n');
 });
 const base=await server.listen({port:0,host:'127.0.0.1'});
 try{
 const model:Model<'openai-completions'>={id:'fixture',name:'fixture',api:'openai-completions',provider:'fixture',baseUrl:base+'/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:128};
 const agent=new Agent({initialState:{model},streamFn:(m,c,o)=>streamSimple(m as Model<'openai-completions'>,normalizeContext(c),{...o,apiKey:'fixture-only'})});
 let text='';agent.subscribe(e=>{if(e.type==='message_update'&&e.assistantMessageEvent.type==='text_delta')text+=e.assistantMessageEvent.delta});
 await agent.prompt('Say hello');assert.equal(text,'Привет Runoza');assert.equal(calls,1);
 }finally{await server.close()}
});
