import { describe, expect, it } from 'vitest'
import { buildLayout } from '../src/build-layout'

const layout = (base: string) =>
  buildLayout({ base, assetsDir: 'assets', fileName: 'version.json' })

describe('build layout', () => {
  it.each([
    {
      base: '/',
      versionUrl: '/version.json',
      paths: { base: '/', assetsPrefix: '/assets/' },
    },
    {
      base: '/app/',
      versionUrl: '/app/version.json',
      paths: { base: '/app/', assetsPrefix: '/app/assets/' },
    },
    {
      base: 'https://cdn.example.com/app/',
      versionUrl: 'https://cdn.example.com/app/version.json',
      paths: { base: '/app/', assetsPrefix: '/app/assets/' },
    },
    {
      base: 'https://cdn.example.com/',
      versionUrl: 'https://cdn.example.com/version.json',
      paths: { base: '/', assetsPrefix: '/assets/' },
    },
  ])(
    'given base $base, then the version file is at $versionUrl and chunks are under the path of the base',
    ({ base, versionUrl, paths }) => {
      expect(layout(base)).toEqual({ versionUrl, paths })
    },
  )

  it.each(['./', ''])(
    'given the relative base "%s", then the version file resolves from the page and there are no fixed paths',
    base => {
      expect(layout(base)).toEqual({
        versionUrl: `${base}version.json`,
        paths: undefined,
      })
    },
  )
})
