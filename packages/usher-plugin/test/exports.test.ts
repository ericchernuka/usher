import { expect, it } from 'vitest'
import * as adapter from '../src/adapter'
import * as plugin from '../src/vite'

it('exports only the plugin from the Vite entry', () => {
  expect(Object.keys(plugin)).toEqual(['usher'])
})

it('exports only types from the adapter entry', () => {
  expect(Object.keys(adapter)).toEqual([])
})
