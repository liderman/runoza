import { ExecutionError, type Executor } from "./index.ts";
export interface WorkspaceEntry {
  name: string;
  kind: "file" | "directory" | "link" | "other";
  size: number;
}
export interface WorkspaceFile {
  content: string | null;
  base64: string;
  sha256: string;
}
export function workspacePath(path: string, root = false) {
  if (
    typeof path !== "string" ||
    path.length > 512 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    (!path && !root) ||
    path.split("/").some((p) => p === "." || p === ".." || (!p && path !== ""))
  )
    throw new ExecutionError("FILE_PATH");
  return path;
}
const script = String.raw`import os,sys,json,base64,hashlib,stat
p=json.loads(base64.b64decode(sys.argv[1]));op=p['op'];parts=p['path'].split('/') if p['path'] else []
fd=os.open('/tmp/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in (parts if op=='list' else parts[:-1]):
  n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=n
 if op=='list':
  items=[]
  for e in os.scandir(fd):
   if len(items)>=500:raise ValueError('FILE_LIST_LIMIT')
   s=e.stat(follow_symlinks=False);kind='link' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'other'
   items.append(dict(name=e.name,kind=kind,size=s.st_size))
  print(json.dumps(sorted(items,key=lambda e:(e['kind']!='directory',e['name']))))
 elif op=='mkdir':
  os.mkdir(parts[-1],0o700,dir_fd=fd);print('{}')
 else:
  if op=='write':
   data=p['content'].encode('utf-8');assert len(data)<=60000,'FILE_SIZE'
   expected=p['expectedHash'];flags=os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK
   if expected is None:flags|=os.O_CREAT|os.O_EXCL
  else:flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
  f=os.open(parts[-1],flags,0o600,dir_fd=fd)
  try:
   info=os.fstat(f);assert stat.S_ISREG(info.st_mode) and info.st_size<=1048576,'FILE_SIZE'
   old=os.read(f,1048577);assert len(old)<=1048576,'FILE_SIZE'
   sha=hashlib.sha256(old).hexdigest()
   if op=='read':
    try:content=old.decode('utf-8');content=None if '\0' in content else content
    except UnicodeDecodeError:content=None
    print(json.dumps(dict(base64=base64.b64encode(old).decode(),sha256=sha)))
   else:
    assert expected is None or expected==sha,'FILE_CONFLICT'
    data=(old if p.get('append',False) else b'')+data;assert len(data)<=1048576,'FILE_SIZE'
    os.lseek(f,0,0);offset=0
    while offset<len(data):offset+=os.write(f,data[offset:])
    os.ftruncate(f,len(data));print('{}')
  finally:os.close(f)
finally:os.close(fd)
`;
export async function fileOperation<T>(
  executor: Executor,
  op: string,
  path: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  workspacePath(path, op === "list");
  const payload = Buffer.from(JSON.stringify({ op, path, ...args })).toString(
    "base64",
  );
  const code = Buffer.from(script).toString("base64");
  const r = await executor.execute(
    `python3 -c 'import base64;exec(base64.b64decode("${code}"))' ${payload}`,
    signal,
    async () => {},
  );
  if (r.exitCode !== 0)
    throw new ExecutionError(
      r.output.includes("FILE_CONFLICT") || r.output.includes("FileExistsError")
        ? "FILE_CONFLICT"
        : r.output.includes("FILE_SIZE")
          ? "FILE_SIZE"
          : "FILE_UNAVAILABLE",
    );
  try {
    const value = JSON.parse(r.output);
    if (op === "read") {
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(value.base64, "base64"),
        );
        value.content = content.includes("\0") ? null : content;
      } catch {
        value.content = null;
      }
    }
    return value;
  } catch {
    throw new ExecutionError("FILE_UNAVAILABLE");
  }
}
