import { log } from '../logger'


export type UseCleanup = [
  onCleanup: OnCleanupHook,
  cleanup: CleanupHook,
]
export type OnCleanupHook = (fn: () => Promise<void> | void) => void
export type CleanupHook = () => Promise<void>

interface Options {
  /**
   * Whether to register the `cleanup` function as a listener to the process'
   * `'exit'` event. When the `cleanup` function is called manually, it's
   * removed from the process' listeners.
   */
  registerExitHook?: boolean
}

/**
 * Returns a tuple of two functions:
 *
 * 1. **onCleanup**: Queues the given function to be run by `cleanup()`.
 *    It may be called multiple times; the functions are added to a LIFO
 *    queue, i.e. they will be called in reverse order.
 * 2. **cleanup**: Runs the functions given to `onCleanup()`.
 */
export function useCleanup ({ registerExitHook }: Options = {}): UseCleanup {
  const funcs: Array<() => Promise<void> | void> = []

  const cleanup = async () => {
    let fn
    while ((fn = funcs.pop())) {
      try {
        const res = fn()
        if (res && 'then' in res) {
          await res
        }
      } catch (err) {
        log.error(err)
      }
    }
    if (registerExitHook) {
      process.removeListener('exit', cleanup)
    }
  }
  const onCleanup = funcs.push.bind(funcs)

  if (registerExitHook) {
    process.once('exit', cleanup)
  }
  return [onCleanup, cleanup]
}
