import * as OS from 'os'
import * as path from 'path'
import * as process from 'process'
import { EventEmitter, Writable } from 'stream'

import * as TailFile from '@logdna/tail-file'
import * as execa from 'execa'
import type { ExecaChildProcess } from 'execa'
import * as getPort from 'get-port'
import { NginxBinary } from 'nginx-binaries'
import { WritableStreamBuffer } from 'stream-buffers'

import { arrify } from './internal/utils'
import * as FS from './internal/fs'
import { OnCleanupHook, useCleanup } from './internal/useCleanup'
import { createTempDir } from './internal/tempDir'
import { waitForHttpPortOpen } from './internal/waitForHttpPortOpen'
import { log } from './logger'
import { parseConf, PatchOperation } from './nginxConf'
import { nginxVersionInfo, NginxVersionInfo } from './nginxVersionInfo'


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

// NOTE: Keep in sync with API section in README.adoc (until I figure out how to generate it).
/**
 * Options for the {@link startNginx} function.
 */
interface BaseOptions {
  /**
   * Name or path of the nginx binary to start. Defaults to `'nginx'`.
   *
   * This option is ignored if `version` is provided.
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
   * The config may include the following placeholders which will be replaced with
   * corresponding values:
   *
   * - `__ADDRESS__` -- The address as specified in `bindAddress`.
   * - `__CONFDIR__` -- Path to directory with the config file as specified in `configPath`.
   * - `__CWD__` -- The current working directory as reported by `process.cwd()`.
   * - `__WORKDIR__` -- Path to the nginx's working directory as specified in `workDir`.
   * - `__PORT__`, `__PORT_1__`, ..., `__PORT_9__` -- The port numbers as specified in
   *   `ports` and `preferredPorts`.
   *
   * It will be modified for compatibility with the runner by applying patch operations
   * specified in {@link configPatch} variable.
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
   * See {@link config} option for information about placeholders and patching.
   *
   * Either `configPath`, or `config` must be provided!
   */
  configPath?: string
  /**
   * Hostname or IP address the port(s) will be binding on. This is used when searching
   * for free ports (see `preferredPorts`) and for substituting `__ADDRESS__` placeholder
   * in the given nginx config. Defaults to `'127.0.0.1'`.
   */
  bindAddress?: string
  /**
   * A list of port numbers for substituting `__PORT__`, `__PORT_1__`, ..., `__PORT_9__`
   * placeholders in the given nginx config. Unlike `preferredPorts`, these are _not_
   * checked for availability and nginx will fail to start if any of the provided and
   * used ports is unavailable.
   *
   * If it's not provided or more ports are needed, next ports are selected from the
   * `preferredPorts` or randomly.
   */
  ports?: number[],
  /**
   * A list of preferred port numbers to use for substituting `__PORT__`, `__PORT_1__`,
   * ..., `__PORT_9__` placeholders in the given nginx config.
   *
   * Unavailable ports (used by some other program or restricted by OS) are skipped.
   * If there are no preferred ports left and another port is needed, a random port
   * number is used.
   */
  preferredPorts?: number[]
  /**
   * Path of a directory that will be passed as a _prefix_ (`-p`) into `nginx`.
   * It will be automatically created if doesn't exist.
   *
   * If not provided, an unique temporary directory will be created:
   * `.cache/nginx-testing-XXXXXX/` relative to the nearest writable `node_modules`
   * (nearest to `process.cwd()`) or `nginx-testing-XXXXXX/` in the system-preferred
   * temp directory. The created directory will be automatically deleted after stopping.
   */
  workDir?: string
  /**
   * One of:
   *
   * - `'buffer'` -- Collect the nginx's stderr to a buffer that can be read using
   *   `readErrorLog()` (default).
   * - `'ignore'` -- Ignore nginx's stderr.
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
   * health-check request (`HEAD http://<bindAddress>:<ports[0]>/health`). Any HTTP
   * status is considered as success - it just checks if the nginx is listening and
   * responding.
   *
   * Defaults to `1000`.
   */
  startTimeoutMsec?: number
}

type RequiredKeys<O extends object, K extends keyof O = keyof O> = O & {
  [L in K]-?: O[L]
}

// NOTE: Keep in sync with API section in README.adoc (until I figure out how to generate it).
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
   * Reloads the nginx (using SIGHUP), optionally with a new configuration.
   * Options `config` and `configPath` are mutually exclusive here.
   *
   * Nginx can be reloaded only when running with the master process. This is disabled
   * by default, but you can override it by declaring `master_process on` in the config.
   *
   * **Important:** The function you are looking for is `restart()`. Use `reload()` only
   * if you know that you cannot use `restart()`.
   *
   * **Cation:** This function doesn't work on Windows!
   *
   * @throws {Error} if nginx was started with `master_process off`.
   * @throws {Error} if running on Windows (`win32` platform).
   */
  reload (opts?: RestartOptions): Promise<void>
  /**
   * Restarts the nginx, optionally with a new configuration.
   * Options `config` and `configPath` are mutually exclusive here.
   *
   * The new nginx process will be started with the same ports, working directory etc.
   */
  restart (opts?: RestartOptions): Promise<void>
  /**
   * Stops the nginx and cleans-up temporary files and directories.
   */
  stop (): Promise<void>
}

type RestartOptions = Pick<BaseOptions, 'config' | 'configPath'>

/**
 * Starts nginx server with the given configuration.
 *
 * @example
 * import { startNginx, NginxServer } from 'nginx-testing'
 * import fetch from 'node-fetch'
 *
 * let nginx: NginxServer
 *
 * before(async () => {
 *   nginx = await startNginx({ version: '1.24.x', configPath: './nginx.conf' })
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
    ports = [],
    preferredPorts = [],
    startTimeoutMsec = 1_000,
  } = opts

  const [onCleanup, cleanup] = useCleanup({ registerExitHook: true })

  try {
    let workDir: string
    if (opts.workDir) {
      workDir = opts.workDir
      await FS.mkdir(workDir, { recursive: true })
    } else {
      workDir = createTempDir('nginx-testing')
      // Async rm does not remove the dir on Windows (and I have no idea why).
      onCleanup(() => FS.rmRfSync(workDir!))
    }

    const binPath = opts.version
      ? await NginxBinary.download({ version: opts.version })
      : (opts.binPath || 'nginx')

    const versionInfo = await nginxVersionInfo(binPath)

    // Prepare config

    let config = opts.config ?? await FS.readFile(opts.configPath!, 'utf8')

    let portsCount = countNeededPorts(config)
    if (portsCount === 0 && ports.length === 0 && preferredPorts.length === 0) {
      throw Error('No __PORT__ placeholder found in nginx config and options ports and preferredPorts are empty')
    }
    portsCount ||= 1
    if (ports.length < portsCount) {
      ports.push(...await getFreePorts(bindAddress, portsCount - ports.length, preferredPorts))
    }

    const configPath = opts.configPath
      ? tempConfigPath(opts.configPath)
      : path.join(workDir, 'nginx.conf')

    const configParams: ConfigParams = { ...versionInfo, bindAddress, configPath, ports, workDir }
    config = adjustConfig(config, configParams)

    await writeConfigFile(configPath, config)
    onCleanup(() => FS.rmRfSync(configPath))

    // Start nginx

    log.info(`Starting nginx ${versionInfo.version} on port(s): ${ports.join(', ')}`)
    const startOpts = { binPath, configPath, bindAddress, ports, workDir, errorLog, startTimeoutMsec }
    let [ngxProcess, errorLogBuffer] = await startAndCheckNginxProcess(startOpts, onCleanup)

    // Set-up access log

    const accessLogStream = accessLog instanceof EventEmitter
      ? accessLog
      : new WritableStreamBuffer()

    const accessLogTail = accessLog !== 'ignore'
      ? await tailLogFile(path.join(workDir, 'access.log'), accessLogStream, onCleanup)
      : null

    // Commons for control functions

    const updateConfigIfDefined = async (opts: RestartOptions) => {
      if (opts.config || opts.configPath) {
        const newConfig = opts.config ?? await FS.readFile(opts.configPath!, 'utf8')

        config = adjustConfig(newConfig, configParams)
        await writeConfigFile(configPath, config)
      }
    }

    let isMasterProcess: boolean

    // Return

    return {
      get config () { return config },
      get pid () { return ngxProcess.pid! },
      ports,
      port: ports[0]!,
      workDir,

      readAccessLog: async () => {
        if (!accessLogTail || !(accessLogStream instanceof WritableStreamBuffer)) {
          throw Error("This function is available only when the option 'accessLog' is 'buffer'")
        }
        if ('_pollFileForChanges' in accessLogTail) {
          await (accessLogTail as any)._pollFileForChanges()
        }
        return accessLogStream.getContentsAsString() || ''
      },
      // This function doesn't need to be async now, but may be in the future.
      readErrorLog: async () => {
        if (!errorLogBuffer) {
          throw Error("This function is available only when the option 'errorLog' is 'buffer'")
        }
        return errorLogBuffer.getContentsAsString() || ''
      },
      reload: async (opts = {}) => {
        if (OS.platform() === 'win32') {
          throw Error('Not supported on Windows')
        }
        if (!(isMasterProcess ??= isMasterProcessEnabled(config))) {
          throw Error('Nginx cannot be reloaded when master_process is off')
        }
        log.info(`Reloading nginx`)

        await updateConfigIfDefined(opts)

        log.debug('Sending SIGHUP to nginx process')
        process.kill(ngxProcess.pid!, 'SIGHUP')
      },
      restart: async (opts = {}) => {
        log.info(`Restarting nginx`)
        ngxProcess.cancel()

        await updateConfigIfDefined(opts)

        log.debug('Starting new nginx process')
        ;[ngxProcess, errorLogBuffer] = await startAndCheckNginxProcess(startOpts, onCleanup)
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
  return Math.max(...portIndexes, -1) + 1
}

async function getFreePorts (address: string, count: number, preferred: number[] = []): Promise<number[]> {
  const ports: number[] = []

  for (let i = count; i > 0; i--) {
    ports.push(await getPort({ host: address, port: preferred }))
  }
  return ports
}

type ConfigParams = {
  bindAddress: string,
  configPath: string,
  ports: ReadonlyArray<number>,
  workDir: string,
  modules: NginxVersionInfo['modules'],
}

function adjustConfig (config: string, { bindAddress, configPath, modules, ports, workDir }: ConfigParams): string {
  const placeholders: Record<string, string> = {
    ADDRESS: bindAddress,
    // nginx requires forward slashes even on Windows.
    CONFDIR: unixPath(path.dirname(configPath)),
    CWD: unixPath(process.cwd()),
    WORKDIR: unixPath(workDir),
  }
  config = config
    .replace(portPlaceholderRx, (match, idx) => ports[Number(idx) || 0]?.toString() ?? match)
    .replace(/\b__([A-Z_]+)__\b/g, (match, name) => placeholders[name] ?? match)

  const patch = configPatch.filter(({ ifModule }) => {
    return !ifModule || modules[ifModule] !== 'without' && modules[ifModule] !== 'with-dynamic'
  })
  if (patch.length > 0) {
    config = parseConf(config).applyPatch(patch).toString()
  }
  return config
}

const unixPath = (filepath: string) => filepath.replace(/\\/g, '/')

function tempConfigPath (filepath: string): string {
  return path.join(path.dirname(path.resolve(filepath)), `.${path.basename(filepath)}~`)
}

async function writeConfigFile (configPath: string, config: string): Promise<void> {
  log.debug(`Writing config to ${configPath}:\n-----BEGIN CONFIG-----\n${config}\n-----END CONFIG-----`)
  await FS.writeFile(configPath, config, 'utf8')
}

async function startAndCheckNginxProcess (
  opts: Required<Omit<NginxOptions, 'config' | 'version' | 'preferredPorts' | 'accessLog'>>,
  onCleanup: OnCleanupHook,
): Promise<[process: ExecaChildProcess, errorLogBuffer?: WritableStreamBuffer]> {
  const { errorLog } = opts

  // Start process
  const ngxProcess = execa(opts.binPath, ['-c', opts.configPath, '-p', opts.workDir], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: errorLog === 'buffer' ? 'pipe' : errorLog,
  })
  onCleanup(() => {
    if (!ngxProcess.killed) {
      log.debug(`Stopping nginx (${ngxProcess.pid})`)
      ngxProcess.cancel()
    }
  })
  log.debug(`Nginx started with PID ${ngxProcess.pid}`)

  // Set-up error log
  let errorLogBuffer: WritableStreamBuffer | undefined
  if (errorLog === 'buffer') {
    errorLogBuffer = new WritableStreamBuffer()
    ngxProcess.stderr!.pipe(errorLogBuffer)
  }
  const dumpErrorLog = () => {
    const msg = errorLogBuffer?.getContentsAsString()
    msg && log.error(msg)
  }

  // Check if running

  // Wait up to 50 ms for an error and continue if no error appeared.
  // If nginx cannot be executed, e.g. invalid path, we want to fail fast,
  // dump error log and throw a relevant error.
  try { await waitForProcessError(ngxProcess, 50) } catch (err) {
    dumpErrorLog()
    throw err
  }

  const checkRequestOpts = { hostname: opts.bindAddress, port: opts.ports[0], path: '/health' }
  if (!await waitForHttpPortOpen(checkRequestOpts, opts.startTimeoutMsec)) {
    dumpErrorLog()
    throw Error(`Failed to start nginx, no response on port ${opts.ports[0]}`)
  }

  return [ngxProcess, errorLogBuffer]
}

async function tailLogFile (
  filepath: string,
  output: Writable,
  onCleanup: OnCleanupHook,
): Promise<TailFile> {
  const tail = new TailFile(filepath, { pollFileIntervalMs: 10 })
  tail.pipe(output)

  log.debug(`Begins polling of ${filepath}`)
  await tail.start()

  // TailFile startPos from EOF doesn't work reliably, so better to remove
  // the file to avoid reading old logs on next run.
  onCleanup(() => FS.rmSync(filepath))
  onCleanup(async () => await tail!.quit())

  return tail
}

const waitForProcessError = (process: ExecaChildProcess, timeout: number) => new Promise<void>((resolve, reject) => {
  process.once('error', reject)

  setTimeout(() => {
    process.removeListener('error', reject)
    resolve()
  }, timeout)
})

function isMasterProcessEnabled (config: string): boolean {
  return arrify(parseConf(config).get('/master_process')).pop() !== 'off'
}

/** @internal */
export const __testing = {
  adjustConfig,
}
