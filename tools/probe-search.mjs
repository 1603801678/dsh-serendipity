// 搜索端点探测：插件若能自己搜（而不只是抓给定 URL），「最新素材」才不依赖宿主的 web_search。
// 各站搜索接口形状不同、且都可能在无预警下变更，所以这里只做可达性验证，不做封装。
const targets = [
  ['https://api.bilibili.com/x/web-interface/search/type?search_type=article&keyword=%E5%8D%A1%E7%89%8C%E6%B8%B8%E6%88%8F&page=1', 'B站 专栏搜索 API'],
  ['https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=article&keyword=card', 'B站 wbi 搜索 API'],
  ['https://www.gcores.com/api/v2/search?keyword=%E5%8D%A1%E7%89%8C&type=article', '机核 搜索 API'],
  ['https://www.gcores.com/api/v2/articles?page=1&per_page=3', '机核 文章列表'],
  ['https://sspai.com/api/v1/search/article/page/get?offset=0&limit=3&keyword=%E6%96%B9%E6%B3%95', '少数派 搜索 API'],
  ['https://sspai.com/api/v1/article/index/page/get?limit=3&offset=0', '少数派 文章列表'],
  ['https://api.crossref.org/works?query=serendipity&rows=2&select=title,DOI,issued,URL', 'Crossref select 精简'],
  ['https://api.openalex.org/works?search=far+transfer&per-page=2&select=display_name,publication_date,doi', 'OpenAlex select 精简'],
  ['https://api.stackexchange.com/2.3/questions?order=desc&sort=votes&tagged=game-design&site=gamedev&pagesize=3&filter=!)rCcJHB2Gg_Irq6', 'StackExchange gamedev'],
  ['https://export.arxiv.org/api/query?search_query=cat:cs.AI+AND+all:%22creativity%22&max_results=2&sortBy=submittedDate&sortOrder=descending', 'arXiv 分类+短语'],
  ['https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=32908130&retmode=json', 'PubMed 摘要 API'],
  ['https://api.github.com/search/code?q=serendipity+in:file&per_page=2', 'GitHub 代码搜索(需鉴权?)'],
  ['https://api.github.com/search/repositories?q=created:%3E2026-01-01+deckbuilder&per_page=3&sort=stars', 'GitHub 按时间+星'],
  ['https://en.wikipedia.org/w/api.php?action=query&list=random&rnlimit=2&format=json', 'wikipedia API (en)'],
  ['https://zh.moegirl.org.cn/api.php?action=query&list=random&rnlimit=2&format=json', '萌娘百科 API'],
  ['https://www.gstonegames.com/bbs/forum-7-1.html', '集石 桌游版块列表'],
  ['https://www.gstonegames.com/search?q=%E9%9A%8F%E6%9C%BA', '集石 搜索'],
  ['https://search.bilibili.com/article?keyword=%E6%B8%B8%E6%88%8F%E6%9C%BA%E5%88%B6', 'B站 专栏搜索页(HTML)'],
]

const timeoutMs = 9000
const CONCURRENCY = 5
const out = []
const queue = [...targets]
async function one([url, name]) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; dsh-serendipity-source-probe/0.1)',
        accept: 'application/json,text/html,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    const text = await response.text()
    // 有内容的探测才有意义：报字节数 + 头 120 字符，好判断它是不是一个真结果集
    out.push(`${response.ok ? '✅' : '❌'} ${name.padEnd(24)} HTTP ${response.status} ${String(text.length).padStart(7)}B ${Date.now() - started}ms  ${text.slice(0, 120).replace(/\s+/g, ' ')}`)
  } catch (error) {
    out.push(`❌ ${name.padEnd(24)} ${error?.name === 'AbortError' ? '超时' : String(error?.message ?? error)}`)
  } finally {
    clearTimeout(timer)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length > 0) await one(queue.shift())
}))
console.log(out.sort().join('\n'))
