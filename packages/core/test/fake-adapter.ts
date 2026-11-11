// A stand-in for a toast library: records what connectPrompt asked it to do.
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
    /** The prompt currently on screen; throws if none, so a test can't misread "nothing shown". */
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
