export function formatAgentDisplayName(rawName: string): string {
  let s = rawName.trim();
  s = s.replace(/\.json$/i, '');
  s = s.replace(/\.canvas272$/i, '');
  s = s.replace(/\.canvas$/i, '');
  s = s.replace(/\.agentnodes-graph$/i, '');
  return s;
}

const REPORT_AGENT_ISO_SUFFIX = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/;

function firstVisualToken(s: string): string {
  const t = s.trim();
  const i = t.search(/\s/);
  return i === -1 ? t : t.slice(0, i).trim();
}

export function formatAgentToolbarTitle(
  rawName: string,
  metadata?: { displayTitle?: string } | null,
): string {
  const fromMeta = metadata?.displayTitle?.trim();
  if (fromMeta) return fromMeta;

  const s = formatAgentDisplayName(rawName);
  const clinicalMarker = '_clinical_Report-agent-';
  const clinicalIdx = s.indexOf(clinicalMarker);
  if (clinicalIdx > 0) {
    const sessionSlug = s.slice(0, clinicalIdx).replace(/-/g, ' ').trim();
    if (sessionSlug) return sessionSlug;
  }

  if (s.startsWith('Report-agent-')) {
    const withoutPrefix = s.slice('Report-agent-'.length).replace(REPORT_AGENT_ISO_SUFFIX, '');
    const spaced = withoutPrefix.replace(/-/g, ' ').trim();
    if (spaced) return firstVisualToken(spaced);
  }

  return formatAgentDisplayName(rawName);
}

export function formatAgentSidebarLabel(rawName: string): string {
  let s = formatAgentDisplayName(rawName).replace(/\\/g, '/');
  if (s.includes('/')) {
    s = (s.split('/').pop() ?? s).trim();
  }
  if (s.startsWith('Report-agent-') || s.includes('_clinical_Report-agent-')) {
    return formatAgentToolbarTitle(s, null);
  }
  
  s = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  
  const yearMatch = s.search(/\s+\d{4}\b/);
  if (yearMatch > 0) {
    s = s.slice(0, yearMatch).trim();
  }
  
  return s || formatAgentDisplayName(rawName);
}
