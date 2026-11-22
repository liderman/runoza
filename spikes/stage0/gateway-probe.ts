import {Agent,type AgentTool} from '@earendil-works/pi-agent-core';import {normalizeContext,type Model} from '@earendil-works/pi-ai';import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';import {writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const model:Model<'openai-completions'>={id:'runoza-test',name:'Local LiteLLM',api:'openai-completions',provider:'litellm',baseUrl:'http://127.0.0.1:54009/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1047576,maxTokens:32768};
const results=[];
for(const mode of ['text','auto-tool','cancel']){
 let calls=0,tools=0,text='';const tool:AgentTool={name:'add',label:'Add',description:'Add two numbers',parameters:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b'],additionalProperties:false},execute:async(_id,args)=>{tools++;const x=args as {a:number;b:number};return {content:[{type:'text',text:String(x.a+x.b)}],details:{}}}};
 const agent=new Agent({initialState:{model,tools:mode==='auto-tool'?[tool]:[]},streamFn:(m,c,o)=>{if(calls>=2)throw Error('Probe request cap');calls++;return streamSimple(m as Model<'openai-completions'>,normalizeContext(c),{...o,apiKey:'stage0-gateway-only',maxTokens:256,signal:AbortSignal.any([AbortSignal.timeout(30000),...(o?.signal?[o.signal]:[])]),onPayload:async p=>{const payload={...p as object,parallel_tool_calls:false};assert.equal((payload as {max_completion_tokens?:number}).max_completion_tokens,256);return payload}})}});
 agent.subscribe(e=>{if(e.type==='message_update'&&e.assistantMessageEvent.type==='text_delta'){text+=e.assistantMessageEvent.delta;if(mode==='cancel')agent.abort()}});
 await agent.prompt(mode==='text'?'Reply exactly Runoza OK':mode==='auto-tool'?'Use the add tool to compute 2 plus 3. Then state the result.':'Count from 1 to 1000, one number on each line.');
 const last=agent.state.messages.at(-1);const stop=last?.role==='assistant'?last.stopReason:null;
 const success=mode==='cancel'?stop==='aborted':mode==='auto-tool'?tools===1&&Boolean(text)&&stop==='stop':text.includes('Runoza')&&stop==='stop';
 results.push({mode,success,requests:calls,toolCalls:tools,stopReason:stop,response:text.slice(0,200),error:last?.role==='assistant'?last.errorMessage:undefined});
}
await writeFile('docs/research/stage0-gateway.json',JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));assert.ok(results.every(r=>r.success));
