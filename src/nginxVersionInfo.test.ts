import { describe, test } from 'mocha'

import '../test/helper'
import { nginxVersionInfo } from './nginxVersionInfo'


describe('nginxVersionInfo', function () {
  this.slow(200)

  test('runs `<nginxPath> -V` and returns its parsed output', async () => {
    const result = await nginxVersionInfo(`${__dirname}/../test/fixtures/nginxV`)

    assert(result.version === '1.18.0', 'Expected the nginx version to be correctly parsed.')
    assert.deepEqual(result.modules, {
      http_fastcgi: 'without',
      http_geoip: 'with-dynamic',
      http_realip: 'with',
      http_scgi: 'without',
      http_ssl: 'with',
    }, 'Expected --with and --without flags for modules to be correctly parsed.')
  })

  test('when `<nginxPath> -V` exits with non-zero status', async () => {
    const binPath = `${__dirname}/../test/fixtures/fail`

    try { await nginxVersionInfo(binPath) } catch (err: any) {
      return assert(err.message === `Command failed with exit code 1: ${binPath} -V\nThis is error output`)
    }
    assert.fail('The function should throw, rather than completing.')
  })
})
