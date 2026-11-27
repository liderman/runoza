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
// Both text writes and resource installation lock the opened workspace directory.
// This serializes cooperating Runóza writers, not arbitrary external editors.
export function atomicWriteScript() {
  return String.raw`import os,hashlib,stat,fcntl,uuid
committed=False;commit_started=False
def atomic_write(root,parts,data,expected,append=False,max_size=1048576):
 global committed,commit_started
 fcntl.flock(root,fcntl.LOCK_EX)
 fd=os.dup(root);stage=None
 try:
  for part in parts[:-1]:
   n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=n
  def current():
   if expected is None:
    try: os.stat(parts[-1],dir_fd=fd,follow_symlinks=False)
    except FileNotFoundError: return b'',0o600,None
    raise ValueError('FILE_CONFLICT')
   f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
   try:
    info=os.fstat(f);assert stat.S_ISREG(info.st_mode) and info.st_size<=max_size,'FILE_SIZE'
    old=bytearray()
    while len(old)<=max_size:
     chunk=os.read(f,min(65536,max_size+1-len(old)))
     if not chunk: break
     old.extend(chunk)
    assert len(old)<=max_size,'FILE_SIZE'
    assert hashlib.sha256(old).hexdigest()==expected,'FILE_CONFLICT'
    return old,stat.S_IMODE(info.st_mode),(info.st_dev,info.st_ino,info.st_mtime_ns,info.st_size,info.st_mode)
   finally: os.close(f)
  old,mode,revision=current()
  data=(old if append else b'')+data;assert len(data)<=max_size,'FILE_SIZE'
  stage='.runoza-write-'+str(uuid.uuid4())
  f=os.open(stage,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
  try:
   offset=0
   while offset<len(data): offset+=os.write(f,data[offset:])
   os.fchmod(f,mode);os.fsync(f)
  finally: os.close(f)
  assert current()[2]==revision,'FILE_CONFLICT'
  # Recheck the opened directory chain before committing. Descriptor-relative
  # operations never follow a substituted symlink; external writers remain outside the lock.
  check=os.dup(root)
  try:
   for part in parts[:-1]:
    n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=check);os.close(check);check=n
   actual=os.fstat(check);original=os.fstat(fd)
   assert (actual.st_dev,actual.st_ino)==(original.st_dev,original.st_ino),'FILE_CONFLICT'
  finally: os.close(check)
  commit_started=True
  if expected is None:
   try: os.link(stage,parts[-1],src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
   except FileExistsError:
    commit_started=False
    raise
  else: os.replace(stage,parts[-1],src_dir_fd=fd,dst_dir_fd=fd)
  committed=True
 finally:
  if stage:
   try: os.unlink(stage,dir_fd=fd)
   except OSError: pass
  os.close(fd);fcntl.flock(root,fcntl.LOCK_UN)
`;
}
const script =
  atomicWriteScript() +
  String.raw`
import sys,json,base64
p=json.loads(base64.b64decode(sys.argv[1]));op=p['op'];parts=p['path'].split('/') if p['path'] else []
root=os.open(p['root'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fd=os.dup(root)
try:
 if op=='write':
  data=p['content'].encode('utf-8');assert len(data)<=60000,'FILE_SIZE'
  atomic_write(root,parts,data,p['expectedHash'],p.get('append',False));print('{}')
 else:
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
   f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
   try:
    info=os.fstat(f);assert stat.S_ISREG(info.st_mode) and info.st_size<=1048576,'FILE_SIZE'
    old=os.read(f,1048577);assert len(old)<=1048576,'FILE_SIZE'
    print(json.dumps(dict(base64=base64.b64encode(old).decode(),sha256=hashlib.sha256(old).hexdigest())))
   finally: os.close(f)
except BaseException:
 print('RUNOZA_FILE_OUTCOME_UNKNOWN' if committed or commit_started else 'RUNOZA_FILE_PRECOMMIT_FAILURE',file=sys.stderr)
 raise
finally: os.close(fd);os.close(root)
`;
export async function fileOperation<T>(
  executor: Executor,
  op: string,
  path: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  workspacePath(path, op === "list");
  const payload = Buffer.from(
    JSON.stringify({
      op,
      path,
      ...args,
      root: executor.workspaceRoot ?? "/tmp/workspace",
    }),
  ).toString("base64");
  const code = Buffer.from(script).toString("base64");
  const r = await executor.execute(
    `python3 -c 'import base64;exec(base64.b64decode("${code}"))' ${payload}`,
    signal,
    async () => {},
  );
  if (r.exitCode !== 0)
    throw new ExecutionError(
      r.output.includes("RUNOZA_FILE_OUTCOME_UNKNOWN") ||
      (op === "write" && !r.output.includes("RUNOZA_FILE_PRECOMMIT_FAILURE"))
        ? "EXECUTION_UNKNOWN"
        : r.output.includes("FILE_CONFLICT") ||
            r.output.includes("FileExistsError")
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
    throw new ExecutionError(
      op === "write" ? "EXECUTION_UNKNOWN" : "FILE_UNAVAILABLE",
    );
  }
}
