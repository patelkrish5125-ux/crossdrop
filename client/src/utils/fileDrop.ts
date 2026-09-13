// Recursive directory and file extraction for Drag-and-Drop
// Handles modern webkitGetAsEntry() and FileSystemEntry directory scanning recursively.

export async function extractDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const files: File[] = [];

  // Helper to traverse FileSystemEntry
  async function traverseEntry(entry: any, currentPath = ''): Promise<void> {
    if (!entry) return;

    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        entry.file(
          (file: File) => {
            const relativePath = currentPath ? `${currentPath}/${file.name}` : file.name;
            // Attach relativePath to file object
            Object.defineProperty(file, 'webkitRelativePath', {
              value: relativePath,
              writable: true,
              configurable: true,
            });
            files.push(file);
            resolve();
          },
          (err: any) => {
            console.warn('[DragDrop] Error reading file entry:', err);
            resolve();
          }
        );
      });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const readBatch = (): Promise<any[]> =>
        new Promise((resolve) => {
          dirReader.readEntries(
            (entries: any[]) => resolve(entries),
            () => resolve([])
          );
        });

      const dirPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      let batch: any[];
      do {
        batch = await readBatch();
        for (const child of batch) {
          await traverseEntry(child, dirPath);
        }
      } while (batch.length > 0);
    }
  }

  // Check if items and webkitGetAsEntry are supported
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const entries: any[] = [];
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i];
      if (typeof item.webkitGetAsEntry === 'function') {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }

    if (entries.length > 0) {
      for (const entry of entries) {
        await traverseEntry(entry);
      }
      if (files.length > 0) return files;
    }
  }

  // Fallback to standard files list
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return Array.from(dataTransfer.files);
  }

  return [];
}
