import watch from 'node-watch'
import * as parseArgs from 'minimist'
import * as process from 'process'

import { arrify } from './internal/utils'
import { log } from './logger'
import { startNginx, NginxOptions } from './nginxRunner'


// TODO: Allow to set log level.

const progName = 'start-nginx'

const helpMsg = `\
Usage: ${progName} [options] <conf-file>

Start nginx server with the given config. This script is part of nginx-testing package.

Arguments:
  <conf-file>               Path of the nginx configuration file.

Options:
  -b --bin-path <file>      Name or path of the nginx binary to start. Defaults to 'nginx'.
                            This option is ignored if --version is specified.

  -v --version <semver>     A SemVer version range specifying the nginx version to download from
                            nginx-binaries a and run.

  -A --bind-address <host>  Hostname or IP address to bind the port(s) on. Defaults to 127.0.0.1.

  -p --port <port>          Port number(s) for substituting __PORT__, __PORT_1__, ..., __PORT_9__
                            placeholders in the nginx config. Repeat this option for more ports.
                            Defaults to random port numbers.

  -d --work-dir <dir>       Path of a directory that will be passed as a prefix into nginx.
                            If not provided, a temporary directory will be automatically created.

  -T --start-timeout <msec> Number of milliseconds after the start to wait for the nginx to
                            respond to the health-check request. Defaults to 1,000 ms.

  -w --watch <path>         Watch file or directory (recursively) and reload nginx on changes.
                            <conf-file> is watched implicitly. Repeat this option for more paths.

  -D --watch-delay <msec>   Delay time between reloads in milliseconds. Defaults to 200 ms.

  -h --help                 Show this message and exit.
`

const string = (value?: any) =>
  Array.isArray(value) ? String(value[value.length - 1])
  : value != null ? String(value)
  : undefined

const number = (value?: any) =>
  value ? parseInt(string(value)!) : undefined

type Options = Omit<NginxOptions, 'config' | 'errorLog' | 'accessLog'> & {
  configPath: string,
  watchPaths: string[],
  watchDelay?: number,
}

function parseCliArgs (argv: string[]): Options {
  const booleanOpts = {
    'help': 'h',
  } as const

  const stringOpts = {
    'bind-address': 'A',
    'bin-path': 'b',
    'port': 'p',
    'start-timeout': 'T',
    'version': 'v',
    'watch': 'w',
    'watch-delay': 'D',
    'work-dir': 'd',
  } as const

  type ParsedArgs = Pick<parseArgs.ParsedArgs, '_' | '--'> & Partial<
    & Record<keyof typeof booleanOpts, boolean>
    & Record<keyof typeof stringOpts, string | string[]>
  >

  const args: ParsedArgs = parseArgs(argv, {
    boolean: Object.keys(booleanOpts),
    string: Object.keys(stringOpts),
    alias: { ...booleanOpts, ...stringOpts },
    stopEarly: true,
    unknown: (arg: string) => {
      if (arg.startsWith('-')) {
        console.error(`Unknown option: ${arg}`)
        return false
      } else {
        return true
      }
    },
  })

  if (args.help) {
    console.log(helpMsg)
    return process.exit(0)
  }
  if (args._.length !== 1) {
    console.error('Invalid number of arguments\n')
    console.error(helpMsg)
    return process.exit(2)
  }

  return {
    bindAddress: string(args['bind-address']),
    binPath: string(args['bin-path']),
    configPath: args._[0]!,
    ports: arrify(args['port']).map(n => parseInt(n)),
    startTimeoutMsec: number(args['start-timeout']),
    version: string(args['version']),
    watchPaths: arrify(args['watch']),
    watchDelay: number(args['watch-delay']),
    workDir: string(args['work-dir']),
  }
}

async function run (opts: Options): Promise<void> {
  const nginx = await startNginx({
    ...opts,
    accessLog: process.stdout,
    errorLog: 'inherit',
  })
  log.info('Nginx has been started, press Ctrl+C to terminate it')

  const watcher = watch(
    [...opts.watchPaths, opts.configPath],
    { delay: opts.watchDelay || 200 },
    () => process.kill(nginx.pid, 'SIGHUP'),
  )
  let stopping = false

  const handleSignal = async () => {
    log.info('Terminating...')
    stopping = true
    watcher.close()
    return await nginx.stop()
  }
  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)

  const loop = () => {
    try {
      process.kill(nginx.pid, 0)  // check if running
      setTimeout(loop, 100)
    } catch {
      if (!stopping) {
        log.error('Nginx process has died')
        watcher.close()
        return nginx.stop()
      }
    }
    return
  }
  loop()
}


const opts = parseCliArgs(process.argv.slice(2))

run(opts).catch(err => {
  log.error(err.message)
  log.debug(err.stack)
  process.exit(1)
})
