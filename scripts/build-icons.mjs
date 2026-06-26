import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import IconGen from 'icon-gen'
import sharp from 'sharp'

// Regenerate raster icons from build/icon.svg.
// Windows-only app: emit build/icon.png (electron-builder + window icon),
// resources/icon.png, and build/icon.ico. No .icns needed.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SVG = resolve(ROOT, 'build/icon.svg')
const BUILD_PNG = resolve(ROOT, 'build/icon.png')
const RES_PNG = resolve(ROOT, 'resources/icon.png')
const BUILD_DIR = resolve(ROOT, 'build')

const svg = await readFile(SVG)

const png1024 = await sharp(svg, { density: 384 }).resize(1024, 1024).png().toBuffer()
await mkdir(dirname(RES_PNG), { recursive: true })
await writeFile(BUILD_PNG, png1024)
await writeFile(RES_PNG, png1024)
console.log('wrote', BUILD_PNG)
console.log('wrote', RES_PNG)

const TMP = resolve(BUILD_DIR, '.icon-tmp')
await mkdir(TMP, { recursive: true })
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  const buf = await sharp(svg, { density: Math.ceil((size / 1024) * 384) })
    .resize(size, size)
    .png()
    .toBuffer()
  await writeFile(resolve(TMP, `${size}.png`), buf)
}

await IconGen(TMP, BUILD_DIR, {
  report: false,
  ico: { name: 'icon', sizes: [16, 24, 32, 48, 64, 128, 256] },
  favicon: false
})
console.log('wrote', resolve(BUILD_DIR, 'icon.ico'))

await rm(TMP, { recursive: true, force: true })
