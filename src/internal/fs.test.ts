import * as nodeFS from 'node:fs'

import { describe, test } from 'mocha'

import '../../test/helper'
import * as FS from './fs'


type FsFuncName = keyof typeof nodeFS
type FsPromisesFuncName = keyof typeof nodeFS.promises

describe('fs', () => {
  test('exports async functions from fs.promises', async () => {
    for (const name of Object.keys(nodeFS.promises) as FsPromisesFuncName[]) {
      assert(FS[name] === nodeFS.promises[name],
        'Expected to be a function from fs.promises.')
    }
  })

  test('exports sync functions from fs', () => {
    for (const name of Object.keys(nodeFS).filter(x => x.endsWith('Sync')) as FsFuncName[]) {
      assert(FS[name] === nodeFS[name],
        'Expected to be a function from fs module.')
    }
  })
})
