// Use the API's configured connection for both bundled and external PostgreSQL.
// SQL travels over stdin; credentials never enter host process arguments or logs.
import { spawnSync } from "node:child_process";
export function poolQuery(
  statement,
  project = process.env.CODE_POOL_PROJECT ?? "runoza",
) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))
    throw Error("Invalid project");
  const code = `import pg from 'pg';
let sql='';for await(const chunk of process.stdin)sql+=chunk;
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
try{await db.connect();const result=await db.query(sql);for(const r of (Array.isArray(result)?result:[result]))for(const row of r.rows)console.log(Object.values(row).map(v=>v??'').join('|'));}
catch{process.exitCode=1;}finally{await db.end();}`;
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      project + "-api-1",
      "node",
      "--input-type=module",
      "-e",
      code,
    ],
    { input: statement, encoding: "utf8", timeout: 120000, maxBuffer: 2000000 },
  );
  if (result.status !== 0)
    throw Error("Pool database unavailable; check API database configuration");
  return result.stdout.trim();
}
