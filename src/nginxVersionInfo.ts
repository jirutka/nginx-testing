import * as execa from 'execa'

import { log } from './logger'


/**
 * Parsed output of `nginx -V` returned from {@link nginxVersionInfo}.
 */
export interface NginxVersionInfo {
  /**
   * Nginx version number (e.g. `'1.18.0'`).
   */
  version: string
  /**
   * A record of modules the nginx was built with or without.
   *
   * @example
   * {
   *   http_fastcgi: 'without',
   *   http_geoip: 'with-dynamic',
   *   http_ssl: 'with',
   * }
   */
  modules: Record<string, ModuleFlag>
}

export type ModuleFlag = 'with' | 'with-dynamic' | 'without'

/**
 * Executes the nginx binary `nginxBinPath` with option `-V` and returns parsed
 * version and info about the modules it was compiled with(out).
 */
export async function nginxVersionInfo (nginxBinPath: string): Promise<NginxVersionInfo> {
  log.debug(`Executing '${nginxBinPath} -V'`)
  const { stderr } = await execa(nginxBinPath, ['-V'], { timeout: 500 })

  log.debug(`nginx -V: ${stderr}`)

  return parseOutput(stderr)
}

function parseOutput (output: string): NginxVersionInfo {
  const [, version = ''] = /^nginx version: nginx\/(\S+)/m.exec(output) ?? []
  const [, config = ''] = /^configure arguments: (.*)/m.exec(output) ?? []

  const modules = [...config.matchAll(/--(with(?:out)?)-(\w+)_module(?:=(\w+))?\b/g)]
    .reduce<NginxVersionInfo['modules']>((acc, m) => {
      acc[m[2]!] = m[1] + (m[3] === 'dynamic' ? `-${m[3]}` : '') as ModuleFlag
      return acc
    }, {})

  return {
    version,
    modules,
  }
}
