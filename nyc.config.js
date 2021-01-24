'use strict'

module.exports = {
  all: true,
  include: ['src/**/*.ts'],
  reporter: ['text', 'lcovonly'],
  tempDir: 'node_modules/.cache/nyc_output',
}
