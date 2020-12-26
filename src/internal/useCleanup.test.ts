import { describe, test } from 'mocha'

import '../../test/helper'
import { useCleanup } from './useCleanup'


describe('useCleanup', () => {

  test('runs callbacks given to onCleanup() in reverse order after calling cleanup()', async () => {
    const [onCleanup, cleanup] = useCleanup()

    let pass = 0
    onCleanup(() => assert(pass++ === 4, 'Expected to be called last.'))
    onCleanup(async () => {
      assert(pass++ === 3, 'Expected to be called fourth.')
      throw Error('Error in callback #3')  // should be ignored
    })
    onCleanup(() => {
      assert(pass++ === 2, 'Expected to be called third.')
      throw Error('Error in callback #2')  // should be ignored
    })
    onCleanup(async () => assert(pass++ === 1, 'Expected to be called second.'))
    onCleanup(() => assert(pass++ === 0, 'Expected to be called first.'))
    assert(pass === 0, 'Expected no cleanup callbacks to be called yet.')

    assert(!process.listeners('exit').includes(cleanup),
      'Not expected the cleanup function to be registered in the process listeners.')

    await cleanup()
    assert(pass === 5, 'Expected all the cleanup callbacks to be called.')
  })

  describe('with option registerExitHook: true', () => {

    test('registers exit hook and unregisters after calling cleanup manually', async () => {
      const [, cleanup] = useCleanup({ registerExitHook: true })

      assert(process.listeners('exit').includes(cleanup),
        'Expected the cleanup function to be registered in the process listeners.')

      await cleanup()

      assert(!process.listeners('exit').includes(cleanup),
        'Expected the cleanup function to be unregistered after the cleanup is called manually.')
    })
  })
})
