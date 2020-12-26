'use strict'

module.exports = {
  checkLeaks: true,
  extension: ['ts'],
  require: [
    'espower-typescript/guess',
    'source-map-support/register',
  ],
  spec: [
    'src/**/*.test.ts',
  ],
}
