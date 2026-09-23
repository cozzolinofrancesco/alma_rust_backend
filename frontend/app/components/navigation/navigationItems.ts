import { isSct272Pathname } from '../../lib/sct272-events';

export type NavigationGroup = 'workspace' | 'data' | 'validation' | 'documentation';

export interface NavigationItem {
  href: string;
  labelKey: string;
  group: NavigationGroup;
  tour?: string;
  aliases?: string[];
  activePaths?: string[];
}

export const navigationGroups: NavigationGroup[] = ['workspace', 'data', 'validation'];

export const navigationItems: NavigationItem[] = [
  { href: '/', labelKey: 'nav.home', group: 'workspace', tour: 'nav-home' },
  { href: '/projects', labelKey: 'nav.projects', group: 'workspace', tour: 'nav-projects' },
  {
    href: '/ai-agents', labelKey: 'nav.agentNodes', group: 'workspace', tour: 'nav-agent-builder',
    activePaths: ['/ai-agents', '/agentnodes'], aliases: ['agents'],
  },
  { href: '/SCT272', labelKey: 'nav.sct272', group: 'workspace', tour: 'nav-sct272' },
  {
    href: '/canvas-272', labelKey: 'nav.authoring', group: 'workspace',
    aliases: ['authoring', 'canvas', 'canvas 272'],
  },
  {
    href: '/upload', labelKey: 'nav.openDataStorage', group: 'data', tour: 'nav-add-data',
    aliases: ['add data', 'upload PDF', 'files'],
  },
  { href: '/rag-corpus', labelKey: 'nav.ragKnowledgeManager', group: 'data', aliases: ['knowledge', 'corpus'] },
  {
    href: '/validation', labelKey: 'nav.validationStudio', group: 'validation', tour: 'nav-validation',
    activePaths: ['/validation', '/claim-validation', '/proof-validation-flow', '/corpus-validation'],
  },
];

export function isNavigationItemActive(item: NavigationItem, pathname: string | null): boolean {
  if (!pathname) return false;
  if (item.href === '/SCT272') return isSct272Pathname(pathname);
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  return (item.activePaths ?? [item.href]).some((route) => (
    normalizedPath === route || (route !== '/' && normalizedPath.startsWith(`${route}/`))
  ));
}

export function getNavigationGroup(pathname: string | null): NavigationGroup {
  return navigationItems.find((item) => isNavigationItemActive(item, pathname))?.group ?? 'workspace';
}

export function filterNavigationItems(query: string, translate: (key: string) => string): NavigationItem[] {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return navigationItems.filter((item) => {
    const searchableText = normalize([translate(item.labelKey), item.href, ...(item.aliases ?? [])].join(' '));
    return terms.every((term) => searchableText.includes(term));
  });
}