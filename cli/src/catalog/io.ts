export interface CatalogIo {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export function defaultCatalogIo(): CatalogIo {
  return {
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line)
  };
}
