import powerAssert from 'power-assert'

declare global {
  const assert: typeof powerAssert.strict
}

// This is a workaround for espower-typescript not working with ES imports.
(globalThis as any).assert = powerAssert.strict
