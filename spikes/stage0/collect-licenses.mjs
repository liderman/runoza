import {readFileSync,existsSync,writeFileSync} from 'node:fs';
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
const rows=[];
for(const path of Object.keys(lock.packages)){
 if(!path||!existsSync(`${path}/package.json`))continue;
 const p=JSON.parse(readFileSync(`${path}/package.json`,'utf8'));
 const item={name:p.name,version:p.version,license:p.license??'UNKNOWN',path};
 if(p.name==='@diplodoc/mdx-extension'&&!p.license&&readFileSync(`${path}/LICENSE`,'utf8').startsWith('MIT License')){
  item.license='MIT';item.evidence='installed LICENSE, package.json omits license';
 }
 rows.push(item);
}
writeFileSync('docs/research/stage0-licenses.json',JSON.stringify(rows,null,2)+'\n');
console.log(`Inventoried ${rows.length} installed packages; non-installed optional platforms excluded.`);
