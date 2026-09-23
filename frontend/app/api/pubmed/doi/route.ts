import { NextResponse } from 'next/server';
import xml2js from 'xml2js';

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

interface PubMedAuthor {
  name: string;
}

interface PubMedArticleId {
  idtype: string;
  value: string;
}

interface PubMedSummary {
  title?: string;
  pubdate?: string;
  authors?: PubMedAuthor[];
  articleids?: PubMedArticleId[];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const doi = searchParams.get('doi');
  if (!doi) {
    return NextResponse.json({ error: 'Missing DOI parameter' }, { status: 400 });
  }

  try {
    const apiKey = process.env.PUBMED_API_KEY;

    const esearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[DOI]&retmode=json${apiKey ? `&api_key=${apiKey}` : ''}`;
    const esearchResponse = await fetch(esearchUrl);
    const esearchJson = await esearchResponse.json();
    const idlist = esearchJson?.esearchresult?.idlist as string[] | undefined;
    if (!idlist || idlist.length === 0) {
      return NextResponse.json({ error: 'PMID not found for provided DOI' }, { status: 404 });
    }
    const ids = idlist.join(',');

    const esummaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids}&retmode=json${apiKey ? `&api_key=${apiKey}` : ''}`;
    const esummaryResponse = await fetch(esummaryUrl);
    const esummaryJson = await esummaryResponse.json();

    const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids}&retmode=xml${apiKey ? `&api_key=${apiKey}` : ''}`;
    const efetchResponse = await fetch(efetchUrl);
    const efetchXml = await efetchResponse.text();
    const parser = new xml2js.Parser({ explicitArray: false });
    const parsedEfetch = await parser.parseStringPromise(efetchXml);

    const articles = parsedEfetch?.PubmedArticleSet?.PubmedArticle;
    const abstractMap: { [pmid: string]: string } = {};
    if (articles) {
      const articlesArray = Array.isArray(articles) ? articles : [articles];
      articlesArray.forEach((articleObj: { MedlineCitation: { PMID: { _: string } | string; Article?: { Abstract?: { AbstractText: string | string[] | { _: string } | { _?: string }; }; }; }; }) => {
        try {
          const article = articleObj;
          if (!article || !article.MedlineCitation) {
            console.warn('⚠️ | Invalid article structure in DOI route');
            return;
          }

          const medline = article.MedlineCitation;
          const pmid = typeof medline.PMID === 'object' ? medline.PMID._ : medline.PMID;
          let abstractText = 'No abstract available.';
          const articleData = medline.Article;
          const abstractData = articleData?.Abstract;
          if (abstractData && abstractData.AbstractText) {
            abstractText = extractAbstractText(abstractData.AbstractText) || 'No abstract available.';
          }
          if (pmid) {
            abstractMap[pmid] = abstractText;
          }
        } catch (err) {
          console.warn('⚠️ | Error processing article in DOI route:', err);
        }
      });
    }

    const results: {
      title: string;
      pubdate: string;
      authors: string[];
      doi: string;
      abstract: string;
      downloadUrl: string;
    }[] = [];
    const resultJson = esummaryJson.result as { uids: string[] } & Record<string, PubMedSummary>;
    for (const pmid of resultJson.uids) {
      const summary = resultJson[pmid];
      const paperTitle = (summary.title || '').replace(
        /(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26ff]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])/g,
        ''
      ).trim();
      const pubdate = summary.pubdate || '';
      const authors = summary.authors ? summary.authors.map((author: PubMedAuthor) => author.name) : [];
      let doiValue = '';
      let pmcId = '';
      if (summary.articleids && Array.isArray(summary.articleids)) {
        const doiObj = summary.articleids.find((id: PubMedArticleId) => id.idtype === 'doi');
        doiValue = doiObj ? (doiObj.value || '').replace(
          /(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26ff]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])/g,
          ''
        ).trim() : '';
        const pmcObj = summary.articleids.find((id: PubMedArticleId) => id.idtype === 'pmc');
        if (pmcObj) {
          pmcId = pmcObj.value;
        }
      }
      const abstract = abstractMap[pmid] || '';
      const downloadUrl = pmcId ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcId}/pdf/` : '';

      results.push({
        title: paperTitle,
        pubdate,
        authors,
        doi: doiValue,
        abstract,
        downloadUrl,
      });
    }

    return NextResponse.json({ results });
  } catch (error: unknown) {
    let message = "Unknown error";
    if (error instanceof Error) message = error.message;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
