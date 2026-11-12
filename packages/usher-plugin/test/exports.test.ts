import { expect, it } from 'vitest'
import * as plugin from '../src/vite'

it('exports only the plugin from the package entry', () => {
  expect(Object.keys(plugin)).toEqual(['usher'])
})
