/**
 * Networked fetch: bring material in from the web.
 *
 * The plugin's whole value is material, and a corpus frozen at install time goes
 * stale. But the host this runs on has a *partial* view of the network — a probe
 * found 机核 / 少数派 / 知乎 / GitHub / arXiv / Crossref reachable while
 * wikipedia, Hacker News, Reddit and DuckDuckGo all fail — so this layer must
 * treat unreachability as normal and report it plainly rather than pretending the
 * web is uniform.
 *
 * Two deliberate boundaries:
 *
 * 1. **Fetching is not ingesting.** This returns text plus a distillation demand.
 *    A web page becomes corpus material only after it has been reduced to a
 *    portable structure with a mechanism — that is the plugin's one non-negotiable
 *    quality rule, and a fetch tool that wrote pages straight into the library
 *    would flood it with exactly the "network information with little
 *    inspiration" the project set out to avoid.
 * 2. **Bounded.** Hard caps on bytes and output, http/https only, no redirects to
 *    other schemes, and no credentials. A tool the model can call cheaply must not
 *    be able to pull a 200 MB page into the context window.
 *
 * @module @1603801678/dsh-serendipity/fetch
 */

/** Hard timeout for one fetch. */
export const FETCH_TIMEOUT_MS = 20_000

/** Largest response body we will read, in bytes. */
export const MAX_BODY_BYTES = 400_000

/** Largest extract we hand to the model, in characters. */
export const MAX_EXTRACT_CHARS = 9000

/**
 * Sources verified reachable from this host, grouped by what they are good for.
 *
 * **Measured, not assumed.** Every entry below was checked by
 * `node tools/probe-sources.mjs` / `tools/probe-search.mjs` on 2026-10-10 (46 targets,
 * 32 reachable). The list is written down here because the cost of *not* writing it
 * down is measurable and was measured: in a real session 13 fetches produced 4 dead
 * `403`s, an index page mistaken for an article, and an API dump whose output budget
 * went entirely into `*_url` fields — and the agent ended up typing its own
 * reachability table into the project's design document, because the plugin forgot
 * what it had just learned.
 *
 * Two rules the session established that a flat host list cannot express:
 *
 * 1. **Reachability is per host, not per site.** `www.zhihu.com` answers 200 while
 *    `zhuanlan.zhihu.com` is 403; `www.gcores.com/` answers 200 but returns a nav
 *    dump, while `/articles/<id>` returns the actual article.
 * 2. **Prefer structured endpoints over pages.** They cost less, they carry dates,
 *    and they can be sorted newest-first — which is the only way to answer "materials
 *    from this week" for material that is frozen at install time.
 */
export const SOURCE_GROUPS = [
  {
    kind: '中文设计 / 社区（要具体页面，不要首页）',
    brief: '机核 /articles/<id>、B站 /read/cv<id>、集石 bbs/discuss-*（桌游社区，实践者讨论取舍）、3楼猫、游资网 gameres、雷科技、游研社、indienova',
    items: [
      '机核 文章页 https://www.gcores.com/articles/<id>（首页只是导航，无正文）',
      'B站 专栏 https://www.bilibili.com/read/cv<id>',
      '集石 桌游社区 https://www.gstonegames.com/bbs/discuss-<版块>-<帖>-1.html（实践者讨论取舍，密度高）',
      '3楼猫 https://game.3loumao.org/<id>｜游资网 https://www.gameres.com/<id>.html｜雷科技 https://www.leikeji.com/article/<id>',
      '游研社 https://www.yystv.cn/｜indienova https://indienova.com/',
    ],
  },
  {
    kind: '中文科普 / 通用（远域素材）',
    brief: '少数派、果壳、中国科普博览、科学网博客、环球科学、阮一峰博客',
    items: [
      '少数派 https://sspai.com/｜果壳 https://www.guokr.com/｜中国科普博览 https://www.kepu.net.cn/',
      '科学网 博客 https://blog.sciencenet.cn/｜环球科学 https://huanqiukexue.com/｜阮一峰 https://www.ruanyifeng.com/blog/',
    ],
  },
  {
    kind: '海外科普 / 文化（远域素材的富矿）',
    brief: 'Quanta、Nautilus、Aeon、99% Invisible、The Marginalian、Phys.org、ScienceDaily、MIT News、Nature',
    items: [
      'Quanta https://www.quantamagazine.org/｜Nautilus https://nautil.us/｜Aeon https://aeon.co/',
      '99% Invisible https://99percentinvisible.org/｜The Marginalian https://themarginalian.org/',
      'Phys.org https://phys.org/｜ScienceDaily https://www.sciencedaily.com/｜MIT News https://news.mit.edu/｜Nature https://www.nature.com/',
    ],
  },
  {
    kind: '可搜索的 API（比网页省 token，且能按时间倒序）',
    brief: 'B站专栏搜索、少数派文章列表、Crossref、OpenAlex、arXiv、PubMed、Stack Exchange、GitHub 仓库搜索',
    items: [
      'B站专栏搜索 https://api.bilibili.com/x/web-interface/search/type?search_type=article&keyword=<关键词>（中文专栏，实测可用）',
      '少数派文章列表 https://sspai.com/api/v1/article/index/page/get?limit=10&offset=0（带日期）',
      'Crossref https://api.crossref.org/works?query=<词>&rows=5&sort=published&order=desc&select=title,DOI,issued,URL',
      'OpenAlex https://api.openalex.org/works?search=<词>&per-page=5&sort=publication_date:desc&select=display_name,publication_date,doi',
      'arXiv https://export.arxiv.org/api/query?search_query=all:%22<短语>%22&max_results=5&sortBy=submittedDate&sortOrder=descending',
      'PubMed https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<词>&retmax=5&retmode=json',
      'Stack Exchange https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=<词>&site=<站点>',
      'GitHub https://api.github.com/search/repositories?q=<词>+created:%3E<YYYY-MM-DD>&per_page=5&sort=stars',
    ],
  },
  {
    kind: '随机入口（不依赖关键词，天然「远」）',
    brief: '萌娘百科随机词条 API（wikipedia 不可达，这是唯一实测可用的随机源）',
    items: [
      '萌娘百科 随机词条 https://zh.moegirl.org.cn/api.php?action=query&list=random&rnlimit=3&format=json（wikipedia 本机不可达，这是唯一实测可用的随机源）',
    ],
  },
]

/**
 * Query-syntax traps that each cost a real call before they were written down.
 *
 * These are not style preferences. An arXiv `search_query` with space-separated words
 * is parsed as `OR`, so the session's `all:card game mechanic design` matched 571,077
 * unrelated papers and the response was unusable; an unqualified Crossref/OpenAlex
 * query returns tens of kilobytes of metadata where `select=` returns under a
 * kilobyte of exactly the fields worth reading.
 */
export const QUERY_TRAPS = [
  'arXiv：空格关键词会被解析成 OR（实测返回 57 万条无关结果）。短语要写成 all:%22短语%22，多个条件用 +AND+ 连接。',
  'Crossref / OpenAlex：加 select= 只取需要的字段（实测响应从 53KB 降到 712 字节）；要「最新」就加 sort=published&order=desc / sort=publication_date:desc。',
  'GitHub：用 created:>YYYY-MM-DD 限定时间、sort=stars 排序，否则大量 0 star 空壳仓库会挤掉有内容的项目。',
  '搜索类接口（B站专栏）优先于抓站内搜索页：前者返回 JSON，后者返回几百 KB 的 HTML 外壳。',
]

/**
 * The two traps worth paying for in the tool description (which every request reads),
 * as opposed to all four, which the render carries when a fetch actually happens.
 */
export const QUERY_TRAPS_BRIEF = [
  'arXiv 的空格关键词会被解析成 OR，短语要写成 all:%22短语%22；Crossref/OpenAlex 加 select= 并可用 sort=published&order=desc 取最新。',
]

/** Every reachable source in one compact line per group (for the tool description). */
export const REACHABLE_BRIEF = SOURCE_GROUPS.map(group => `${group.brief}`).join('；')

/** Flat hint strings — the full table, used by the render. */
export const REACHABLE_HINTS = SOURCE_GROUPS.flatMap(group => group.items)

/**
 * Known NOT reachable from this host — stated with the verified status so the model
 * does not spend calls rediscovering it.
 *
 * `www.zhihu.com` is deliberately absent from this list: it answers 200 while
 * `zhuanlan.zhihu.com` is 403, which is exactly why this list is per host.
 */
export const UNREACHABLE_HINTS = [
  'bbs.nga.cn / ngabbs.com（403）',
  'tieba.baidu.com / jump2.bdimg.com（403，镜像同样不通）',
  'zhuanlan.zhihu.com（403；www.zhihu.com 本身可达）',
  'baike.baidu.com（403）',
  'atlasobscura.com / smithsonianmag.com（403）',
  'gamelook.com.cn（DNS 失败）',
  'archive.org（超时）',
  'wikipedia.org / news.ycombinator.com / reddit.com / duckduckgo.com（不可达）',
]

/** One compact line of "do not bother" for the tool description. */
export const UNREACHABLE_BRIEF = 'NGA、百度贴吧（含镜像，均 403）、zhuanlan.zhihu.com（但 www.zhihu.com 可达）、百度百科、'
  + 'atlasobscura、smithsonianmag、archive.org，以及 wikipedia / Hacker News / Reddit / DuckDuckGo'

/** Content types we refuse to treat as text. */
const BINARY_TYPES = ['application/pdf', 'application/octet-stream', 'application/zip', 'image/']

/**
 * Whether a response is binary and must not be handed over as prose.
 *
 * Split out as a pure function so the branch is testable without the network: the
 * failure it prevents (973 KB of `FlateDecode` streams returned as "text") is worth a
 * regression guard, and an untestable branch is a branch nobody notices breaking.
 *
 * @param {string} contentType - the response's content-type header.
 * @param {string} head - the first bytes of the body, decoded as latin1.
 * @returns {string | undefined} a short label of the binary kind, when it is binary.
 */
export function binaryKind(contentType, head) {
  const type = (contentType ?? '').toLowerCase()
  const hit = BINARY_TYPES.find(candidate => type.includes(candidate))
  if (hit !== undefined) return hit
  if (head.startsWith('%PDF')) return 'application/pdf'
  // A NUL byte in the first few bytes is not valid UTF-8 text.
  if (head.includes('\u0000')) return 'binary'
  return undefined
}

/** Collapse whitespace and strip the noise that inflates token cost. */
function normalizeText(raw) {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Keys that carry no material but a lot of characters.
 *
 * GitHub's repository search is the case that forced this: every result embeds some
 * forty `*_url` template fields, so a 9-item response spent its entire output budget
 * on URL patterns and the agent saw almost none of the descriptions it had asked for.
 * Stripping them is not cosmetic — it is the difference between a usable call and a
 * wasted one.
 */
const NOISE_KEY = /^(node_id|etag|avatar_url|gravatar_id|.*_url|.*_urls|url)$/

/** Recursively drop noise keys and empty containers from parsed JSON. */
function stripNoise(value, depth = 0) {
  if (Array.isArray(value)) {
    // Lists of results are the payload; keep every element.
    return value.map(entry => stripNoise(entry, depth + 1))
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (NOISE_KEY.test(key)) continue
      // One level of nesting is enough to be useful; beyond that an API response is
      // usually metadata about metadata, which is not material.
      out[key] = depth >= 3 ? summarizeDeep(entry) : stripNoise(entry, depth + 1)
    }
    return out
  }
  return value
}

/** Replace a deeply nested value with a marker rather than expanding it. */
function summarizeDeep(value) {
  if (Array.isArray(value)) return `[…${value.length} 项]`
  if (value !== null && typeof value === 'object') return '{…}'
  return value
}

/**
 * Whether an extract is the *shape* of a navigation/index page rather than an article.
 *
 * Measured, not guessed: fetching `https://www.gcores.com/` returned 223 KB of HTML
 * whose readable form was a few hundred short link labels and no prose, and the agent
 * read it as though it were content. The signal that separates the two cases is
 * **line length**: prose produces long lines, menus and listings produce many very
 * short ones.
 *
 * @param {string} text - extracted text.
 * @returns {{ index: boolean, medianLine: number, longLines: number }} the verdict and its evidence.
 */
export function looksLikeIndex(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length < 30) return { index: false, medianLine: lines.length, longLines: lines.length }
  const lengths = lines.map(line => line.length).sort((a, b) => a - b)
  const medianLine = lengths[Math.floor(lengths.length / 2)]
  const longLines = lines.filter(line => line.length >= 60).length
  // Both conditions matter: a long article with a big menu still has many long lines,
  // while a listing page is dominated by short ones.
  return { index: medianLine < 24 && longLines < lines.length * 0.15, medianLine, longLines }
}

/**
 * Strip a document down to readable text.
 *
 * Scripts, styles, SVG and comments carry no material but a lot of tokens; nav
 * boilerplate is left in place because a crude heuristic that removes too much is
 * worse than some noise (the model can ignore a menu, but cannot recover a
 * mechanism that was deleted). `looksLikeIndex` then *reports* the cases where that
 * choice went wrong, instead of silently handing over a menu as if it were an article.
 *
 * @param {string} body - raw response body.
 * @param {string} contentType - the response's content-type header.
 * @returns {{ text: string, kind: 'html' | 'json' | 'text' }} extracted content.
 */
export function extractReadable(body, contentType) {
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('json') || /^\s*[[{]/.test(body)) {
    // Pretty-print JSON so the model can actually read structure — after removing the
    // template-field noise that otherwise fills the whole output budget.
    try {
      return { text: JSON.stringify(stripNoise(JSON.parse(body)), null, 1), kind: 'json' }
    } catch {
      return { text: normalizeText(body), kind: 'json' }
    }
  }
  if (type.includes('html') || /<\s*(html|body|div|p|article)\b/i.test(body.slice(0, 4000))) {
    const text = body
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    return { text: normalizeText(text), kind: 'html' }
  }
  return { text: normalizeText(body), kind: 'text' }
}

/**
 * Fetch one URL and reduce it to bounded readable text.
 *
 * @param {string} url - absolute http(s) URL.
 * @param {{ timeoutMs?: number, maxBytes?: number, maxChars?: number }} [options] - caps.
 * @returns {Promise<{ ok: boolean, url: string, status?: number, kind?: string, text?: string, bytes?: number, truncated?: boolean, indexPage?: boolean, error?: string }>} outcome.
 */
export async function fetchReadable(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES
  const maxChars = options.maxChars ?? MAX_EXTRACT_CHARS

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, url, error: `不是合法 URL：${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url, error: `只支持 http/https，收到 ${parsed.protocol}` }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(parsed, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Some sites reject the default undici agent outright.
        'user-agent': 'Mozilla/5.0 (compatible; dsh-serendipity/0.2; +https://github.com/)',
        accept: 'text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    const contentType = response.headers.get('content-type') ?? ''
    const buffer = await response.arrayBuffer()
    // A PDF is not text. Returning its bytes as if they were prose burns the whole
    // context window on `FlateDecode` streams and yields nothing — measured on a
    // 973 KB PDF that came back as unreadable noise. Say what to do instead.
    const head = Buffer.from(buffer.slice(0, 8)).toString('latin1')
    const binary = binaryKind(contentType, head)
    if (binary !== undefined) {
      return {
        ok: false,
        url: parsed.toString(),
        status: response.status,
        error: `这是二进制内容（${contentType || binary}），本工具只返回文本。`
          + '请改用 HTML 版页面（例如 arXiv 用 /abs/ 而不是 /pdf/）或该站的 API 端点。',
      }
    }
    const truncatedBytes = buffer.byteLength > maxBytes
    const body = Buffer.from(buffer.slice(0, maxBytes)).toString('utf8')
    const { text, kind } = extractReadable(body, contentType)
    const truncatedChars = text.length > maxChars
    const sliced = text.slice(0, maxChars)
    // Reported, not auto-fixed: an index page is a legitimate result, it is just not
    // the one being asked for, and the fix (find the article URL) belongs to the model.
    const verdict = looksLikeIndex(sliced)
    return {
      ok: response.ok,
      url: parsed.toString(),
      status: response.status,
      kind,
      text: sliced,
      bytes: buffer.byteLength,
      truncated: truncatedBytes || truncatedChars,
      ...(verdict.index ? { indexPage: true } : {}),
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    }
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时（>${timeoutMs}ms）`
      : `网络失败：${error?.message ?? String(error)}（本机对部分站点不可达，见工具说明）`
    return { ok: false, url, error: reason }
  } finally {
    clearTimeout(timer)
  }
}
