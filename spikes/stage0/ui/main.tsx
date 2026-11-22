import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Provider,Button,Flex,Text,Alert} from '@gravity-ui/uikit';
import {ChatContainer,ToolMessage,type TChatMessage,type ChatStatus} from '@gravity-ui/aikit';
import '@gravity-ui/uikit/styles/fonts.css';
import '@gravity-ui/uikit/styles/styles.css';
import '@gravity-ui/aikit/themes/common';
import '@gravity-ui/aikit/themes/light';
import '@gravity-ui/aikit/themes/dark';
import {translator,type Locale} from '../locales';
import './style.css';
document.addEventListener('securitypolicyviolation',()=>{document.documentElement.dataset.cspViolations=String(Number(document.documentElement.dataset.cspViolations||0)+1)});
function App(){
 const [lang,setLang]=useState<Locale>('en');const [theme,setTheme]=useState<'light'|'dark'>('light');
 const [messages,setMessages]=useState<TChatMessage[]>([]);const [status,setStatus]=useState<ChatStatus>('ready');
 const [toolStatus,setToolStatus]=useState<'waitingConfirmation'|'success'|'cancelled'>('waitingConfirmation');
 const timer=useRef<ReturnType<typeof setInterval>|undefined>(undefined);const t=translator(lang);
 useEffect(()=>{document.documentElement.lang=lang},[lang]);useEffect(()=>()=>clearInterval(timer.current),[]);
 function reset(){clearInterval(timer.current);setStatus('ready');setMessages([])}
 function stream(){clearInterval(timer.current);const text=t('answer');let count=0;setStatus('streaming');
 setMessages([{role:'user',content:'Hello / Привет'},{role:'assistant',content:''}]);
 timer.current=setInterval(()=>{count+=4;setMessages([{role:'user',content:'Hello / Привет'},{role:'assistant',content:text.slice(0,count)}]);if(count>=text.length){clearInterval(timer.current);setStatus('ready')}},30)}
 return <Provider theme={theme} lang={lang}><main><Flex gap="2" wrap="wrap" alignItems="center">
 <Text variant="header-1">{t('title')}</Text><Button onClick={()=>setLang(lang==='en'?'ru':'en')}>EN / RU</Button>
 <Button onClick={()=>setTheme(theme==='light'?'dark':'light')}>{t('theme')}</Button>
 <Button onClick={stream}>{t('stream')}</Button><Button onClick={()=>{reset();setMessages(Array.from({length:500},(_,i)=>({id:String(i),role:i%2?'assistant':'user',content:`${i}: ${t('answer')}`})))}}>{t('long')}</Button>
 <Button onClick={reset}>{t('empty')}</Button><Button onClick={()=>{clearInterval(timer.current);setStatus('error')}}>{t('error')}</Button>
 <Button onClick={()=>{reset();setMessages([{role:'assistant',content:`Safe **markdown**\n\n<img src=x onerror="document.documentElement.dataset.injected='yes'">\n\n<script>document.documentElement.dataset.injected='yes'</script>\n\n[unsafe](javascript:alert(1))\n\n{(()=>{document.documentElement.dataset.injected='yes';return 'executed'})()}` }])}}>{lang==='en'?'Untrusted Markdown':'Недоверенный Markdown'}</Button>
 </Flex><ToolMessage toolName="add" status={toolStatus} bodyContent="2 + 3 = 5" initialExpanded onAccept={()=>setToolStatus('success')} onReject={()=>setToolStatus('cancelled')}/>{status==='error'&&<Alert theme="danger" message={t('failed')}/>}
 <section className="chat"><ChatContainer messages={messages} messageListConfig={{virtualized:true}} status={status} onSendMessage={async()=>stream()}/></section></main></Provider>
}
createRoot(document.getElementById('root')!).render(<App/>);
