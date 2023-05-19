import * as http from 'http'

import { log } from '../logger'


type RequestOptions = Omit<http.RequestOptions, 'timeout' | 'createConnection'>

/**
 * Waits until the specified port is open and accepting an HTTP request, or the
 * `timeout` expires. Resolves to `true` on success, `false` on connection refused,
 * connection reset and connection timeout. Rejects on unexpected errors.
 *
 * @param requestOpts Request options; typically `hostname` and `port` should be provided.
 * @param timeoutMsec Connection timeout in milliseconds; attempts to open the socket will be
 *   terminated _after_ this time has passed.
 * @param intervalMsec Checking interval in milliseconds.
 */
export const waitForHttpPortOpen = (
  requestOpts: RequestOptions,
  timeoutMsec: number,
  intervalMsec = 100,
) => new Promise<boolean>((resolve, reject) => {
  requestOpts = { method: 'HEAD', path: '/', ...requestOpts }

  const expectedErrorCodes = ['ECONNREFUSED', 'ECONNTIMEOUT', 'ECONNRESET']
  const startTime = Date.now()

  const loop = (): Promise<void | NodeJS.Timeout> => {
    log.debug(`Trying to connect ${JSON.stringify(requestOpts)}`)

    return checkHttpWithTimeout(requestOpts, timeoutMsec)
      .then(() => resolve(true))
      .catch(err => {
        log.debug(`Got error ${err.code}: ${err}`)

        if (expectedErrorCodes.includes(err.code)) {
          if (Date.now() - startTime > timeoutMsec) {
            log.debug(`Timed out after ${Date.now() - startTime}ms`)
            return resolve(false)
          } else {
            return setTimeout(loop, intervalMsec)
          }
        }
        return reject(err)
      })
  }

  loop()
})

const checkHttpWithTimeout = (
  opts: RequestOptions,
  timeout: number,
) => new Promise<void>((resolve, reject) => {
  const req = http.request({ ...opts, timeout })
  req
    .on('close', resolve)
    .on('error', (err) => {
      req.destroy()
      return reject(err)
    })
    .on('timeout', () => {
      req.destroy()
      const err = Error('Connection timeout')
      ;(err as any).code = 'ECONNTIMEOUT'
      return reject(err)
    })
    .end()
})
