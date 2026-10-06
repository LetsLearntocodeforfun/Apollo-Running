/**
 * Files from a drag and drop, with dropped folders expanded — so an extracted
 * Strava or Garmin export, or a folder of FIT files, can be dropped as is.
 *
 * Files dropped individually are always kept (the import explains what it
 * can't use); from folders only importable files are taken
 * (`isImportableFileName`), so photos and other export clutter don't fill the
 * import summary.
 */

import { isImportableFileName } from './index';

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Every entry of a directory (`readEntries` hands them out in batches). */
async function directoryEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** Add the importable files of a folder and its subfolders to `out`; unreadable parts are skipped. */
async function collectFolder(dir: FileSystemDirectoryEntry, out: File[]): Promise<void> {
  let entries: FileSystemEntry[];
  try {
    entries = await directoryEntries(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory) {
      await collectFolder(entry as FileSystemDirectoryEntry, out);
    } else if (entry.isFile && isImportableFileName(entry.fullPath || entry.name)) {
      try {
        out.push(await entryFile(entry as FileSystemFileEntry));
      } catch {
        /* unreadable file: import the rest */
      }
    }
  }
}

/**
 * The files of a drop, folders expanded. Call it from the `drop` handler
 * itself: DataTransfer items can only be read during the event, so they are
 * captured before anything is awaited.
 */
export function filesFromDataTransfer(data: DataTransfer): Promise<File[]> {
  const picked: (File | FileSystemDirectoryEntry)[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      picked.push(entry as FileSystemDirectoryEntry);
    } else {
      const file = item.getAsFile();
      if (file) picked.push(file);
    }
  }
  if (picked.length === 0) return Promise.resolve(Array.from(data.files ?? []));
  return (async () => {
    const files: File[] = [];
    for (const p of picked) {
      if (p instanceof File) files.push(p);
      else await collectFolder(p, files);
    }
    return files;
  })();
}
