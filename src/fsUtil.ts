import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/** Writes via temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let fileMode = mode;
  if (fileMode === undefined) {
    try {
      fileMode = (await fs.stat(file)).mode & 0o777;
    } catch {
      fileMode = 0o600;
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode: fileMode });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
