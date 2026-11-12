import type { Prompt, PromptAdapter } from '../src/index'

export function fakeAdapter(minAttention?: PromptAdapter['minAttention']) {
  const log: string[] = []
  let open: Prompt | undefined

  const adapter: PromptAdapter = {
    ...(minAttention && { minAttention }),
    show: prompt => {
      log.push(`show:${prompt.attention}`)
      open = prompt
    },
    hide: () => {
      log.push('hide')
      open = undefined
    },
  }

  return {
    log,
    adapter,
    get open(): Prompt {
      if (!open) {
        throw new Error('no prompt is showing')
      }

      return open
    },
    get isOpen() {
      return open !== undefined
    },
  }
}
