// 网络可达性探测：插件若想「自己联网」，需要确认哪些站点在宿主进程里真的抓得到。
// 只做 HEAD/GET 小请求，不写入任何东西。
const targets = [
  ['https://registry.npmjs.org/-/ping', 'npm registry'],
  ['https://zh.wikipedia.org/api/rest_v1/page/random/summary', 'wikipedia (zh)'],
  ['https://en.wikipedia.org/api/rest_v1/page/random/summary', 'wikipedia (en)'],
  ['https://news.ycombinator.com/', 'Hacker News'],
  ['https://www.reddit.com/r/gamedesign/top.json?limit=3', 'Reddit JSON'],
  ['https://api.github.com/search/repositories?q=game+design&per_page=1', 'GitHub API'],
  ['https://duckduckgo.com/html/?q=game+design', 'DuckDuckGo HTML'],
  ['https://export.arxiv.org/api/query?search_query=all:analogy&max_results=1', 'arXiv API'],
  ['https://api.crossref.org/works?query=analogy&rows=1', 'Crossref API'],
  ['https://www.zhihu.com/', '知乎'],
  ['https://sspai.com/', '少数派'],
  ['https://www.gcores.com/', '机核'],
]

const timeoutMs = 12000
for (const [url, name] of targets) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-serendipity-connectivity-probe/0.1' },
    })
    const text = await response.text()
    console.log(`✅ ${name.padEnd(18)} HTTP ${response.status}  ${String(text.length).padStart(7)} 字节  ${Date.now() - started}ms`)
  } catch (error) {
    const reason = error.name === 'AbortError' ? `超时 >${timeoutMs}ms` : error.message
    console.log(`❌ ${name.padEnd(18)} ${reason}`)
  } finally {
    clearTimeout(timer)
  }
}
