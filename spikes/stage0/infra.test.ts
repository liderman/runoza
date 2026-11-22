import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';import {Kysely,PostgresDialect,sql} from 'kysely';import {PgBoss} from 'pg-boss';
import {S3Client,CreateBucketCommand,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand,DeleteBucketCommand,CreateMultipartUploadCommand,AbortMultipartUploadCommand,ListMultipartUploadsCommand} from '@aws-sdk/client-s3';import {Upload} from '@aws-sdk/lib-storage';
const url=process.env.STAGE0_DATABASE_URL;
test('PostgreSQL + Kysely + pg-boss: rollback, deduplication, retry, independent consumers and restart',{skip:!url},async()=>{
 const pool=new Pool({connectionString:url});const db=new Kysely({dialect:new PostgresDialect({pool})});const schema='spike_'+randomUUID().replaceAll('-','');const boss=new PgBoss({connectionString:url!,schema});boss.on('error',console.error);await boss.start();
 try{
 assert.equal((await sql<{value:number}>`select 42::int as value`.execute(db)).rows[0].value,42);
 await assert.rejects(db.transaction().execute(async trx=>{await sql`create table rollback_probe(id int)`.execute(trx);throw Error('rollback')}));
 assert.equal((await sql<{name:string|null}>`select to_regclass('rollback_probe')::text as name`.execute(db)).rows[0].name,null);
 await boss.createQueue('probe',{retryLimit:2,retryDelay:0});
 const id=await boss.send('probe',{value:42},{singletonKey:'same',singletonSeconds:60});assert.ok(id);assert.equal(await boss.send('probe',{value:42},{singletonKey:'same',singletonSeconds:60}),null);
 const [a,b]=await Promise.all([boss.fetch('probe'),boss.fetch('probe')]);assert.equal(a.length+b.length,1);
 await boss.fail('probe',id!);const retry=await boss.fetch('probe');assert.equal(retry[0]?.id,id);await boss.complete('probe',id!);
 const durable=await boss.send('probe',{durable:true});await boss.stop();
 const restarted=new PgBoss({connectionString:url!,schema});restarted.on('error',console.error);await restarted.start();try{const jobs=await restarted.fetch('probe');assert.equal(jobs[0]?.id,durable);await restarted.complete('probe',durable!)}finally{await restarted.stop()}
 }finally{await boss.stop();await sql.raw('drop schema "'+schema+'" cascade').execute(db);await db.destroy()}
});
const endpoint=process.env.STAGE0_S3_ENDPOINT;
test('S3 SDK + RustFS: CRUD, Range, multipart completion and abort',{skip:!endpoint},async()=>{
 const client=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'runoza-stage0',secretAccessKey:'stage0-local-test-secret'}});const Bucket='spike-'+randomUUID();await client.send(new CreateBucketCommand({Bucket}));
 try{
 await client.send(new PutObjectCommand({Bucket,Key:'hello',Body:'hello runoza'}));assert.equal((await client.send(new HeadObjectCommand({Bucket,Key:'hello'}))).ContentLength,12);
 assert.equal(await (await client.send(new GetObjectCommand({Bucket,Key:'hello',Range:'bytes=0-4'}))).Body!.transformToString(),'hello');
 const bytes=Buffer.alloc(6*1024*1024,65);await new Upload({client,params:{Bucket,Key:'large',Body:bytes},partSize:5*1024*1024}).done();assert.equal((await client.send(new HeadObjectCommand({Bucket,Key:'large'}))).ContentLength,bytes.length);
 const pending=await client.send(new CreateMultipartUploadCommand({Bucket,Key:'unfinished'}));await client.send(new AbortMultipartUploadCommand({Bucket,Key:'unfinished',UploadId:pending.UploadId}));assert.equal((await client.send(new ListMultipartUploadsCommand({Bucket}))).Uploads?.length??0,0);
 }finally{for(const Key of ['hello','large'])await client.send(new DeleteObjectCommand({Bucket,Key}));await client.send(new DeleteBucketCommand({Bucket}));client.destroy()}
});
