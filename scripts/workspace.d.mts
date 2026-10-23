export const codeRoot: string;
export const WORKSPACE_VERSION: number;
export function sha256File(file: string): string;
export function resolveWorkspaceRoot(argv?: string[]): string;
export function initWorkspace(root: string): void;
export function createBackup(root: string, relativePaths: string[], id?: string): string;
export function restoreBackup(
  root: string,
  id: string,
  options?: { refuseIfActive?: boolean },
): { preRestoreId: string };
export function recoverMigration(root: string): boolean;
export function migrateWorkspace(
  root: string,
  relativePaths: string[],
  migration: () => void,
  name?: string,
): void;
export function activeRun(root: string): boolean;
export const DEFAULT_BACKUP_PATHS: string[];
export function resolveDefaultBackupPaths(root: string): string[];
export function listBackups(root: string): Array<{ id: string; date: string; fileCount: number }>;
export function runWorkspaceBackup(root: string): { id: string; fileCount: number };
