// Pengganti src/folder-backup.ts HANYA di build demo (plugin `demoStubs` di vite.config.ts). Cadangan ke folder adalah fitur versi penuh.
import type { ProjectRecord, ProjectInfo } from '../project-store';
export type FolderState = {state: 'unsupported'} | {state: 'none'} | {state: 'ready' | 'need-permission'; name: string};
export type BackupResult = 'ok' | 'no-folder' | 'no-permission';
export const folderSupported = (): boolean => false;
export const folderState = (): Promise<FolderState> => Promise.resolve({state: 'unsupported'});
export const chooseFolder = (): Promise<string | null> => Promise.resolve(null);
export const regrantFolder = (): Promise<boolean> => Promise.resolve(false);
export const forgetFolder = (): Promise<void> => Promise.resolve();
export const backupToFolder = (_rec: ProjectRecord, _ask?: boolean): Promise<BackupResult> => Promise.resolve('no-folder');
export const listFolderProjects = (_ask?: boolean): Promise<ProjectInfo[] | null> => Promise.resolve(null);
export const loadFromFolder = (_name: string): Promise<ProjectRecord | null> => Promise.resolve(null);
