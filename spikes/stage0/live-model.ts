// Explicit live probe: never run as part of the default test suite.
import {readFile,writeFile} from 'node:fs/promises';
import {Agent,type AgentTool} from '@earendil-works/pi-agent-core';
import {normalizeContext,type Model} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
const env=await readFile('.env.stage0','utf8');
const key=env.split('\n').find(x=>x.startsWith('OPENROUTER_API_KEY='))?.slice('OPENROUTER_API_KEY='.length);
if(!key)throw Error('Missing local test credential');
const model:Model<'openai-completions'>={id:'openai/gpt-4.1-nano',name:'OpenRouter test',api:'openai-completions',provider:'openrouter',baseUrl:'https://openrouter.ai/api/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:256};
const results:unknown[]=[];
for(const useTool of [false,true]){
 let calls=0,invocations=0,text='';
 const tool:AgentTool={name:'add',label:'Add',description:'Add two numbers.',parameters:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b'],additionalProperties:false},execute:async(_id,args)=>{invocations++;const p=args as {a:number;b:number};return {content:[{type:'text',text:String(p.a+p.b)}],details:{}}}};
 const agent=new Agent({initialState:{model,tools:useTool?[tool]:[],systemPrompt:useTool?'You must call add to calculate the sum, then report the result.':'Answer briefly.'},streamFn:(m,c,o)=>{if(++calls>2)throw Error('Test request limit reached');return streamSimple(m as Model<'openai-completions'>,normalizeContext(c),{...o,apiKey:key,maxTokens:256,onPayload:(payload)=>{const body=payload as Record<string,unknown>; if(useTool){body.parallel_tool_calls=false;if(calls===1)body.tool_choice={type:'function',function:{name:'add'}};} return body;},signal:AbortSignal.timeout(30000)})}});
 agent.subscribe(e=>{if(e.type==='message_update'&&e.assistantMessageEvent.type==='text_delta')text+=e.assistantMessageEvent.delta});
 await agent.prompt(useTool?'Use add for 2 plus 3.':'Reply exactly: Runoza OK');
 const last=agent.state.messages.at(-1);const success=Boolean(text)&&(!useTool||invocations===1)&&last?.role==='assistant'&&last.stopReason!=='error';
 results.push({model:model.id,mode:useTool?'tool':'text',success,requests:calls,toolInvocations:invocations,response:text,stopReason:last?.role==='assistant'?last.stopReason:null,error:last?.role==='assistant'?last.errorMessage?.replaceAll(key,'[REDACTED]'):null});
 if(!success)break;
}
await writeFile('docs/research/stage0-live-model.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results));
if(results.length!==2||results.some(x=>!(x as {success:boolean}).success))process.exitCode=1;
