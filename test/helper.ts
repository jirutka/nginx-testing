import powerAssert from 'power-assert'
import LogLevel from 'loglevel'
import 'anylogger-loglevel'

declare global {
  const assert: typeof powerAssert.strict
}

// This is a workaround for espower-typescript not working with ES imports.
(globalThis as any).assert = powerAssert.strict

LogLevel.getLogger('nginx-binaries').setLevel('INFO')
