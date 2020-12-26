import { beforeEach, describe, test } from 'mocha'

import '../test/helper'
import { stripBlankLines } from '../test/utils'
import { parseConf, NginxConfEditor } from './nginxConf'


const confFixture = `
daemon on;
error_log stderr info;

events {
  worker_connections 512;
}

http {
  access_log access.log;

  server {
    listen 80;
    listen [::]:80;

    location / {
      root /var/www;
    }
  }

  server {
    listen 8081;
  }
}
`

describe('parseConf', () => {
  let editor: NginxConfEditor

  beforeEach(() => {
    editor = parseConf(confFixture)
  })

  describe('.get', () => {
    ([/* path                     | expected         */
      ['/daemon'                  , 'on'             ],
      ['/http/0/server/0/listen/0', '80'             ],
      ['/http/server/0/listen/0'  , '80'             ],
      ['/http/server/0/listen'    , ['80', '[::]:80']],
      ['/http/server/listen'      , ['80', '[::]:80']],
      ['/http/server'             , ['', '']         ],
    ] as const).forEach(([path, expected]) => {
      test(`${path} -> ${expected}`, () => {
        assert.deepEqual(editor.get(path), expected)
      })
    })
  })

  describe('.applyPatch', () => {

    const testRemove = (path: string) => {
      test("op: 'remove' - removes the directive", () => {
        editor.applyPatch([{ path, op: 'remove' }])
        assert(editor.get(path) == null)
        assert(editor.get(`${path}/0`) == null)
      })
    }

    describe('when the directive is not defined', () => {
      const path = '/worker_processes'
      const newValue = '5'

      ;(['add', 'default', 'set'] as const).forEach(op => {
        test(`op: '${op}' - adds a new new directive`, () => {
          editor.applyPatch([{ path, op, value: newValue }])
          assert.deepEqual(editor.get(path), newValue)
        })
      })
      testRemove(path)
    })

    describe('when the directive is defined once', () => {
      const path = '/http/access_log'
      const curValue = 'access.log'
      const newValue = 'a.log'

      ;([/* op    |  desc                        | expected            */
        ['add'    , 'adds a new directive'       , [curValue, newValue]],
        ['default', 'does not change anything'   , curValue            ],
        ['set'    , 'replaces existing directive', newValue            ],
      ] as const).forEach(([op, desc, expected]) => {
        test(`op: '${op}' - ${desc}`, () => {
          editor.applyPatch([{ path, op, value: newValue }])
          assert.deepEqual(editor.get(path), expected)
        })
      })
      testRemove(path)
    })

    describe('when the directive is defined twice', () => {
      const path = '/http/server/0/listen'
      const curValue = ['80', '[::]:80']
      const newValue = '443'

      ;([/* op    |  desc                        | expected              */
        ['add'    , 'adds a new directive'       , [...curValue, newValue]],
        ['default', 'does not change anything'   , curValue               ],
        ['set'    , 'replaces existing directive', newValue               ],
      ] as const).forEach(([op, msg, expected]) => {
        test(`op: '${op}' - ${msg}`, () => {
          editor.applyPatch([{ path, op, value: newValue }])
          assert.deepEqual(editor.get(path), expected)
        })
      })
      testRemove(path)
    })

    describe('when the parent directive does not exist', () => {
      const path = '/foo/bar/baz'

      ;(['add', 'default', 'set'] as const).forEach(op => {
        test(`op: '${op}' - throws an error`, () => {
          assert.throws(() => {
            editor.applyPatch([{ path, op, value: 'x' }])
          })
        })
      })

      test("op: 'remove' - does not throw", () => {
        assert.doesNotThrow(() => {
          editor.applyPatch([{ path, op: 'remove' }])
        })
      })
    })
  })

  test('.toString', () => {
    assert(editor.toString() === stripBlankLines(confFixture))
  })
})
