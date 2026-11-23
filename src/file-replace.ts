import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Some Windows redirected/encrypted directories reject even same-directory rename.
export async function replaceFile(source: string, target: string): Promise<void> {
  try { await fs.rename(source, target); return; }
  catch (error: any) { if (error.code !== 'EXDEV') throw error; }
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) throw new Error('Replacement source must be a regular unlinked file');
  const backup = `${target}.${randomUUID()}.previous`;
  let hadTarget = false;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Replacement target must be a regular unlinked file');
    await fs.copyFile(target, backup, constants.COPYFILE_EXCL); hadTarget = true;
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  // ponytail: EXDEV fallback is not crash-atomic; keep the previous file until copy and fsync complete.
  try {
    await fs.copyFile(source, target, hadTarget ? 0 : constants.COPYFILE_EXCL);
    const handle = await fs.open(target, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (hadTarget) {
      try { await fs.copyFile(backup, target); await fs.unlink(backup); }
      catch (restoreError) { throw new AggregateError([error, restoreError], `Save failed; previous data retained at ${backup}`); }
    } else { await fs.unlink(target).catch(() => undefined); }
    throw error;
  }
  if (hadTarget) await fs.unlink(backup).catch(() => undefined);
  await fs.unlink(source).catch(() => undefined);
}
