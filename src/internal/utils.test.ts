import { describe, test } from 'mocha'

import { arrify } from './utils'


describe('arrify', () => {
  [/* value        | expected      */
    [['foo', 'bar'], ['foo', 'bar']],
    ['foo'         , ['foo']       ],
    [undefined     , []            ],
    [null          , []            ],
  ].forEach(([value, expected]) => {
    test(`${value} -> ${expected}`, () => {
      assert.deepEqual(arrify(value), expected)
    })
  })
})
