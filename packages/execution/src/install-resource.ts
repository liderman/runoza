import { randomUUID, createHash } from "node:crypto";
import { atomicWriteScript, workspacePath } from "./files.ts";
import { ExecutionError, type Executor } from "./index.ts";
const script =
  atomicWriteScript() +
  String.raw`
import sys,json,base64
p=json.loads(base64.b64decode(sys.argv[1]));root=os.open(p['root'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
stage='.runoza-resource-'+p['transfer']
try:
 if p.get('cleanup'):
  try: os.unlink(stage,dir_fd=root)
  except FileNotFoundError: pass
 elif 'data' in p:
  data=base64.b64decode(p['data'],validate=True);flags=os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK
  flags|=os.O_CREAT|os.O_EXCL if p['offset']==0 else os.O_APPEND
  f=os.open(stage,flags,0o600,dir_fd=root)
  try:
   info=os.fstat(f);assert stat.S_ISREG(info.st_mode) and info.st_size==p['offset'] and info.st_size+len(data)<=10485760
   offset=0
   while offset<len(data): offset+=os.write(f,data[offset:])
  finally: os.close(f)
 else:
  f=os.open(stage,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=root)
  try:
   info=os.fstat(f);assert stat.S_ISREG(info.st_mode) and info.st_size==p['size'] and info.st_size<=10485760,'FILE_SIZE'
   data=bytearray()
   while len(data)<=10485760:
    chunk=os.read(f,min(65536,10485761-len(data)))
    if not chunk: break
    data.extend(chunk)
   assert len(data)==p['size'] and hashlib.sha256(data).hexdigest()==p['sha256'],'FILE_CONFLICT'
  finally: os.close(f)
  atomic_write(root,p['path'].split('/'),data,p['expectedHash'],max_size=10485760)
 print('RUNOZA_RESOURCE_OK')
except BaseException:
 print('RUNOZA_FILE_OUTCOME_UNKNOWN' if committed or commit_started else 'RUNOZA_FILE_PRECOMMIT_FAILURE',file=sys.stderr)
 raise
finally: os.close(root)
`;
export async function installResource(
  executor: Executor,
  path: string,
  bytes: Buffer,
  expectedHash: string | null,
  signal: AbortSignal,
  workspaceRoot = executor.workspaceRoot ?? "/tmp/workspace",
) {
  workspacePath(path);
  if (bytes.length > 10485760) throw new ExecutionError("FILE_SIZE");
  if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash))
    throw new ExecutionError("FILE_CONFLICT");
  if (executor.installBytes)
    return executor.installBytes(path, bytes, expectedHash, signal);
  const transfer = randomUUID(),
    code = Buffer.from(script).toString("base64");
  async function run(payload: Record<string, unknown>, requestSignal = signal) {
    const data = Buffer.from(
      JSON.stringify({ transfer, root: workspaceRoot, ...payload }),
    ).toString("base64");
    const result = await executor.execute(
      `python3 -c 'import base64;exec(base64.b64decode("${code}"))' ${data}`,
      requestSignal,
      async () => {},
    );
    if (result.exitCode !== 0 || !result.output.includes("RUNOZA_RESOURCE_OK"))
      throw new ExecutionError(
        result.output.includes("RUNOZA_FILE_OUTCOME_UNKNOWN") ||
        ("path" in payload &&
          result.exitCode !== 0 &&
          !result.output.includes("RUNOZA_FILE_PRECOMMIT_FAILURE")) ||
        (result.exitCode === 0 && !result.output.includes("RUNOZA_RESOURCE_OK"))
          ? "EXECUTION_UNKNOWN"
          : result.output.includes("FILE_CONFLICT") ||
              result.output.includes("FileExistsError")
            ? "FILE_CONFLICT"
            : "FILE_UNAVAILABLE",
      );
  }
  try {
    if (!bytes.length) await run({ data: "", offset: 0 });
    for (let offset = 0; offset < bytes.length; offset += 30000) {
      signal.throwIfAborted();
      await run({
        data: bytes.subarray(offset, offset + 30000).toString("base64"),
        offset,
      });
    }
    signal.throwIfAborted();
    await run({
      path,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      expectedHash,
    });
  } finally {
    await run({ cleanup: true }, AbortSignal.timeout(5000)).catch(() => {});
  }
}
