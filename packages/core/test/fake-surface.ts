import type { UpdateNotice, UpdateSurface } from '../src/index'

export function fakeSurface(minAttention?: UpdateSurface['minAttention']) {
  const log: string[] = []
  let open: UpdateNotice | undefined

  const surface: UpdateSurface = {
    ...(minAttention && { minAttention }),
    show: notice => {
      log.push(`show:${notice.attention}`)
      open = notice
    },
    hide: () => {
      log.push('hide')
      open = undefined
    },
  }

  return {
    log,
    surface,
    get open(): UpdateNotice {
      if (!open) {
        throw new Error('no notice is showing')
      }

      return open
    },
  }
}
