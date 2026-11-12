import { expect, it } from 'vitest'
import * as plugin from '../src/index'

it('exports only the plugin from the package entry', () => {
  expect(Object.keys(plugin)).toEqual(['appVersion'])
})
