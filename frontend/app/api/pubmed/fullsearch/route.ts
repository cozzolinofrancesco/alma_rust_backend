import { NextResponse } from 'next/server';
import xml2js from 'xml2js';

interface Author { name: string }
interface ArticleID { idtype: string; value: string }
interface Summary {
  title: string
  pubdate: string
  authors?: Author[]
  articleids?: ArticleID[]
}
interface ESummaryResult {
  uids: string[]
  [key: string]: Summary | string[]
}

async function runESearch(term: string, apiKey: string, retmax = 100, retstart = 0): Promise<{ idlist: string[], totalCount: number }> {
  const url =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` +
    `?db=pubmed` +
    `&term=${encodeURIComponent(term)}` +
    `&retmode=json` +
    `&retmax=${retmax}` +
    `&retstart=${retstart}` +
    (apiKey ? `&api_key=${apiKey}` : '')
  // Do NOT log the full URL — it carries the NCBI api_key (secret hygiene).
  console.log('🔍 | ESearch request (db=pubmed)')
  const res = await fetch(url)
  const json = await res.json()
  const idlist = (json?.esearchresult?.idlist as string[]) || []
  const totalCount = parseInt(json?.esearchresult?.count || '0')
  console.log(`✅ | ESearch found ${idlist.length} IDs (${totalCount} total available)`)
  return { idlist, totalCount }
}

function extractTitle(ref: string): string {
  const m1 = ref.match(/^[^.]+\.\s*([^.]*)\./)
  if (m1?.[1]) return m1[1].trim()
  const m2 = ref.match(/^[^.]+\.\s*(.*)$/)
  return m2?.[1]?.trim() ?? ref
}

function extractAbstractText(abstractData: unknown): string {
  if (!abstractData) return ''

  if (Array.isArray(abstractData)) {
    return abstractData.map(part => {
      if (typeof part === 'string') return part
      if (typeof part === 'object' && part !== null) {
        if ('_' in part && typeof part._ === 'string') return part._
        if ('$' in part && typeof part.$ === 'string') return part.$
        const textValues = Object.values(part).filter(v => typeof v === 'string')
        if (textValues.length > 0) return textValues.join(' ')
        return JSON.stringify(part)
      }
      return String(part)
    }).join(' ')
  } else if (typeof abstractData === 'object' && abstractData !== null) {
    if ('_' in abstractData && typeof abstractData._ === 'string') return abstractData._
    if ('$' in abstractData && typeof abstractData.$ === 'string') return abstractData.$
    const textValues = Object.values(abstractData).filter(v => typeof v === 'string')
    if (textValues.length > 0) return textValues.join(' ')
    return JSON.stringify(abstractData)
  } else {
    return String(abstractData)
  }
}

export async function GET(request: Request) {
  console.log('🚀 | ==== Starting fullsearch Route ====')
  // Request-scoped: a module-level array bled unresolved titles across users
  // and grew unbounded across the process lifetime (FE-LEAK-001).
  const missing: string[] = []
  const { searchParams } = new URL(request.url)
  const rawRef = searchParams.get('title')
  if (!rawRef) {
    console.log('❌ | Missing title parameter')
    return NextResponse.json({ error: 'Missing title parameter' }, { status: 400 })
  }

  const limit = Number(searchParams.get('limit') ?? 25)
  const offset = Number(searchParams.get('offset') ?? 0)
  const apiKey = process.env.PUBMED_API_KEY ?? ''
  console.log(`📖 | Searching for reference: "${rawRef}" (limit=${limit}, offset=${offset})`)

  let searchResult = await runESearch(rawRef, apiKey, limit, offset)
  let idlist = searchResult.idlist
  let totalCount = searchResult.totalCount

  if (idlist.length === 0) {
    console.log('⚠️ | ==== No IDs found, attempting fallback searches ====')
    const articleTitle = extractTitle(rawRef)
    const sanitized = articleTitle
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/-/g, '')
      .trim()

    console.log(`🔀 | Fallback: Title-only phrase search: "${sanitized}"[Title]`)
    searchResult = await runESearch(`"${sanitized}"[Title]`, apiKey, limit, offset)
    idlist = searchResult.idlist
    totalCount = searchResult.totalCount

    if (idlist.length === 0) {
      console.log('🔀 | Fallback: Broader search with sanitized title')
      searchResult = await runESearch(`"${sanitized}"`, apiKey, limit, offset)
      idlist = searchResult.idlist
      totalCount = searchResult.totalCount
      if (idlist.length === 0) {
        console.log('❌ | ==== All searches failed: no PMIDs found ====');
        missing.push(sanitized);
        console.log('ADDED: ', sanitized);
        return NextResponse.json({ error: 'No PMIDs found for provided title', missing, totalCount: 0 }, { status: 404 })
      }
    }
  }

  const esummaryUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
    `?db=pubmed` +
    `&id=${idlist.join(',')}` +
    `&retmode=json` +
    (apiKey ? `&api_key=${apiKey}` : '')
  // Do NOT log the full URL — it carries the NCBI api_key (secret hygiene).
  console.log('🔍 | ESummary request (db=pubmed)')
  const esumJson = await (await fetch(esummaryUrl)).json()
  console.log(`✅ | Retrieved summaries for ${idlist.length} PMIDs`)
  const summaries = idlist.map(id => (esumJson.result as ESummaryResult)[id] as Summary)

  const efetchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi` +
    `?db=pubmed` +
    `&id=${idlist.join(',')}` +
    `&retmode=xml` +
    (apiKey ? `&api_key=${apiKey}` : '')
  // Do NOT log the full URL — it carries the NCBI api_key (secret hygiene).
  console.log('🔍 | EFetch request (db=pubmed)')
  const efetchXml = await (await fetch(efetchUrl)).text()
  const parsedXml = await new xml2js.Parser({ explicitArray: false }).parseStringPromise(efetchXml)
  console.log(`✅ | Parsed XML for ${idlist.length} articles`)
  const articlesRaw = parsedXml.PubmedArticleSet.PubmedArticle
  const articles = Array.isArray(articlesRaw) ? articlesRaw : [articlesRaw]

  console.log('🔄 | ==== Merging data and checking for missing DOIs ====')
  const results = summaries.map((summary, i) => {
    const art = articles[i]
    let abstractText = ''

    if (art && art.MedlineCitation && art.MedlineCitation.Article) {
      const at = art.MedlineCitation.Article.Abstract?.AbstractText
      if (at) {
        abstractText = extractAbstractText(at)
      }
    } else {
      console.warn(`⚠️ | Missing article data for index ${i}, PMID: ${idlist[i]}`)
    }

    const doiObj = summary.articleids?.find(a => a.idtype.toLowerCase() === 'doi')
    const doi = doiObj?.value || ''
    const link = `https://pubmed.ncbi.nlm.nih.gov/${idlist[i]}/`

    if (!doi || doi.toLowerCase() === 'none') {
      console.log(`⚠️ | Missing DOI for: ${summary.title}`)
      missing.push(summary.title)
    }

    return {
      title: summary.title,
      pubdate: summary.pubdate,
      authors: summary.authors?.map(a => a.name) || [],
      doi,
      abstract: abstractText,
      pubMedLink: link,
    }
  })

  console.log('✅ | ==== MISSING ENTRIES ====')
  console.log(missing.length ? missing : 'None 🎉')

  return NextResponse.json({ results, missing, totalCount })
}