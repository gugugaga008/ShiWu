/** 界面与常见姓名用字的拼音，供命令面板匹配汉字、全拼和缩写。 */
const CHAR: Record<string, string> = {
  人: 'ren', 员: 'yuan', 列: 'lie', 表: 'biao', 添: 'tian', 加: 'jia',
  管: 'guan', 理: 'li', 规: 'gui', 则: 'ze', 设: 'she', 置: 'zhi',
  时: 'shi', 间: 'jian', 线: 'xian', 统: 'tong', 计: 'ji',
  概: 'gai', 览: 'lan', 主: 'zhu', 题: 'ti', 浅: 'qian', 色: 'se', 深: 'shen',
  跟: 'gen', 随: 'sui', 系: 'xi', 画: 'hua', 面: 'mian', 源: 'yuan',
  默: 'mo', 认: 'ren', 启: 'qi', 动: 'dong', 自: 'zi', 开: 'kai', 机: 'ji',
  手: 'shou', 扫: 'sao', 码: 'ma', 预: 'yu', 性: 'xing', 能: 'neng',
  触: 'chu', 发: 'fa', 快: 'kuai', 照: 'zhao', 邮: 'you', 件: 'jian',
  通: 'tong', 知: 'zhi', 老: 'lao', 板: 'ban', 领: 'ling', 导: 'dao',
  同: 'tong', 事: 'shi', 白: 'bai', 名: 'ming', 单: 'dan', 忽: 'hu', 略: 'lve',
  本: 'ben', 片: 'pian', 视: 'shi', 频: 'pin', 文: 'wen', 现: 'xian',
  场: 'chang', 采: 'cai', 集: 'ji', 监: 'jian', 控: 'kong', 警: 'jing',
  页: 'ye', 命: 'ming', 令: 'ling', 搜: 'sou', 索: 'suo', 分: 'fen',
  组: 'zu', 好: 'hao', 友: 'you', 王: 'wang', 李: 'li', 张: 'zhang',
  刘: 'liu', 陈: 'chen', 杨: 'yang', 黄: 'huang', 赵: 'zhao', 吴: 'wu',
  周: 'zhou', 徐: 'xu', 孙: 'sun', 马: 'ma', 朱: 'zhu', 胡: 'hu',
  郭: 'guo', 何: 'he', 高: 'gao', 林: 'lin', 罗: 'luo', 郑: 'zheng',
  梁: 'liang', 谢: 'xie', 宋: 'song', 唐: 'tang', 许: 'xu', 邓: 'deng',
  冯: 'feng', 韩: 'han', 曹: 'cao', 彭: 'peng', 曾: 'zeng', 肖: 'xiao',
  田: 'tian', 董: 'dong', 袁: 'yuan', 潘: 'pan', 于: 'yu', 蒋: 'jiang',
  蔡: 'cai', 余: 'yu', 杜: 'du', 叶: 'ye', 程: 'cheng', 魏: 'wei',
  苏: 'su', 吕: 'lv', 丁: 'ding', 任: 'ren', 沈: 'shen', 姚: 'yao',
  卢: 'lu', 姜: 'jiang', 崔: 'cui', 钟: 'zhong', 谭: 'tan', 陆: 'lu',
  汪: 'wang', 范: 'fan', 金: 'jin', 石: 'shi', 廖: 'liao', 贾: 'jia',
  夏: 'xia', 韦: 'wei', 傅: 'fu', 方: 'fang', 邹: 'zou',
  孟: 'meng', 熊: 'xiong', 秦: 'qin', 邱: 'qiu', 江: 'jiang', 尹: 'yin',
  薛: 'xue', 闫: 'yan', 段: 'duan', 雷: 'lei', 侯: 'hou', 龙: 'long',
  史: 'shi', 陶: 'tao', 黎: 'li', 贺: 'he', 顾: 'gu', 毛: 'mao',
  郝: 'hao', 龚: 'gong', 邵: 'shao', 万: 'wan', 钱: 'qian', 严: 'yan',
  覃: 'qin', 武: 'wu', 戴: 'dai', 莫: 'mo', 孔: 'kong', 向: 'xiang',
  汤: 'tang', 三: 'san', 四: 'si', 五: 'wu', 总: 'zong', 工: 'gong',
  经: 'jing', 客: 'ke', 户: 'hu', 一: 'yi', 二: 'er',
}

export function pinyinOf(text: string): { full: string; initials: string } {
  const parts: string[] = []
  for (const ch of text) {
    const py = CHAR[ch]
    if (py) parts.push(py)
  }
  return { full: parts.join(''), initials: parts.map((part) => part[0] ?? '').join('') }
}

export function searchTokens(label: string, extra: string[] = []): string[] {
  const out: string[] = []
  for (const text of [label, ...extra]) {
    const t = text.trim()
    if (!t) continue
    const { full, initials } = pinyinOf(t)
    out.push(t, full, initials)
  }
  return [...new Set(out.filter(Boolean))]
}

export function searchValue(label: string, extra: string[] = []): string {
  return searchTokens(label, extra).join(' ')
}
