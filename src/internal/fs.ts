import { rmSync } from 'node:fs'

// Merge promisified async functions with sync functions.
export * from 'node:fs/promises'
// @ts-ignore(2308) -- names exported first have precedence
export * from 'node:fs'

export const rmRfSync = (path: string) => rmSync(path, { recursive: true, force: true })
