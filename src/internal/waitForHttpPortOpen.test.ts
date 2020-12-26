import getPort from 'get-port'
import http from 'http'
import { beforeEach, describe, test } from 'mocha'
import net from 'net'

import '../../test/helper'
import { isCloseTo } from '../../test/utils'
import { waitForHttpPortOpen } from './waitForHttpPortOpen'


describe('waitForHttpPortOpen', function () {
  this.slow(1_200)

  const host = '127.0.0.1'
  let port: number

  beforeEach(async () => {
    port = await getPort({ host, port: 56789 })
  })

  test('successfully waits for a valid HTTP response', async () => {
    const server = http.createServer((_, res) => {
      res.writeHead(200)
      res.write('OK')
      res.end()
    }).listen(port)

    try {
      assert(await waitForHttpPortOpen({ host, port }, 500) === true)
    } finally {
      server.close()
    }
  })

  test('errors when the address is invalid', async function () {
    this.retries(3)  // XXX: This test is problematic.
    const invalidHost = '192.168.1.666'

    // Wait for a point on an address (I hope) does not exist.
    try {
      await waitForHttpPortOpen({ host: invalidHost, port }, 1_000)
    } catch (err) {
      assert(err.code === 'ENOTFOUND')
      assert(err.message.includes(invalidHost))
      return
    }
    assert.fail('Expected the function to throw, rather than completing.')
  })

  describe('timeouts after the specified time', () => {

    test('when nothing is listening on the port', async () => {
      const timeout = 500
      const start = Date.now()

      assert(await waitForHttpPortOpen({ host, port }, timeout) === false)

      const elapsed = Date.now() - start
      assert(isCloseTo(timeout, elapsed, 250),
        'Expected the elapsed time to be close to the given timeout.')
    })

    test('when the host address is non-routable', async () => {
      assert(await waitForHttpPortOpen({ host: '10.255.255.1', port }, 500) === false)
    })

    test('when waiting for HTTP but only given TCP/IP', async () => {
      // We can create a TCP/IP server, but this should not be enough,
      // cause we're waiting for HTTP.
      const server = net.createServer().listen(port, host)

      try {
        assert(await waitForHttpPortOpen({ host, port }, 500) === false)
      } finally {
        server.close()
      }
    })
  })
})
