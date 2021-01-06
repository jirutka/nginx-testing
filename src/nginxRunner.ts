import AnyLogger from 'anylogger'
import path from 'path'
import type { Writable } from 'stream'

import TailFile from '@logdna/tail-file'
import execa from 'execa'
import getPort from 'get-port'
import { NginxBinary } from 'nginx-binaries'
import { WritableStreamBuffer } from 'stream-buffers'

import * as FS from './internal/fs'
import { useCleanup } from './internal/useCleanup'
import { createTempDir } from './internal/tempDir'
import { waitForHttpPortOpen } from './internal/waitForHttpPortOpen'
import { parseConf, PatchOperation } from './nginxConf'
import { nginxVersionInfo, NginxVersionInfo } from './nginxVersionInfo'


const defaultLogger = AnyLogger('nginx-testing')

type ConfigPatch = Array<PatchOperation & { ifModule?: string }>

/**
 * The default patch to be applied on the nginx configs to make it compatible with
 * the runner.
 */
export const configPatch: ConfigPatch = [
  { path: '/daemon', op: 'set', value: 'off' },
  { path: '/pid', op: 'set', value: 'nginx.pid' },
  // This is necessary on Windows, otherwise execa fails to kill nginx.
  { path: '/master_process', op: 'default', value: 'off' },
  { path: '/error_log', op: 'default', value: 'stderr info' },
  { path: '/http/access_log', op: 'default', value: 'access.log' },
  { path: '/http/client_body_temp_path', op: 'default', value: 'client_body_temp' },
  { path: '/http/proxy_temp_path', op: 'default', value: 'proxy_temp', ifModule: 'http_proxy' },
  { path: '/http/fastcgi_temp_path', op: 'default', value: 'fastcgi_temp', ifModule: 'http_fastcgi' },
  { path: '/http/uwsgi_temp_path', op: 'default', value: 'uwsgi_temp', ifModule: 'http_uwsgi' },
  { path: '/http/scgi_temp_path', op: 'default', value: 'scgi_temp', ifModule: 'http_scgi' },
]

/**
 * Options for the {@link startNginx} function.
 */
export type NginxOptions =
  | RequiredKeys<BaseOptions, 'configPath'>
  | RequiredKeys<BaseOptions, 'config'>

/**
 * Options for the {@link startNginx} function.
 */
interface BaseOptions {
  /**
   * Name or path of the nginx binary to start. Defaults to `'nginx'`.
   *
   * This option is ignored when `version` is provided.
   */
  binPath?: string
  /**
   * A SemVer version range specifying the nginx version to run.
   *
   * Nginx binary for your OS and architecture will be downloaded from
   * [nginx-binaries](https://github.com/jirutka/nginx-binaries). It will be stored in
   * directory `.cache/nginx-binaries/` inside the nearest writable `node_modules`
   * directory or in `nginx-binaries/` inside the system-preferred temp directory.
   *
   * Not all versions are available. You can find a list of available binaries at
   * [nginx-binaries](https://jirutka.github.io/nginx-binaries/).
   */
  version?: string
  /**
   * Nginx configuration to use.
   *
   * If `configPath` is provided, the processed config will be written to a temporary
   * file `.<filename>~` (where `<filename>` is a filename from `configPath`) in the
   * `configPath`'s directory (e.g. `conf/nginx.conf` -> `conf/.nginx.conf~`). Otherwise
   * it will be written into `nginx.conf` file in `workDir`. In either case, this file
   * will be automatically deleted after stopping the nginx.
   *
   * Either `configPath`, or `config` must be provided!
   */
  config?: string
  /**
   * Path of the nginx configuration file to use.
   *
   * This file will be processed and the resulting config file will be written to
   * a temporary file `.<filename>~` (where `<filename>` is a filename from `configPath`)
   * in the `configPath`'s directory (e.g. `conf/nginx.conf` -> `conf/.nginx.conf~`).
   * This temporary file will be automatically deleted after stopping the nginx.
   *
   * Either `configPath`, or `config` must be provided!
   */
  configPath?: string
  /**
   * Hostname or IP address to bind the port(s) on. Defaults to `'127.0.0.1'`.
   */
  bindAddress?: string
  /**
   * A list of preferred port numbers to use for nginx.
   *
   * Unavailable ports (used by some other program or restricted by OS) are skipped.
   * If there are no preferred ports left and another port is needed, a random port
   * number is used.
   *
   * These ports are used to substitute `__PORT__`, `__PORT_1__`, ..., `__PORT_9__`
   * placeholders in the given nginx config.
   */
  preferredPorts?: number[]
  /**
   * Path of a directory that will be passed as a _prefix_ (`-p`) into `nginx`.
   * It will be automatically created if doesn't exist.
   *
   * If not provided, an unique temporary directory in the OS' default temp directory
   * (see `os.tmpdir()`) will be created and automatically deleted after stopping.
   */
  workDir?: string
  /**
   * One of:
   *
   * - `'buffer'` -- Collect the nginx's stderr to a buffer that can be read using
   *   `readErrorLog()` (default).
   * - `'ignore'` - Ignore nginx's stderr.
   * - `'inherit'` -- Pass through the nginx's stderr output to the Node process.
   * - `<Writable>` -- A writable stream to pipe the nginx's stderr to.
   *
   * Nginx error log is expected to be redirected to _stderr_.
   * Directive `error_log stderr info;` will be automatically added to the config,
   * unless there's already `error_log` defined in the main context.
   */
  errorLog?: 'buffer' | 'ignore' | 'inherit' | Writable
  /**
   * One of:
   *
   * - `'buffer'` -- Collect the nginx's access log to a buffer that can be read using
   *   `readAccessLog()` (default).
   * - `'ignore'` -- Ignore nginx's access log.
   * - `<Writable>` -- A writable stream to pipe the nginx's access log to.
   *
   * Nginx access log is expected to be redirected to file `<workDir>/access.log`.
   * Directive `access_log access.log;` will be automatically added to the config,
   * unless there's already `access_log` defined in the `http` context.
   */
  accessLog?: 'buffer' | 'ignore' | Writable
  /**
   * Number of milliseconds after the start to wait for the nginx to respond to the
   * health-check request (`HEAD http://<bindAddress>:<ports[0]>/`).
   *
   * Defaults to `1000`.
   */
  startTimeoutMsec?: number
  /**
   * The logger to use for the runner logging. It must be an object with functions:
   * `debug`, `info`, `warn`, and `error`. You can use even global `console` as the
   * logger.
   *
   * Defaults to [anylogger](https://github.com/download/anylogger) with logger name
   * `'nginx-testing'`.
   */
  logger?: Logger
}

type Logger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>

type RequiredKeys<O extends object, K extends keyof O = keyof O> = O & {
  [L in K]-?: O[L]
}

/**
 * A return value of the {@link startNginx} function.
 */
export interface NginxServer {
  /**
   * The current nginx configuration.
   */
  readonly config: string
  /**
   * PID of the nginx process.
   */
  readonly pid: number
  /**
   * Number of the first port allocated for nginx, i.e. the port on which nginx
   * should listen for connections. It's the same as `ports[0]`.
   */
  readonly port: number
  /**
   * A list of port numbers allocated for nginx.
   */
  readonly ports: ReadonlyArray<number>
  /**
   * Path of the nginx's working directory.
   */
  readonly workDir: string

  /**
   * Reads new messages from the access log since the last call of `readAccessLog()`.
   *
   * @throws {Error} if the process was created with option `accessLog` other than
   *   `'buffer'` or `undefined`.
   */
  readAccessLog (): Promise<string>
  /**
   * Reads new messages from the error log since the last call of `readErrorLog()`.
   *
   * @throws {Error} if the process was created with option `errorLog` other than
   *   `'buffer'` or `undefined`.
   */
  readErrorLog (): Promise<string>
  /**
   * Stops the nginx and cleans-up temporary files and directories.
   */
  stop (): Promise<void>
}

/**
 * Starts nginx server with the given configuration.
 *
 * @example
 * import { startNginx, NginxProcess } from 'nginx-testing'
 * import fetch from 'node-fetch'
 *
 * let nginx: NginxProcess
 *
 * before(async () => {
 *   nginx = await startNginx({ version: '1.18.x', configPath: './nginx.conf' })
 * })
 * after(nginx.stop)
 *
 * test('GET / results in HTTP 200', async () => {
 *   const resp = await fetch(`http://localhost:${nginx.port}/`)
 *   assert(resp.status === 200)
 * })
 */
export async function startNginx (opts: NginxOptions): Promise<NginxServer> {
  if (!opts.config && !opts.configPath) {
    throw TypeError('Either config or configPath must be provided')
  }
  const {
    accessLog = 'buffer',
    bindAddress = '127.0.0.1',
    errorLog = 'buffer',
    logger: log = defaultLogger,
    preferredPorts = [],
    startTimeoutMsec = 1_000,
  } = opts

  const [onCleanup, cleanup] = useCleanup({ registerExitHook: true })

  try {
    let workDir = opts.workDir
    if (workDir) {
      await FS.mkdir(workDir, { recursive: true })
    } else {
      workDir = createTempDir('nginx-testing')
      // Async rm does not remove the dir on Windows (and I have no idea why).
      onCleanup(() => FS.rmRfSync(workDir!))
    }

    const binPath = opts.version
      ? await NginxBinary.download({ version: opts.version })
      : (opts.binPath || 'nginx')

    // Prepare config

    let config = opts.config ?? await FS.readFile(opts.configPath!, 'utf8')

    const portsCount = countNeededPorts(config)
    if (portsCount < 1 && preferredPorts.length < 1) {
      throw Error('No __PORT__ placeholder found in nginx config and option preferredPorts is empty')
    }
    const versionInfo = await nginxVersionInfo(binPath)
    const ports = await getFreePorts(bindAddress, countNeededPorts(config) || 1, preferredPorts)

    config = adjustConfig(config, { ...versionInfo, ports, workDir })

    const configPath = opts.configPath
      ? tempConfigPath(opts.configPath)
      : path.join(workDir, 'nginx.conf')

    log.debug(`Writing config to ${configPath}:\n-----BEGIN CONFIG-----\n${config}\n-----END CONFIG-----`)
    await FS.writeFile(configPath, config, 'utf8')
    onCleanup(() => FS.rmRfSync(configPath))

    // Start nginx

    log.info(`Starting nginx ${versionInfo.version} on port(s): ${ports.join(', ')}`)
    const ngxProcess = execa(binPath, ['-c', configPath, '-p', workDir], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: errorLog === 'buffer' ? 'pipe' : errorLog,
    })
    onCleanup(() => {
      log.debug(`Stopping nginx (${ngxProcess.pid})`)
      ngxProcess.cancel()
    })
    log.debug(`Nginx started with PID ${ngxProcess.pid}`)

    // Set-up error log

    let errorLogBuffer: WritableStreamBuffer | undefined
    if (errorLog === 'buffer') {
      errorLogBuffer = new WritableStreamBuffer()
      ngxProcess.stderr!.pipe(errorLogBuffer)
    }

    // Check if running

    // If nginx cannot be executed, e.g. invalid path, we want to fail fast
    // and throw a relevant error.
    await new Promise((resolve, reject) => {
      ngxProcess.once('error', reject)
      setTimeout(resolve, 50)  // sleep up to 50 ms
    })

    if (!await waitForHttpPortOpen({ hostname: bindAddress, port: ports[0] }, startTimeoutMsec)) {
      const msg = errorLogBuffer?.getContentsAsString()
      msg && log.error(msg)
      throw Error(`Failed to start nginx, no response on port ${ports[0]}`)
    }

    // Set-up access log

    let accessLogTail: TailFile | undefined
    let accessLogBuffer: WritableStreamBuffer | undefined
    if (accessLog !== 'ignore') {
      const accessLogPath = path.join(workDir, 'access.log')

      accessLogTail = new TailFile(accessLogPath, { pollFileIntervalMs: 10 })
      accessLogTail.pipe(accessLog === 'buffer'
        ? (accessLogBuffer = new WritableStreamBuffer())
        : accessLog
      )
      log.debug(`Begins polling of ${accessLogPath}`)
      await accessLogTail.start()

      // TailFile startPos from EOF doesn't work reliably, so better to remove
      // the file to avoid reading old logs on next run.
      onCleanup(() => FS.rmSync(accessLogPath))
      onCleanup(async () => await accessLogTail!.quit())
    }

    // Return

    return {
      get config () { return config },
      pid: ngxProcess.pid,
      ports,
      port: ports[0]!,
      workDir,

      readAccessLog: async () => {
        if (!accessLogBuffer || !accessLogTail) {
          throw Error("This function is available only when the option 'accessLog' is 'buffer'")
        }
        if ('_pollFileForChanges' in accessLogTail) {
          await (accessLogTail as any)._pollFileForChanges()
        }
        return accessLogBuffer.getContentsAsString() || ''
      },
      // This function doesn't need to be async now, but may be in the future.
      readErrorLog: async () => {
        if (!errorLogBuffer) {
          throw Error("This function is available only when the option 'errorLog' is 'buffer'")
        }
        return errorLogBuffer.getContentsAsString() || ''
      },
      stop: cleanup,
    }
  } catch (err) {
    await cleanup()
    throw err
  }
}

const portPlaceholderRx = /\b__PORT(?:_(\d))?__\b/g

function countNeededPorts (config: string): number {
  const portIndexes = Array.from(config.matchAll(portPlaceholderRx), ([_, n]) => Number(n || 0))
  return Math.max(...portIndexes) + 1
}

async function getFreePorts (address: string, count: number, preferred: number[] = []): Promise<number[]> {
  const ports: number[] = []

  for (let i = count; i > 0; i--) {
    ports.push(await getPort({ host: address, port: preferred }))
  }
  return ports
}

type ConfigParams = {
  ports: ReadonlyArray<number>,
  workDir: string,
  modules: NginxVersionInfo['modules'],
}

function adjustConfig (config: string, { modules, ports, workDir }: ConfigParams): string {
  config = config
    // nginx requires forward slashes even on Windows.
    .replace(/\b__WORKDIR__\b/g, workDir.replace(/\\/g, '/'))
    .replace(portPlaceholderRx, (match, idx) => ports[Number(idx) || 0]?.toString() ?? match)

  const patch = configPatch.filter(({ ifModule }) => {
    return !ifModule || modules[ifModule] !== 'without' && modules[ifModule] !== 'with-dynamic'
  })
  if (patch.length > 0) {
    config = parseConf(config).applyPatch(patch).toString()
  }
  return config
}

function tempConfigPath (filepath: string): string {
  return path.join(path.dirname(path.resolve(filepath)), `.${path.basename(filepath)}~`)
}

/** @internal */
export const __testing = {
  adjustConfig,
}
