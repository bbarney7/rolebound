import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export type FileIdentity = {
  dev: string;
  ino: string;
  birthtimeNs: string;
  mtimeNs: string;
  size: string;
};

type BigIntStat = {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  mtimeNs: bigint;
  size: bigint;
};

export function fileIdentity(stat: BigIntStat): FileIdentity {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    size: stat.size.toString(),
  };
}

export type FileStatTimes = { mtime: Date; ctime: Date };

export function statTimesFromDates(mtime: Date, ctime: Date): FileStatTimes {
  return { mtime, ctime };
}

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeNs === b.birthtimeNs &&
    a.mtimeNs === b.mtimeNs &&
    a.size === b.size
  );
}

export type MoveJobValidateResult =
  | { ok: true }
  | { ok: false; code: "BAD_URL" | "PARTIAL_CONFLICT"; message: string };

export type MoveJobFileResult =
  | { ok: true; raw: string; identity: FileIdentity }
  | { ok: false; code: "NOT_FOUND" | "EEXIST" | "PARTIAL_CONFLICT" | "BAD_URL"; message: string };

export type MoveJobFileTestHooks = {
  afterLink?: () => void | Promise<void>;
  beforeUnlink?: () => void | Promise<void>;
};

export async function moveJobFileNoClobber(
  src: string,
  dst: string,
  options: {
    validate?: (
      raw: string,
      identity: FileIdentity,
      stat: FileStatTimes,
    ) => Promise<MoveJobValidateResult> | MoveJobValidateResult;
    testHooks?: MoveJobFileTestHooks;
  } = {},
): Promise<MoveJobFileResult> {
  let rawContent: string;
  let srcId: FileIdentity;
  let srcStat: FileStatTimes;
  try {
    const handle = await fs.open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const st = await handle.stat({ bigint: true });
      const stDates = await handle.stat();
      srcId = fileIdentity(st);
      srcStat = statTimesFromDates(stDates.mtime, stDates.ctime);
      rawContent = await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { ok: false, code: "NOT_FOUND", message: `source not found: ${src}` };
    }
    if (err?.code === "ELOOP" || err?.code === "EISDIR" || err?.code === "ENOTDIR") {
      return {
        ok: false,
        code: "PARTIAL_CONFLICT",
        message: `${src} is not a regular file, so it was not moved. Nothing was changed.`,
      };
    }
    throw err;
  }

  if (options.validate) {
    const verdict = await options.validate(rawContent, srcId, srcStat);
    if (!verdict.ok) {
      return { ok: false, code: verdict.code, message: verdict.message };
    }
  }

  const destDir = path.dirname(dst);
  await fs.mkdir(destDir, { recursive: true });
  try {
    const dirStat = await fs.lstat(destDir);
    if (dirStat.isSymbolicLink()) {
      return {
        ok: false,
        code: "PARTIAL_CONFLICT",
        message: `destination directory ${destDir} must not be a symlink`,
      };
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  let dstSharesSrcInode = false;
  try {
    await fs.link(src, dst);
    dstSharesSrcInode = true;
    if (options.testHooks?.afterLink) await options.testHooks.afterLink();
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      return { ok: false, code: "EEXIST", message: `destination already exists: ${dst}` };
    }
    if (err?.code === "ENOENT") {
      return { ok: false, code: "NOT_FOUND", message: `source not found: ${src}` };
    }
    if (err?.code === "EXDEV" || err?.code === "EPERM" || err?.code === "ENOTSUP" || err?.code === "EMLINK" || err?.code === "ENOSYS") {
      try {
        await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL);
      } catch (copyErr: any) {
        if (copyErr?.code === "EEXIST") {
          return { ok: false, code: "EEXIST", message: `destination already exists: ${dst}` };
        }
        if (copyErr?.code === "ENOENT") {
          return { ok: false, code: "NOT_FOUND", message: `source not found: ${src}` };
        }
        if (copyErr?.code === "EISDIR" || copyErr?.code === "ENOTDIR") {
          return {
            ok: false,
            code: "PARTIAL_CONFLICT",
            message: `${src} stopped being a regular file while it was being copied, so it was not moved. Nothing was deleted.`,
          };
        }
        throw copyErr;
      }
    } else {
      throw err;
    }
  }

  if (dstSharesSrcInode) {
    let linkedId: FileIdentity | null = null;
    try {
      const dstStat = await fs.lstat(dst, { bigint: true });
      linkedId = fileIdentity(dstStat);
    } catch {
      linkedId = null;
    }
    if (linkedId === null || !sameFileIdentity(linkedId, srcId)) {
      return {
        ok: false,
        code: "PARTIAL_CONFLICT",
        message: `${src} changed while it was being moved, so ${dst} is not the file that was read and validated. Nothing was deleted.`,
      };
    }
  }

  {
    let stillOurs = false;
    try {
      const recheck = await fs.lstat(src, { bigint: true });
      stillOurs = sameFileIdentity(fileIdentity(recheck), srcId);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return { ok: true, raw: rawContent, identity: srcId };
      }
      throw err;
    }
    if (!stillOurs) {
      const how = dstSharesSrcInode ? "linked" : "copied";
      return {
        ok: false,
        code: "PARTIAL_CONFLICT",
        message: `file was ${how} into ${dst}, but ${src} is no longer the file that was read, so it was not removed. Both files now exist; neither was deleted.`,
      };
    }
  }

  if (options.testHooks?.beforeUnlink) await options.testHooks.beforeUnlink();

  try {
    await fs.unlink(src);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { ok: true, raw: rawContent, identity: srcId };
    }
    if (!dstSharesSrcInode) {
      return {
        ok: false,
        code: "PARTIAL_CONFLICT",
        message: `file was copied to ${dst} but ${src} could not be removed (${String(err)}). Both files now exist; neither was deleted.`,
      };
    }
    let dstId: FileIdentity | null = null;
    try {
      const dstStat = await fs.lstat(dst, { bigint: true });
      dstId = fileIdentity(dstStat);
    } catch {
      dstId = null;
    }
    if (dstId === null) {
      throw err;
    }
    if (sameFileIdentity(dstId, srcId)) {
      await fs.unlink(dst).catch(() => {});
      throw err;
    }
    return {
      ok: false,
      code: "PARTIAL_CONFLICT",
      message: `file was linked to ${dst}, but ${src} could not be removed (${String(err)}) and ${dst} is no longer the file we linked. Both files now exist; neither was deleted.`,
    };
  }

  return { ok: true, raw: rawContent, identity: srcId };
}
