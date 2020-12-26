import { rmSync } from 'fs'

// Merge promisified async functions with sync functions.
export * from 'fs/promises'
// @ts-ignore(2308) -- names exported first have precedence
export * from 'fs'

export const rmRfSync = (path: string) => rmSync(path, { recursive: true, force: true })
