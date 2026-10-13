// 无头截图管理界面的 8 个页面：node scripts/ui_screenshots_v11.mjs [base] [outdir]
// 默认输出到 docs/images（README 用图）。
// 本机 Playwright 浏览器版本与 apps/web 里的 playwright 不匹配时，用
//   SHIWU_CHROMIUM="/path/to/Google Chrome for Testing" node scripts/ui_screenshots_v11.mjs
// 指定可执行文件；或先跑 pnpm --dir apps/web exec playwright install chromium。
import { createRequire } from 'module'
import fs from 'fs'
const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const base = process.argv[2] || 'http://127.0.0.1:7400/ui'
const out = process.argv[3] || 'docs/images'
const executablePath = process.env.SHIWU_CHROMIUM
fs.mkdirSync(out, { recursive: true })

const pages = [
  ['overview', '/', 3000],
  ['sources', '/sources', 6000],
  ['capture', '/capture', 2500],
  ['people', '/people', 2000],
  ['rules', '/rules', 2000],
  ['timeline', '/timeline', 3000],
  ['stats', '/stats', 3500],
  ['settings', '/settings', 2000],
]

const browser = await chromium.launch(executablePath ? { executablePath } : {})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', deviceScaleFactor: 1 })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.error('pageerror', e.message))
page.on('console', (m) => m.type() === 'error' && console.error('console', m.text()))

for (const [name, path, wait] of pages) {
  await page.goto(base + path, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(wait)
  // 时间线整页过高，只截首屏；其余页面截全页
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: name !== 'timeline' })
  console.log('saved', `${out}/${name}.png`)

  if (name === 'timeline') {
    const thumb = page.locator('img[alt="快照"]').first()
    if (await thumb.count()) {
      await thumb.click()
      await page.waitForTimeout(1200)
      await page.screenshot({ path: `${out}/timeline_snapshot.png` })
      console.log('saved', `${out}/timeline_snapshot.png`)
      await page.keyboard.press('Escape')
    }
  }
}
await browser.close()
