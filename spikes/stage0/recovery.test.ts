import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import {once} from 'node:events';import {setTimeout as delay} from 'node:timers/promises';import {PgBoss} from 'pg-boss';import {Pool} from 'pg';
const url=process.env.STAGE0_DATABASE_URL;
test('SIGKILL worker: expired claim is retried; transactional outbox rollback and replay dedupe',{skip:!url,timeout:45000},async()=>{
 const schema='recovery_'+randomUUID().replaceAll('-','');const pool=new Pool({connectionString:url});const boss=new PgBoss({connectionString:url!,schema});boss.on('error',console.error);await boss.start();
 try{
 await boss.createQueue('crash',{expireInSeconds:1,retryLimit:2,retryDelay:0});const id=await boss.send('crash',{});
 const child=spawn(process.execPath,['--import','tsx','spikes/stage0/crash-worker.ts'],{env:{...process.env,STAGE0_SCHEMA:schema},stdio:['ignore','pipe','pipe']});
 try{const claimed=await Promise.race([once(child.stdout,'data'),delay(10000).then(()=>{throw Error('claim timeout')})]);assert.equal(JSON.parse(String(claimed[0])).claimed,id);const exited=once(child,'exit');child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL')}finally{child.kill('SIGKILL')}
 await delay(1500);let recovered=false;
 for(let i=0;i<10;i++){await boss.supervise('crash');const jobs=await boss.fetch('crash');if(jobs.length){assert.equal(jobs[0].id,id);await boss.complete('crash',id!);recovered=true;break}await delay(500)}assert.ok(recovered,'claim recovered after actual process kill');
 await pool.query(`CREATE TABLE ${schema}.domain_event(id uuid primary key); CREATE TABLE ${schema}.outbox(id uuid primary key references ${schema}.domain_event(id), delivered boolean not null default false)`);
 const c=await pool.connect();const rollbackId=randomUUID();
 try{await c.query('BEGIN');await c.query(`INSERT INTO ${schema}.domain_event VALUES($1)`,[rollbackId]);await c.query(`INSERT INTO ${schema}.outbox(id) VALUES($1)`,[rollbackId]);await c.query('ROLLBACK')}finally{c.release()}
 assert.equal((await pool.query(`SELECT count(*)::int n FROM ${schema}.outbox`)).rows[0].n,0);
 const eventId=randomUUID();await pool.query(`WITH event AS (INSERT INTO ${schema}.domain_event VALUES($1) RETURNING id) INSERT INTO ${schema}.outbox(id) SELECT id FROM event`,[eventId]);
 await boss.createQueue('outbox');const dispatch=()=>boss.send('outbox',{eventId},{singletonKey:eventId,singletonSeconds:60});
 assert.ok(await dispatch()); // Simulated dispatcher failure before marking delivered.
 assert.equal(await dispatch(),null);await pool.query(`UPDATE ${schema}.outbox SET delivered=true WHERE id=$1`,[eventId]);
 assert.equal((await boss.fetch('outbox',{batchSize:10})).length,1);
 }finally{await boss.stop();await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}
});
