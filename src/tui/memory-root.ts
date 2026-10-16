import { createContext, useContext } from 'react';
import { posix, resolve, win32 } from 'path';
import { canonicalizePath, isOutside } from '../tools/path-utils.js';

/**
 * Where Book's project memory directory is, as far as a tool row needs to know to name a file in
 * it `memory/<file>`.
 *
 * The TUI is handed rows, not the tool context, so it cannot ask the file tools which of their
 * paths are memory files. A row that has a result carries the answer (`fileMutation.filePath`,
 * `presentation.target`); a row that is still running, or that failed, has only the path the model
 * wrote, and this is how that path is judged. It is a lexical judgement: nothing here touches the
 * file system, so it is safe to run for every row on every render. The one `realpath` happens when
 * the value is built ({@link resolveMemoryRootDisplay}).
 */
export interface MemoryRootDisplay {
  /**
   * The memory directory's spellings, absolute and normalised by `platform`'s `path` module: as
   * configured, and with its links followed when that is a different string. The model may write
   * either.
   */
  readonly roots: readonly string[];
  /** What a relative path argument resolves against. Without it only absolute paths are mapped. */
  readonly workspaceRoot?: string;
  /** Whose path rules judge the spellings: `win32` also folds case and reads `\` as a separator. */
  readonly platform: NodeJS.Platform;
}

function pathModule(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/** Build a {@link MemoryRootDisplay} from spellings that are already known. Touches no file. */
export function memoryRootDisplay(input: {
  roots: readonly string[];
  workspaceRoot?: string;
  platform?: NodeJS.Platform;
}): MemoryRootDisplay {
  const platform = input.platform ?? process.platform;
  const p = pathModule(platform);
  const roots = [
    ...new Set(input.roots.filter((root) => p.isAbsolute(root)).map((r) => p.resolve(r))),
  ];
  return {
    roots,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    platform,
  };
}

/**
 * The memory directory in both spellings the file tools accept, for the running platform. Calls
 * `realpath` once: build it once, not per render.
 */
export function resolveMemoryRootDisplay(dir: string, workspaceRoot?: string): MemoryRootDisplay {
  return memoryRootDisplay({ roots: [resolve(dir), canonicalizePath(dir)], workspaceRoot });
}

/**
 * `memory/<path below the directory, with />` when `argPath` names a file inside the memory
 * directory, otherwise `undefined` (the row keeps the path the model wrote).
 *
 * `argPath` is resolved lexically first, so `/mem/../x.md` is the file it reaches, not one inside
 * `/mem`. The directory itself is not a file target.
 */
export function memoryDisplayPath(memory: MemoryRootDisplay, argPath: string): string | undefined {
  const p = pathModule(memory.platform);
  let absolute: string;
  if (p.isAbsolute(argPath)) {
    absolute = p.resolve(argPath);
  } else if (memory.workspaceRoot && p.isAbsolute(memory.workspaceRoot)) {
    absolute = p.resolve(memory.workspaceRoot, argPath);
  } else {
    return undefined;
  }
  for (const root of memory.roots) {
    if (isOutside(root, absolute, p)) continue;
    const below = p.relative(root, absolute);
    if (below === '') return undefined;
    return `memory/${below.split(p.sep).join('/')}`;
  }
  return undefined;
}

/** The memory directory the transcript is drawn for; `undefined` when memory is off. */
export const MemoryRootContext = createContext<MemoryRootDisplay | undefined>(undefined);

export function useMemoryRoot(): MemoryRootDisplay | undefined {
  return useContext(MemoryRootContext);
}
