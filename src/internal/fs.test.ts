import nodeFS from 'fs'
import { describe, test } from 'mocha'

import '../../test/helper'
import * as FS from './fs'


describe('fs', () => {
  test('exports async functions from fs.promises', async () => {
    for (const name in nodeFS.promises) {
      assert(FS[name] === nodeFS.promises[name],
        'Expected to be a function from fs.promises.')
    }
  })

  test('exports sync functions from fs', () => {
    for (const name of Object.keys(nodeFS).filter(x => x.endsWith('Sync'))) {
      assert(FS[name] === nodeFS[name],
        'Expected to be a function from fs module.')
    }
  })
})
