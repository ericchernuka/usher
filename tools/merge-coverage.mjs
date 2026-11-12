import { mkdir, readFile, writeFile } from 'node:fs/promises'

const packages = [
  'usher-core',
  'react-usher',
  'usher-cloudflare',
  'usher-plugin',
]

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
