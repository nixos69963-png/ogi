/**
 * Backups: the copy taken before a write, and the way back.
 *
 * Every tool that changes a file first drops the previous bytes in
 * <workspace>/.agent/backups/ and appends one line to the manifest. That is what
 * makes "undo" and "restore work after a crash" real statements rather than
 * promises: the copy is on disk before the new content is, and the manifest says
 * which file each copy belongs to.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BACKUP_DIR } from "./log.ts";
import { displayPath } from "./path_guard.ts";

export interface BackupEntry {
  id: string;
  at: number;
  /** Absolute path of the file this copy belongs to. */
  target: string;
  /** Absolute path of the stored copy. */
  file: string;
  bytes: number;
  reason: string;
}

const MANIFEST = "manifest.jsonl";

function dir(workspace: string): string {
  const target = path.join(workspace, BACKUP_DIR);
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  return target;
}

function manifestFile(workspace: string): string {
  return path.join(dir(workspace), MANIFEST);
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-48) || "file";
}

/** Copy the current bytes aside. Returns null when there was nothing to back up. */
export function snapshot(workspace: string, target: string, reason: string): BackupEntry | null {
  if (!existsSync(target)) return null;
  const at = Date.now();
  const id = `${at}-${slug(path.basename(target))}`;
  const file = path.join(dir(workspace), `${id}.copy`);
  copyFileSync(target, file);
  const entry: BackupEntry = { id, at, target, file, bytes: readFileSync(file).length, reason };
  try {
    appendFileSync(manifestFile(workspace), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* the copy exists; a missing manifest line only costs undo history */
  }
  return entry;
}

export function listBackups(workspace: string, limit = 25): BackupEntry[] {
  const file = manifestFile(workspace);
  if (!existsSync(file)) return [];
  const entries: BackupEntry[] = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      entries.push(JSON.parse(raw) as BackupEntry);
    } catch {
      /* skip a torn line */
    }
  }
  return entries.slice(-limit).reverse();
}

export function latestBackupFor(workspace: string, target: string): BackupEntry | null {
  return listBackups(workspace, 200).find((e) => path.resolve(e.target) === path.resolve(target)) ?? null;
}

export type RestoreResult =
  | { ok: true; entry: BackupEntry; message: string }
  | { ok: false; error: string };

/** Put the bytes back. The pre-restore state is itself snapshotted first. */
export function restore(workspace: string, idOrTarget: string): RestoreResult {
  const all = listBackups(workspace, 500);
  // A target may be given relative to the workspace; never resolve it against the shell's cwd.
  const wanted = path.resolve(workspace, idOrTarget);
  const entry = all.find((e) => e.id === idOrTarget) ?? all.find((e) => path.resolve(e.target) === wanted);
  if (!entry) {
    return { ok: false, error: `No backup for "${idOrTarget}". Run \`agent backups\` to list what can be restored.` };
  }
  if (!existsSync(entry.file)) return { ok: false, error: `The stored copy ${entry.file} is gone.` };
  snapshot(workspace, entry.target, `pre-undo ${entry.id}`);
  copyFileSync(entry.file, entry.target);
  return {
    ok: true,
    entry,
    message: `Restored ${displayPath(workspace, entry.target)} from ${entry.id} (${entry.bytes} bytes).`,
  };
}
