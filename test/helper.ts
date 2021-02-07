import * as powerAssert from 'power-assert'
import LogLevel from 'loglevel'
import 'anylogger-loglevel'


declare global {
  const assert: typeof powerAssert.strict
}

// This is a workaround for espower-typescript not working with ES imports.
(globalThis as any).assert = powerAssert.strict

// Don't output any log messages from nginx-testing when running tests.
LogLevel.getLogger('nginx-testing').disableAll()
