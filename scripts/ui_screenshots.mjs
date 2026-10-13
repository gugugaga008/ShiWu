// 无头截图关键页面：node scripts/ui_screenshots.mjs [base]
import { createRequire } from 'module'
const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const base = process.argv[2] || 'http://127.0.0.1:7400/ui'
const pages = [
  ['overview', '/', 3000],
  ['sources', '/sources', 5000],
  ['capture', '/capture', 3500],
  ['people', '/people', 2500],
  ['rules', '/rules', 1500],
]
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', deviceScaleFactor: 1 })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.error('pageerror', e.message))
for (const [name, path, wait] of pages) {
  await page.goto(base + path, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(wait)
  await page.screenshot({ path: `out/ui/${name}.png`, fullPage: true })
  console.log('saved', `out/ui/${name}.png`)
}
await browser.close()
