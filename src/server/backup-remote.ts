import { join } from "node:path";
import type {
  BackupRecord,
  BackupSettings,
} from "../shared/backup-management.ts";
import { backupProcess } from "./backup-process.ts";

export type RemoteTarget = Pick<
  BackupSettings,
  "remoteHost" | "remoteDirectory"
>;
export type BackupRemote = ReturnType<typeof backupRemote>;

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
// Fixed program, never interpolated Python or shell source from the settings.
const script = `import sys, os, pathlib, hashlib, uuid
op, directory, name, expected = sys.argv[1:]
root = pathlib.Path(directory)
root.mkdir(parents=True, exist_ok=True, mode=0o700)
root = root.resolve(strict=True)
p = root / name
if p.is_symlink() or (root / (name + '.partial')).is_symlink():
    raise RuntimeError('Symbolic links are not backup files')
if op == 'check':
    probe = root / ('.drevo-check-' + str(uuid.uuid4()))
    with probe.open('xb') as f: f.write(b'drevo')
    probe.unlink()
elif op == 'commit':
    part = root / (name + '.partial')
    with part.open('rb') as f: digest = hashlib.file_digest(f, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else None
    if digest is None:
        h = hashlib.sha256()
        with part.open('rb') as f:
            for block in iter(lambda: f.read(1048576), b''): h.update(block)
        digest = h.hexdigest()
    if digest != expected: raise RuntimeError('Checksum mismatch')
    os.chmod(part, 0o600)
    os.replace(part, p)
    checksum = root / (name + '.sha256')
    with checksum.open('w') as f: f.write(digest + '  ' + name + '\\n')
    os.chmod(checksum, 0o600)
elif op == 'delete':
    p.unlink(missing_ok=True)
    (root / (name + '.sha256')).unlink(missing_ok=True)
elif op == 'abort':
    (root / (name + '.partial')).unlink(missing_ok=True)
else:
    raise RuntimeError('Unknown operation')
`;

export function backupRemote(root: string) {
  const config = join(root, "backup-ssh", "config");
  const options = [
    "-F",
    config,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  async function run(
    target: RemoteTarget,
    op: string,
    name: string,
    hash: string,
    signal: AbortSignal,
  ) {
    await backupProcess(
      "ssh",
      [
        ...options,
        target.remoteHost,
        [
          "python3",
          "-c",
          quote(script),
          quote(op),
          quote(target.remoteDirectory),
          quote(name),
          quote(hash),
        ].join(" "),
      ],
      signal,
    );
  }
  return {
    config,
    async check(target: RemoteTarget, signal: AbortSignal) {
      await run(target, "check", ".connection-check", "", signal);
    },
    async upload(
      target: RemoteTarget,
      name: string,
      file: string,
      hash: string,
      signal: AbortSignal,
    ) {
      await run(target, "check", ".connection-check", "", signal);
      try {
        await backupProcess(
          "scp",
          [
            ...options,
            file,
            `${target.remoteHost}:${target.remoteDirectory}/${name}.partial`,
          ],
          signal,
        );
        await run(target, "commit", name, hash, signal);
      } catch (error) {
        if (!signal.aborted)
          await run(target, "abort", name, "", signal).catch(() => undefined);
        throw error;
      }
    },
    async download(
      record: BackupRecord,
      destination: string,
      signal: AbortSignal,
    ) {
      await backupProcess(
        "scp",
        [
          ...options,
          `${record.remoteHost}:${record.remoteDirectory}/${record.name}`,
          destination,
        ],
        signal,
      );
    },
    async remove(record: BackupRecord, signal: AbortSignal) {
      await run(record, "delete", record.name, "", signal);
    },
  };
}
