
export function arrify <T> (value: T | T[] | undefined | null): T[] {
  return value == null ? []
    : Array.isArray(value) ? value
    : [value]
}
