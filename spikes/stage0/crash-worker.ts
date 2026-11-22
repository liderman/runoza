import {PgBoss} from 'pg-boss';
const boss=new PgBoss({connectionString:process.env.STAGE0_DATABASE_URL!,schema:process.env.STAGE0_SCHEMA!});
boss.on('error',()=>process.exit(2));await boss.start();
const jobs=await boss.fetch('crash');if(!jobs.length)process.exit(3);
process.stdout.write(JSON.stringify({claimed:jobs[0].id})+'\n');
setInterval(()=>{},1000);
