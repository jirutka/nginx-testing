import OS from 'os'
import path from 'path'
import process from 'process'

import * as FS from './fs'


export function createTempDir (name: string): string {
  const nodeModules = findPkgNodeModules(process.cwd())

  const tempDir = nodeModules
    ? path.join(nodeModules, '.cache')
    : OS.tmpdir()

  if (nodeModules) {
    FS.mkdirSync(tempDir, { recursive: true })
  }
  return FS.mkdtempSync(path.join(tempDir, `${name}-`))
}

function findPkgNodeModules (cwd: string): string | null {
  let dir = path.resolve(cwd)
  const rootDir = path.parse(dir).root

  while (dir !== rootDir) {
    const nodeModules = path.join(dir, 'node_modules')
    if (isWritableDir(nodeModules)) {
      return nodeModules
    }
    dir = path.dirname(dir)
  }
  return null
}

function isWritableDir (path: string): boolean {
  try {
    if (!FS.statSync(path).isDirectory()) {
      return false
    }
    FS.accessSync(path, FS.constants.W_OK)
    return true
  } catch {
    return false
  }
}
