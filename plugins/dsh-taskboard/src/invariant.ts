/**
 * Package-owned invariant companion for `@suhan-dsh/taskboard`.
 * @module @suhan-dsh/taskboard/invariant
 */

/** Cordis companion plugin name. */
export const name = 'dsh-taskboard-invariant'

/**
 * No runtime invariant: the REST route registration is an effect owned by the
 * web-server registry, and the browser-half overlay entry is observed by the
 * slot registry.
 */
export const apply = (): void => {}
