import { describe, expect, it } from 'vitest'
import type { SkewProtectionAdapter } from '../src/adapter'
import { planAdapterFiles } from '../src/adapter-files'
import { buildLayout } from '../src/build-layout'

const output = (base: string, outDir = 'dist') => ({
  layout: buildLayout({ base, assetsDir: 'assets', fileName: 'version.json' }),
  root: '/project',
  outDir,
})

const withPrivateFile = (fileName: string): SkewProtectionAdapter => ({
  name: 'stub-host',
  files: () => ({ privateFiles: [{ fileName, source: 'worker' }] }),
})

describe('planning adapter files', () => {
  it('given a relative base, then it fails before asking the adapter, because chunks have no fixed path to route', () => {
    const adapter: SkewProtectionAdapter = {
      name: 'stub-host',
      files: () => {
        throw new Error('the adapter was asked')
      },
    }

    expect(() => planAdapterFiles(adapter, output('./'))).toThrow(
      /stub-host: the base is relative/,
    )
  })

  it.each([
    { fileName: '/project/dist/worker.js', outDir: 'dist' },
    { fileName: 'out/../dist/worker.js', outDir: 'dist' },
    { fileName: 'dist/..private/worker.js', outDir: 'dist' },
    { fileName: 'worker.js', outDir: '.' },
    { fileName: '/elsewhere/out/worker.js', outDir: '/elsewhere/out' },
  ])(
    'given the private file $fileName and outDir $outDir, then it fails, because the file would be served',
    ({ fileName, outDir }) => {
      expect(() =>
        planAdapterFiles(withPrivateFile(fileName), output('/', outDir)),
      ).toThrow(/must be outside outDir/)
    },
  )

  it.each([
    {
      fileName: 'distribution/worker.js',
      path: '/project/distribution/worker.js',
    },
    { fileName: '../shared/worker.js', path: '/shared/worker.js' },
    { fileName: '..private/worker.js', path: '/project/..private/worker.js' },
  ])(
    'given the private file $fileName, then it is planned at $path, outside the client output',
    ({ fileName, path }) => {
      const plan = planAdapterFiles(withPrivateFile(fileName), output('/'))

      expect(plan.privateFiles).toEqual([{ fileName, source: 'worker', path }])
    },
  )
})
