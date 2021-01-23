import { AssertionError } from 'assert'
import * as dedent from 'dedent'
import { afterEach, describe, test } from 'mocha'
import { NginxBinary } from 'nginx-binaries'
import fetch from 'node-fetch'
import * as OS from 'os'
import * as path from 'path'
import { anything, spy, reset, when } from 'ts-mockito'
import { sync as which } from 'which'

import '../test/helper'
import { isDirectory, isFile, processExists, retryUntilTimeout } from '../test/utils'
import { configPatch, startNginx, NginxServer, __testing } from './nginxRunner'
import { nginxVersionInfo, NginxVersionInfo } from './nginxVersionInfo'


const { adjustConfig } = __testing

const NginxBinarySpy = spy(NginxBinary)

// TODO: Add more test cases.

describe('startNginx', function () {
  this.slow(250)

  const config = dedent`
    events {
    }
    http {
      server {
        listen __ADDRESS__:__PORT__;
        root __WORKDIR__;

        location /test {
          return 418;
        }
      }
    }
  `
  let nginx: NginxServer

  afterEach(async () => {
    nginx && await nginx.stop()
  })

  ;['system', '1.18.x', '1.19.x'].forEach(version => {
    describe(`with nginx ${version}`, () => {
      let binPath: string

      before(async function () {
        // We have to download nginx binary which may take some time on slow connection.
        this.timeout(120_000)

        if (version === 'system') {
          binPath = which(process.env.NGINX_BIN || 'nginx', { nothrow: true }) as string
          if (!binPath) {
            console.warn('nginx not found, skipping tests with system-provided nginx')
            this.skip()
          }
        } else {
          binPath = await NginxBinary.download({ version })

          when(NginxBinarySpy.download(anything(), anything())).thenResolve(binPath)
        }
      })
      after(() => {
        reset(NginxBinarySpy)
      })

      test('starts nginx with the given config', async () => {
        nginx = await startNginx({ binPath, config })

        assert(processExists(nginx.pid))
        assert(nginx.ports.length === 1)

        const url = `http://127.0.0.1:${nginx.port}/test`
        const resp = await fetch(url)

        assert(resp.status === 418, `Expected nginx to respond to GET ${url}.`)
      })

      describe('resolved value', () => {
        beforeEach(async () => {
          nginx = await startNginx({ binPath, config })
        })

        test('.config', async () => {
          const versionInfo = await nginxVersionInfo(binPath)
          const expected = adjustConfig(config, {
            ...versionInfo,
            bindAddress: '127.0.0.1',
            configPath: nginx.workDir,
            ports: nginx.ports,
            workDir: nginx.workDir,
          })

          assert.equal(nginx.config, expected,
            'Expected the .config to be the same as the input config transformed by adjustConfig().')
        })

        test('.workDir', () => {
          assert(isDirectory(nginx.workDir))
          assert(isFile(`${nginx.workDir}/nginx.conf`))
        })

        test('.readAccessLog', async () => {
          await fetch(`http://127.0.0.1:${nginx.port}/test`)

          await retryUntilTimeout(200, async () => {
            assert((await nginx.readAccessLog()).includes('GET /test'),
              'Expected to return nginx access log messages.')
          })
        })

        test('.readErrorLog', async () => {
          assert((await nginx.readErrorLog()).match(/using the "\w+" event method/),
            'Expected to return nginx error log messages.')
        })

        describe('.stop', () => {

          test('kills the nginx process', async () => {
            await nginx.stop()

            await retryUntilTimeout(500, () => assert(
              !processExists(nginx.pid),
              'Expected the nginx process to be killed within 500 ms.',
            ))
          })

          test('removes temporary workDir', async function () {
            await nginx.stop()

            // This test is very unreliable on Windows and often fails on Windows + Node 15.
            await retryUntilTimeout(1_000, () => assert(
              !isDirectory(nginx.workDir),
              'Expected the temporary workDir to be deleted within 1 sec after stopping.',
            ), (err: AssertionError) => {
              // XXX: If running on Windows and assert didn't pass within 1 sec,
              //      mark the test as skipped.
              if (OS.platform() === 'win32') {
                console.warn(`WARN: Ignoring failure of test '${this.test!.title}' on win32.`)
                this.skip()
              }
              throw err
            })
          })
        })
      })
    })
  })

  test('rejects if the config does not contain any __PORT__ and ports + preferredPorts are undef/empty', async () => {
    const binPath = `${__dirname}/../test/fixtures/nginxV`

    try {
      nginx = await startNginx({ binPath, config: 'daemon off;', ports: [], preferredPorts: [] })
    } catch (err) {
      return assert(err.message.includes('No __PORT__ placeholder found'))
    }
    assert.fail('The function should throw, rather than completing.')
  })

  test('with non-existing binPath', async () => {
    const binPath = '/does/not/exist'
    try {
      await startNginx({ binPath, config })
    } catch (err) {
      return assert(err.message.includes(binPath))
    }
    assert.fail('Expected the function to throw, rather than completing.')
  })
})

describe('adjustConfig', () => {
  const minimalConfig = dedent`
    events {
    }
    http {
      server {
        listen 8080;
      }
    }
  `
  const params = {
    bindAddress: '127.0.0.2',
    configPath: '/home/joe/project/nginx.conf',
    modules: {},
    ports: [8080],
    workDir: '/tmp/nginx-testing',
  }

  test('adds directives for compatibility with nginx-testing', () => {
    const expected = dedent`
    events {
    }
    http {
      server {
        listen 8080;
      }
      access_log access.log;
      client_body_temp_path client_body_temp;
      proxy_temp_path proxy_temp;
      fastcgi_temp_path fastcgi_temp;
      uwsgi_temp_path uwsgi_temp;
      scgi_temp_path scgi_temp;
    }
    daemon off;
    pid nginx.pid;
    master_process off;
    error_log stderr info;
    `
    const actual = adjustConfig(minimalConfig, params).trim()

    assert.equal(actual, expected)
  })

  test('does not add directives for unavailable modules', () => {
    const patch = configPatch.filter(x => x.ifModule)
    const modules = patch.reduce<NginxVersionInfo['modules']>(
      (acc, { ifModule  }) => (acc[ifModule!] = 'without', acc),
      {},
    )
    const result = adjustConfig(minimalConfig, { ...params, modules })

    for (const { path } of patch) {
      const directive = path.split('/').pop()
      assert(!result.includes(directive!), 'Expected this directive to not be added.')
    }
  })

  test('does not override certain directives', () => {
    const input = dedent`
      daemon on;
      master_process on;
      pid /run/nginx.pid;
      error_log stderr warn;
      http {
        access_log misc.log misc;
        client_body_temp_path cache/body;
        proxy_temp_path cache/proxy;
        fastcgi_temp_path cache/fastcgi;
        uwsgi_temp_path cache/uwsgi;
        scgi_temp_path cache/scgi;
      }
    `
    const expected = dedent`
      master_process on;
      error_log stderr warn;
      http {
        access_log misc.log misc;
        client_body_temp_path cache/body;
        proxy_temp_path cache/proxy;
        fastcgi_temp_path cache/fastcgi;
        uwsgi_temp_path cache/uwsgi;
        scgi_temp_path cache/scgi;
      }
      daemon off;
      pid nginx.pid;
    `
    const actual = adjustConfig(input, params).trim()

    assert.equal(actual, expected,
      "Expected 'demon' and 'pid' to be overridden, 'access_log' added and the rest kept as-is.")
  })

  describe('replaces placeholders with the given params', () => {
    const { bindAddress, configPath, workDir } = params
    const ports = [8080, 8081, 8090]

    ;([/* placeholder           | expected                         */
      ['__ADDRESS__:__PORT__'   , `${bindAddress}:${ports[0]}`     ],
      ['__CONFDIR__'            , path.dirname(configPath)         ],
      ['__CWD__'                , process.cwd().replace(/\\/g, '/')],
      ['__WORKDIR__'            , workDir                          ],
      ['__WORKDIR__/__WORKDIR__', `${workDir}/${workDir}`          ],
      ['__WORKDIR__/root'       , `${workDir}/root`                ],
      ['__PORT__'               , ports[0]                         ],
      ['127.0.0.1:__PORT__'     , `127.0.0.1:${ports[0]}`          ],
      ['__PORT_0__'             , ports[0]                         ],
      ['__PORT_1__'             , ports[1]                         ],
      ['__PORT_2__'             , ports[2]                         ],
    ] as const).forEach(([placeholder, expected]) => {
      test(placeholder, () => {
        const input = dedent`
          http {
            directive ${placeholder};
          }
        `
        const parameters = { ...params, ports }

        assert(adjustConfig(input, parameters).includes(`directive ${expected};`))
      })
    })
  })
})
