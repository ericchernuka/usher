import { mkdir, readFile, writeFile } from 'node:fs/promises'

const packages = ['core', 'react', 'cloudflare', 'vite']

const reports = await Promise.all(
  packages.map(async name =>
    JSON.parse(
      await readFile(`packages/${name}/coverage/coverage-final.json`, 'utf8'),
    ),
  ),
)

await mkdir('coverage', { recursive: true })

await writeFile(
  'coverage/coverage-final.json',
  JSON.stringify(Object.assign({}, ...reports)),
)
