/**
 * dsh-msg-index host entry. This plugin is browser-client only; the host
 * side registers nothing beyond satisfying the bundle contract.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-msg-index'

export function apply(_ctx: Context): void {
  // 纯 client 插件：所有功能都在 src/client 的 shell.overlay 注入里。
}