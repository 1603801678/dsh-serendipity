// 素材来源可达性探测。
//
// 背景：`lib/fetch.js` 里的 REACHABLE_HINTS 是一份**静态**清单，写死在代码里。
// 2026-10-10 的真实会话证明它会过时：清单里写「知乎可达」，而实际
// `zhuanlan.zhihu.com` 403；用户点名要的 NGA / 贴吧 / B站专栏 一个都不在清单里；
// 会话里唯一真正好用的论坛来源（集石 gstonegames）是靠 web_search 现找出来的。
//
// 这个脚本就是让「清单」变成可再生的：跑一遍，把结果贴回 `lib/fetch.js`。
// 只发 GET，不写任何东西；并发受限，避免把本机网络打满。
//
// 用法：node tools/probe-sources.mjs [--timeout 8000] [--json]

const args = process.argv.slice(2)
const timeoutMs = Number(args[args.indexOf('--timeout') + 1]) || 8000
const asJson = args.includes('--json')

/** 候选来源。type 只是给人看的分类，方便决定保留哪些。 */
const CANDIDATES = [
  // —— 中文游戏设计（会话里证明有效的一批）——
  ['https://www.gcores.com/articles/189886', '机核 文章页', '游戏设计'],
  ['https://www.gcores.com/', '机核 首页', '游戏设计'],
  ['https://www.gstonegames.com/bbs/discuss-7-62349-1.html', '集石 桌游社区帖', '游戏设计'],
  ['https://www.gameres.com/872495.html', '游资网 GameRes', '游戏设计'],
  ['https://game.3loumao.org/344711047', '3楼猫 设计复盘', '游戏设计'],
  ['https://www.leikeji.com/article/73129', '雷科技 访谈', '游戏设计'],
  ['https://www.gamelook.com.cn/', '游戏大观 GameLook', '游戏设计'],
  ['https://indienova.com/', 'indienova 独立游戏', '游戏设计'],
  ['https://www.yystv.cn/', '游研社', '游戏设计'],
  ['https://www.bilibili.com/read/cv1000000', 'B站专栏 文章页', '游戏设计'],
  ['https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD', 'B站 API', '游戏设计'],
  ['https://bbs.nga.cn/', 'NGA 论坛', '游戏设计'],
  ['https://ngabbs.com/read.php?tid=45125102', 'NGA 帖子', '游戏设计'],
  ['https://tieba.baidu.com/f?kw=%E5%8D%A1%E7%89%8C%E6%B8%B8%E6%88%8F', '百度贴吧 吧页', '游戏设计'],
  ['https://jump2.bdimg.com/p/4979216691', '百度贴吧 镜像', '游戏设计'],

  // —— 中文通用/科普/工具（跨领域素材来源）——
  ['https://sspai.com/', '少数派', '通用'],
  ['https://www.zhihu.com/', '知乎 首页', '通用'],
  ['https://zhuanlan.zhihu.com/p/2068247066560798889', '知乎 专栏页', '通用'],
  ['https://www.guokr.com/', '果壳', '科普'],
  ['https://www.kepu.net.cn/', '中国科普博览', '科普'],
  ['https://blog.sciencenet.cn/', '科学网 博客', '科普'],
  ['https://huanqiukexue.com/', '环球科学', '科普'],
  ['https://baike.baidu.com/item/%E7%86%B5', '百度百科 词条', '百科'],
  ['https://www.ruanyifeng.com/blog/', '阮一峰 博客', '通用'],

  // —— 海外科普/文化（远域素材的富矿）——
  ['https://www.quantamagazine.org/', 'Quanta Magazine', '科学'],
  ['https://nautil.us/', 'Nautilus', '科学'],
  ['https://aeon.co/', 'Aeon', '思想'],
  ['https://www.atlasobscura.com/', 'Atlas Obscura', '生活观察'],
  ['https://www.smithsonianmag.com/', 'Smithsonian', '文化'],
  ['https://99percentinvisible.org/', '99% Invisible', '设计'],
  ['https://themarginalian.org/', 'The Marginalian', '思想'],
  ['https://phys.org/', 'Phys.org', '科学'],
  ['https://www.sciencedaily.com/', 'ScienceDaily', '科学'],
  ['https://news.mit.edu/', 'MIT News', '科学'],
  ['https://www.nature.com/', 'Nature', '科学'],

  // —— 结构化 API（比网页更省 token，且自带日期/摘要）——
  ['https://export.arxiv.org/api/query?search_query=all:%22far%20transfer%22&max_results=3&sortBy=submittedDate&sortOrder=descending', 'arXiv 精确短语', 'API'],
  ['https://api.crossref.org/works?query=structural+analogy&rows=3&sort=published&order=desc', 'Crossref 按时间排序', 'API'],
  ['https://api.openalex.org/works?search=analogical+transfer&per-page=3&sort=publication_date:desc', 'OpenAlex', 'API'],
  ['https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=design%20pattern&site=softwareengineering&pagesize=3', 'Stack Exchange API', 'API'],
  ['https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=serendipity&retmax=3&retmode=json', 'PubMed E-utils', 'API'],
  ['https://api.github.com/search/repositories?q=game+design&per_page=2', 'GitHub 仓库搜索', 'API'],

  // —— 已知不可达（留作对照，别删，它们会变）——
  ['https://zh.wikipedia.org/api/rest_v1/page/random/summary', 'wikipedia (zh)', '已知不可达'],
  ['https://news.ycombinator.com/', 'Hacker News', '已知不可达'],
  ['https://www.reddit.com/r/gamedesign/top.json?limit=3', 'Reddit JSON', '已知不可达'],
  ['https://duckduckgo.com/html/?q=game+design', 'DuckDuckGo', '已知不可达'],
  ['https://archive.org/stream/0_20240430_202404/', 'archive.org', '已知不可达'],
]

/** 并发上限：本机网络与目标站都不该被一次探测打满。 */
const CONCURRENCY = 6

const results = []

async function probe([url, name, kind]) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; dsh-serendipity-source-probe/0.1)',
        accept: 'text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    const text = await response.text()
    results.push({
      kind,
      name,
      url,
      ok: response.ok,
      status: response.status,
      length: text.length,
      ms: Date.now() - started,
    })
  } catch (error) {
    results.push({
      kind,
      name,
      url,
      ok: false,
      status: 0,
      error: error?.name === 'AbortError' ? `超时 >${timeoutMs}ms` : String(error?.message ?? error),
      ms: Date.now() - started,
    })
  } finally {
    clearTimeout(timer)
  }
}

const queue = [...CANDIDATES]
const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length > 0) await probe(queue.shift())
})
await Promise.all(workers)

results.sort((a, b) => (a.kind === b.kind ? Number(b.ok) - Number(a.ok) : a.kind.localeCompare(b.kind)))

if (asJson) {
  console.log(JSON.stringify(results, null, 2))
} else {
  let lastKind = ''
  for (const entry of results) {
    if (entry.kind !== lastKind) {
      console.log(`\n## ${entry.kind}`)
      lastKind = entry.kind
    }
    const mark = entry.ok ? '✅' : '❌'
    const detail = entry.ok
      ? `HTTP ${entry.status}  ${String(entry.length).padStart(7)} 字节  ${entry.ms}ms`
      : `HTTP ${entry.status || '-'}  ${entry.error}`
    console.log(`${mark} ${entry.name.padEnd(20)} ${detail.padEnd(34)} ${entry.url}`)
  }
  const reachable = results.filter(entry => entry.ok).length
  console.log(`\n可达 ${reachable} / ${results.length}`)
}
