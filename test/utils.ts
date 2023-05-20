import * as FS from 'node:fs'
import * as process from 'node:process'

import { AssertionError } from 'assert'
import waitForExpect from 'wait-for-expect'


export function isDirectory (path: string): boolean {
  return FS.existsSync(path) && FS.statSync(path).isDirectory()
}

export function isCloseTo (a: number, b: number, delta: number): boolean {
  return (a - delta) < b && b < (a + delta)
}

export function isFile (path: string): boolean {
  return FS.existsSync(path) && FS.statSync(path).isFile()
}

export function processExists (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function retryUntilTimeout (
  msec: number,
  fn: () => void | Promise<void>,
  onErrorAfterTimeout?: (err: AssertionError) => void,
): Promise<{}> {
  try {
    return await waitForExpect(fn, msec)
  } catch (err) {
    if (onErrorAfterTimeout && err instanceof AssertionError) {
      onErrorAfterTimeout(err)
      return {}
    }
    throw err
  }
}

export function stripBlankLines (text: string): string {
  return text.replace(/^\s*\n/gm, '')
}
