import * as FS from 'node:fs'
import { basename, dirname, join as joinPath } from 'node:path'

import { describe, test } from 'mocha'

import '../../test/helper'
import { isDirectory } from '../../test/utils'
import { createTempDir } from './tempDir'


// TODO: Add test case for OS.tmpdir() fallback.

describe('createTempDir', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir) {
      FS.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('creates temp directory inside ./node_modules/.cache/', () => {
    const name = 'nginx-testing-test'

    tempDir = createTempDir(name)

    assert(isDirectory(tempDir),
      'Expected to return path of a directory.')

    assert(joinPath(process.cwd(), 'node_modules', '.cache') === dirname(tempDir),
      'Expected the directory to be created inside ./node_modules/.cache')

    assert(basename(tempDir).startsWith(name),
      'Expected the created directory to contain the given name.')

    assert(basename(tempDir).length === name.length + 7,
      'Expected the created directory to contain 6 random characters (plus hyphen).')
  })
})
