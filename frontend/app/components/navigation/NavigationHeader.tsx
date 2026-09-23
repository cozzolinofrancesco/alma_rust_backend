'use client';

import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, ChevronDown, CircleHelp, FolderOpen, Home, LayoutGrid, RefreshCw, Search, Settings, X } from 'lucide-react';
import type { TranslateFn } from '../../contexts/LanguageContext';
import type { RecentAgent, RecentProject } from '../../lib/recentItemsManager';
import { getCleanProjectName } from '../../lib/project-constants';
import { formatAgentSidebarLabel } from '../../canvas-272/lib/agentDisplayName';
import { filterNavigationItems, getNavigationGroup, isNavigationItemActive, navigationGroups, type NavigationGroup } from './navigationItems';
import styles from './NavigationHeader.module.css';

type Panel = 'tools' | 'projects' | 'help' | 'settings';
type PanelContent = (close: () => void) => ReactNode;

interface NavigationHeaderProps {
  pathname: string | null;
  t: TranslateFn;
  projectId?: string;
  projectName: string;
  projects: RecentProject[];
  agents: RecentAgent[];
  refreshingProjects: boolean;
  onSelectProject: (project: RecentProject) => void;
  onSelectAgent: (agent: RecentAgent) => void;
  onRefreshProjects: () => void;
  onSct272Click: (event: MouseEvent<HTMLAnchorElement>) => void;
  voiceControl: PanelContent;
  helpContent: PanelContent;
  settingsContent: PanelContent;
  uploadContent: PanelContent;
}

export default function NavigationHeader({
  pathname, t, projectId, projectName, projects, agents, refreshingProjects,
  onSelectProject, onSelectAgent, onRefreshProjects, onSct272Click,
  voiceControl, helpContent, settingsContent, uploadContent,
}: NavigationHeaderProps) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [group, setGroup] = useState<NavigationGroup>(() => getNavigationGroup(pathname));
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const groupSelectId = useId();
  const expanded = panel !== null;
  const panelTitle = panel ? t(`navigation.${panel}`) : undefined;

  const closePanel = () => {
    if (!panel) return;
    setPanel(null);
    setQuery('');
    openerRef.current?.focus();
  };

  const togglePanel = (nextPanel: Panel, trigger: HTMLButtonElement, nextGroup?: NavigationGroup) => {
    openerRef.current = trigger;
    setQuery('');
    if (nextPanel === 'tools') setGroup(nextGroup ?? getNavigationGroup(pathname));
    setPanel((current) => current === nextPanel && (!nextGroup || nextGroup === group) ? null : nextPanel);
  };

  useEffect(() => {
    setPanel(null);
    setQuery('');
    setGroup(getNavigationGroup(pathname));
  }, [pathname]);

  useEffect(() => {
    if (!expanded) return;
    const updatePosition = () => {
      const bottom = Math.max(0, barRef.current?.getBoundingClientRect().bottom ?? 0);
      rootRef.current?.style.setProperty('--navigation-top', `${bottom}px`);
    };
    updatePosition();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    if (barRef.current) observer?.observe(barRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbarWidth > 0 && document.documentElement.clientWidth > 0) {
      document.body.style.paddingRight = `${parseFloat(getComputedStyle(document.body).paddingRight || '0') + scrollbarWidth}px`;
    }
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setPanel(null);
        setQuery('');
        openerRef.current?.focus();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
      ) ?? []).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !rootRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !rootRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
    };
  }, [expanded]);

  useEffect(() => {
    if (panel) (searchRef.current ?? closeRef.current)?.focus();
  }, [panel]);

  const selectGroup = (nextGroup: NavigationGroup) => {
    setGroup(nextGroup);
    setQuery('');
  };
  const toolItems = filterNavigationItems(query, t).filter((item) => query.trim() || (item.group === group && item.href !== '/'));
  const projectQuery = query.trim().toLocaleLowerCase();
  const filteredProjects = projects.filter((project) => getCleanProjectName(project.name).toLocaleLowerCase().includes(projectQuery));
  const projectAgents = agents.filter((agent) => projectId && agent.projectId === projectId);

  return (
    <div ref={rootRef} className={styles.shell} role={expanded ? 'dialog' : undefined} aria-modal={expanded ? true : undefined} aria-label={panelTitle}>
      {expanded && <div className={styles.backdrop} aria-hidden="true" onPointerDown={closePanel} data-testid="navigation-backdrop" />}
      <nav ref={barRef} className={styles.bar} aria-label={t('navigation.main')}>
        <button
          type="button" className={`${styles.trigger} ${styles.projectTrigger}`}
          onClick={(event) => togglePanel('projects', event.currentTarget)}
          aria-expanded={panel === 'projects'} aria-controls={panel === 'projects' ? panelId : undefined}
          aria-haspopup="dialog" title={projectName} data-tour="nav-project-switcher"
        >
          <FolderOpen size={19} aria-hidden="true" />
          <span className={styles.projectName}>{projectName}</span>
          <ChevronDown size={15} aria-hidden="true" className={panel === 'projects' ? styles.chevronOpen : undefined} />
        </button>
        <button
          type="button" className={styles.trigger} onClick={(event) => togglePanel('tools', event.currentTarget)}
          aria-expanded={panel === 'tools'} aria-controls={panel === 'tools' ? panelId : undefined}
          aria-haspopup="dialog" data-tour="nav-tools"
        >
          <LayoutGrid size={19} aria-hidden="true" />
          <span>{t('navigation.tools')}</span>
          <ChevronDown size={15} aria-hidden="true" className={panel === 'tools' ? styles.chevronOpen : undefined} />
        </button>
        <div className={styles.utilities}>
          {voiceControl(closePanel)}
          <button
            type="button" className={styles.iconButton} title={t('navigation.help')} aria-label={t('navigation.help')}
            onClick={(event) => togglePanel('help', event.currentTarget)} aria-expanded={panel === 'help'}
            aria-controls={panel === 'help' ? panelId : undefined} aria-haspopup="dialog" data-tour="nav-questions"
          ><CircleHelp size={20} aria-hidden="true" /></button>
          <button
            type="button" className={styles.iconButton} title={t('settings.title')} aria-label={t('settings.title')}
            onClick={(event) => togglePanel('settings', event.currentTarget)} aria-expanded={panel === 'settings'}
            aria-controls={panel === 'settings' ? panelId : undefined} aria-haspopup="dialog"
          ><Settings size={20} aria-hidden="true" /></button>
        </div>
      </nav>
      {panel && (
        <section id={panelId} className={styles.panel} aria-label={panelTitle}>
          <div className={styles.panelTop}>
            <h2>{panelTitle}</h2>
            {(panel === 'tools' || panel === 'projects') && (
              <div className={styles.search}>
                <Search size={18} aria-hidden="true" />
                <input
                  ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
                  placeholder={t(panel === 'tools' ? 'navigation.searchTools' : 'navigation.searchProjects')}
                  aria-label={t(panel === 'tools' ? 'navigation.searchTools' : 'navigation.searchProjects')}
                  autoComplete="off"
                />
              </div>
            )}
            <button ref={closeRef} type="button" className={styles.iconButton} onClick={closePanel} aria-label={t('navigation.close')} title={t('navigation.close')}>
              <X size={21} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.panelBody}>
            {panel === 'tools' && (
              <div className={styles.toolsLayout}>
                <nav className={styles.categories} aria-label={t('navigation.categories')}>
                  <Link href="/" className={styles.homeLink} onClick={closePanel} aria-current={pathname === '/' ? 'page' : undefined} data-tour="nav-home">
                    <Home size={18} aria-hidden="true" /><span>{t('nav.home')}</span>
                  </Link>
                  <div className={styles.categoryList}>
                    {navigationGroups.map((category) => (
                      <button key={category} type="button" aria-pressed={!query.trim() && category === group} className={styles.category} onClick={() => selectGroup(category)}>
                        {t(`navigation.groups.${category}`)}
                      </button>
                    ))}
                  </div>
                  <label className={styles.categorySelect} htmlFor={groupSelectId}>
                    <span className={styles.srOnly}>{t('navigation.categories')}</span>
                    <select id={groupSelectId} value={group} onChange={(event) => selectGroup(event.target.value as NavigationGroup)}>
                      {navigationGroups.map((category) => <option key={category} value={category}>{t(`navigation.groups.${category}`)}</option>)}
                    </select>
                  </label>
                </nav>
                <div className={styles.destinations}>
                  <h3>{query.trim() ? t('navigation.results') : t(`navigation.groups.${group}`)}</h3>
                  {toolItems.length === 0 && <p className={styles.empty} role="status">{t('navigation.noResults')}</p>}
                  <ul className={styles.list}>
                    {toolItems.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href} className={styles.row} data-tour={item.tour}
                          aria-current={isNavigationItemActive(item, pathname) ? 'page' : undefined}
                          onClick={(event) => {
                            if (item.href === '/SCT272') onSct272Click(event);
                            closePanel();
                          }}
                        >
                          <span>{t(item.labelKey)}</span>
                          {isNavigationItemActive(item, pathname) && <Check size={17} aria-label={t('nav.active')} />}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {!query.trim() && group === 'data' && uploadContent(closePanel)}
                </div>
              </div>
            )}
            {panel === 'projects' && (
              <div className={styles.projectsLayout}>
                <section>
                  <h3>{t('nav.projects')}</h3>
                  {filteredProjects.length === 0 && <p className={styles.empty} role="status">{t(query.trim() ? 'navigation.noResults' : 'nav.noRecentProjects')}</p>}
                  <ul className={styles.list}>
                    {filteredProjects.map((project) => (
                      <li key={project.id}>
                        <button type="button" className={styles.row} aria-current={project.id === projectId ? 'true' : undefined} onClick={() => { closePanel(); onSelectProject(project); }}>
                          <span>{getCleanProjectName(project.name)}</span>
                          {project.id === projectId && <Check size={17} aria-label={t('nav.active')} />}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className={styles.actions}>
                    <Link href="/projects" onClick={closePanel} className={styles.textLink}>{t('nav.viewAllProjects')}</Link>
                    <button type="button" className={styles.iconButton} onClick={onRefreshProjects} disabled={refreshingProjects} aria-label={t('nav.refreshProjects')} title={t('nav.refreshProjects')}>
                      <RefreshCw size={18} className={refreshingProjects ? styles.spinning : undefined} aria-hidden="true" />
                    </button>
                  </div>
                </section>
                <section>
                  <h3>{t('navigation.recentAgents')}</h3>
                  {projectAgents.length === 0 && <p className={styles.empty}>{t(projectId ? 'nav.noRecentAgents' : 'project.selectProject')}</p>}
                  <ul className={styles.list}>
                    {projectAgents.map((agent) => (
                      <li key={agent.id}><button type="button" className={styles.row} onClick={() => { closePanel(); onSelectAgent(agent); }}>{formatAgentSidebarLabel(agent.name)}</button></li>
                    ))}
                  </ul>
                  <Link href="/ai-agents" onClick={closePanel} className={styles.textLink}>{t('nav.viewAllAgents')}</Link>
                </section>
              </div>
            )}
            {panel === 'help' && helpContent(closePanel)}
            {panel === 'settings' && settingsContent(closePanel)}
          </div>
        </section>
      )}
    </div>
  );
}