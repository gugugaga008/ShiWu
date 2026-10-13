// 环境变量取值：统一 SHIWU_* 前缀
'use strict'
function env(...names) {
  for (const n of names) {
    const v = process.env[n]
    if (v != null && v !== '') return v
  }
  return undefined
}
module.exports = { env }
