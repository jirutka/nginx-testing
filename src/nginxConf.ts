import { strict as assert } from 'assert'
import { NginxConfFile } from 'nginx-conf'
import type { NginxConfItem as ConfItem } from 'nginx-conf/dist/src/conf'


// NOTE: Keep in sync with API section in README.adoc (until I figure out how to generate it).
/**
 * Nginx configuration editor returned by {@link parseConf}.
 */
export interface NginxConfEditor {
  /**
   * Returns a value of a directive at the path specified by a JSON Pointer
   * (e.g. `/http/servers/0/listen`).
   *
   * - If the directive is not declared, returns `undefined`.
   * - If the path points to an unnamed block (e.g. `server`), returns an empty string.
   * - If an intermediate directive is declared multiple times and no index is
   *   specified in the path (e.g. `/http/servers/listen`), the first one is
   *   selected (`/http/servers/0/listen`).
   * - If the path points to a directive that is declared multiple times (in the
   *   same context), returns an array of each declaration's value.
   */
  get (path: string): string | string[] | undefined
  /**
   * Applies the specified patch operations on the config.
   *
   * @throws {RangeError} if some intermediate directive on the path does not exist.
   * @see PatchOperation
   */
  applyPatch (patch: PatchOperation[]): this
  /**
   * Dumps the config back to string.
   */
  toString (): string
}

// NOTE: Keep in sync with API section in README.adoc (until I figure out how to generate it).
/**
 * A patch operation to be performed on nginx config.
 *
 * It's an object with the following properties:
 *
 * - `op` -- The operation name; one of:
 *   - `'add'` -- Adds a directive.
 *   - `'default'` -- Sets a directive if it's not declared yet.
 *   - `'remove'` -- Removes a directive.
 *   - `'set'` -- Sets a directive and removes its existing declarations in the
 *     same context.
 *
 * - `path` -- A JSON Pointer of the directive to be added, set or removed.
 *   For example, `/http/server/1/listen` points to a directive `listen` in
 *   the second `server` context inside `http` context. See documentation of
 *   `get` function in {@link NginxConfEditor} for more information.
 *
 * - `value` -- A value of the directive (not defined for op `'remove'`).
 *
 * This is based on [JSON Patch](http://jsonpatch.com/), but with a different
 * operations.
 */
export type PatchOperation =
  | { op: 'add', path: string, value: string }
  | { op: 'default', path: string, value: string }
  | { op: 'remove', path: string }
  | { op: 'set', path: string, value: string }


/**
 * Parses the given nginx config.
 */
export function parseConf (source: string): NginxConfEditor {
  let result: NginxConfFile | undefined

  // XXX: This function is actually synchronous, just silly API...
  NginxConfFile.createFromSource(source, { tab: '  ' }, (err, conf) => {
    if (err) throw err
    result = conf
  })
  assert(result, 'This should not have happened')

  return nginxConfEditor(result)
}

const nginxConfEditor = (conf: NginxConfFile): NginxConfEditor => ({
  get (path) {
    const item = get(conf.nginx, path)
    // `_value` is always string in nginx-conf 2.0.0, but its type is declared as
    // `string | number`, so we convert it to string to be sure...
    return item == null ? item
      : Array.isArray(item) ? item.map(({ _value }) => _value == null ? _value : String(_value))
      : item._value == null ? undefined
      : String(item._value)
  },
  applyPatch (patch) {
    for (const op of patch) {
      applyOperation(conf.nginx, op)
    }
    return this
  },
  toString () {
    return conf.toString()
  },
})

function applyOperation (confRoot: ConfItem, operation: PatchOperation): void {
  const splitPath = operation.path.split('/')
  const itemName = splitPath.pop()!
  const parentPath = splitPath.join('/')

  let parent: ConfItem | ConfItem[] | undefined = get(confRoot, parentPath)
  if (!parent) {
    if (operation.op !== 'remove') {
      throw RangeError(`Directive at ${parentPath} does not exist`)
    }
    return
  }
  if (Array.isArray(parent)) {
    parent = parent[0]!
  }

  switch (operation.op) {
    case 'add':
      parent._add(itemName, operation.value)
      break
    case 'default':
      if (get(confRoot, operation.path) == null) {
        parent._add(itemName, operation.value)
      }
      break
    case 'remove':
      // NOTE: ConfItem._remove() does not remove multi-values.
      delete parent[itemName]
      break
    case 'set':
      if (parent[itemName]) {
        delete parent[itemName]
      }
      parent._add(itemName, operation.value)
  }
}

function get (confRoot: ConfItem, path: string): ConfItem | ConfItem[] | undefined {
  const pointer = path?.split('/')
  if (!pointer || pointer[0] !== '') {
    throw Error(`Invalid JSON pointer: ${path}`)
  }
  const len = pointer.length
  if (len === 1) {
    return confRoot
  }

  for (let i = 1, item: ConfItem | ConfItem[] | undefined = confRoot; i < len; i++) {
    const p = pointer[i]!

    if (Array.isArray(item) && !/\d+/.test(p)) {
      item = item[0]
    }
    item = (item as any)?.[p]
    if (i === len - 1) {
      return item
    }
    if (typeof item !== 'object') {
      return undefined
    }
  }
  return undefined
}
