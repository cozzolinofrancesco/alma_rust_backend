'use client';

import { useSession } from 'next-auth/react';
import React, { useEffect, useRef, useState } from 'react';
import { REQUIRED_FOLDERS, getMissingFolders } from '../lib/project-constants';
import ProjectSetupLoadingBar from './ProjectSetupLoadingBar';
import ShareProjectModal from './ShareProjectModal';
import { usePageReady } from './SplashScreenWrapper';
import { useLanguage } from '../contexts/LanguageContext';

export type Collaborator = string | { emailAddress: string };

interface RawProjectData {
  id: string;
  name: string;
  displayName?: string;
  createdTime: string;
  modifiedTime?: string;
  collaborators?: (string | { emailAddress: string })[];
  owners?: { displayName?: string; emailAddress: string }[];
  almaRootName?: string;
  almaRootOwner?: string;
  isOwnedByCurrentUser?: boolean;
  hasUserAccess?: boolean;
  shared?: boolean;
}

export interface UnifiedProject {
  id: string;
  name: string;
  displayName?: string;
  owner: string;
  createdTime: string;
  modifiedTime?: string;
  collaborators: (string | { emailAddress: string })[];
  owners?: { displayName?: string; emailAddress: string }[];
  almaRootName?: string;
  almaRootOwner?: string;
  isOwnedByCurrentUser?: boolean;
  hasUserAccess?: boolean;
  projectType: 'personal' | 'shared';
  hasValidStructure?: boolean;
  missingFolders?: string[];
}

interface ProjectsTableUnifiedProps {
  onSelectProject: (project: UnifiedProject) => void;
  selectedProjectId?: string;
  onPatchProject: () => void;
  onNewProject: () => void;
  loadingSetup: boolean;
  reloadTrigger?: number;
}

const ProjectsTableUnified: React.FC<ProjectsTableUnifiedProps> = ({
  onSelectProject,
  selectedProjectId,
  onPatchProject,
  onNewProject: _,
  loadingSetup,
  reloadTrigger
}) => {
  const { t } = useLanguage();
  const { data: session } = useSession();
  const userEmail = session?.user?.email;
  const { signalPageReady } = usePageReady();

  const [allProjects, setAllProjects] = useState<UnifiedProject[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const loadGenerationRef = useRef(0);
  const [sortColumn, setSortColumn] = useState<'name' | 'owner' | 'createdDate' | 'updatedDate' | 'type' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [shareTarget, setShareTarget] = useState<UnifiedProject | null>(null);
  
  const [nameSearch, setNameSearch] = useState('');
  const [ownerSearch, setOwnerSearch] = useState('');
  const [showNameSearch, setShowNameSearch] = useState(false);
  const [showOwnerSearch, setShowOwnerSearch] = useState(false);

  const checkProjectStructure = async (projectId: string): Promise<{ hasValidStructure: boolean; missingFolders: string[] }> => {
    if (!session?.accessToken) {
      return { hasValidStructure: false, missingFolders: [...REQUIRED_FOLDERS] };
    }

    try {
      const response = await fetch(
        `/api/projects/${projectId}/folders/folder_id/${projectId}/contents?type=folders`,
        {
          mode: 'cors',
          headers: { Authorization: `Bearer ${session.accessToken}` }
        }
      );

      if (response.ok) {
        const data = await response.json();
        const existingFolders = data.files
          ?.filter((file: { type: string; name: string }) => file.type === 'Folder')
          ?.map((folder: { name: string }) => folder.name) || [];

        const missing = getMissingFolders(existingFolders);
        const hasValidStructure = missing.length === 0;

        return { hasValidStructure, missingFolders: missing };
      }
    } catch (error) {
      console.error('Error checking project structure:', error);
    }

    return { hasValidStructure: false, missingFolders: [...REQUIRED_FOLDERS] };
  };

  const validateStructuresInBackground = (projects: UnifiedProject[], generation: number) => {
    projects.forEach(async (project) => {
      const { hasValidStructure, missingFolders } = await checkProjectStructure(project.id);
      if (generation !== loadGenerationRef.current) return;

      setAllProjects(prev =>
        prev.map(p =>
          p.id === project.id ? { ...p, hasValidStructure, missingFolders } : p
        )
      );
    });
  };

  const determineProjectType = (project: UnifiedProject, userEmail: string): 'personal' | 'shared' => {
    if (!userEmail) return 'shared';

    const isOwner = project.isOwnedByCurrentUser ||
      project.owners?.some((owner: { displayName?: string; emailAddress: string }) =>
        owner.emailAddress?.toLowerCase() === userEmail.toLowerCase()
      );

    if (isOwner) {
      return 'personal';
    }

    const hasAccess = project.hasUserAccess === true;

    console.log(`🔍 PROJECT CLASSIFICATION DEBUG for "${project.name}":`, {
      userEmail,
      isOwnedByCurrentUser: project.isOwnedByCurrentUser,
      hasUserAccess: project.hasUserAccess,
      collaborators: project.collaborators?.length || 0,
      owners: project.owners?.map(o => o.emailAddress),
      isOwner,
      hasAccess,
      finalType: hasAccess ? 'shared' : 'personal'
    });

    return hasAccess ? 'shared' : 'personal';
  };

  const loadAllProjects = async (bustCache?: boolean) => {
    setLoading(true);
    const generation = ++loadGenerationRef.current;

    try {
      const path = bustCache
        ? `/api/list-projects?_cacheBust=${Date.now()}`
        : '/api/list-projects';

      if (bustCache) {
        console.log(`🔥 CACHE BUST: Forcing fresh API call`);
      }

      console.log(`🔍 Loading projects for user ${userEmail} (global search)`);

      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });

      if (response.ok) {
        const data = await response.json();
        const projects = data.projects ?? [];

        console.log(`📊 RAW API RESPONSE:`, data);
        console.log(`📊 Received ${projects.length} projects from API`);

        projects.forEach((project: RawProjectData, index: number) => {
          console.log(`📋 Project ${index}:`, project);
        });

        const processedProjects: UnifiedProject[] = projects.map((project: RawProjectData) => {
          const projectType = determineProjectType(project as UnifiedProject, userEmail || '');

          return {
            ...project,
            owner: project.almaRootOwner || project.owners?.[0]?.emailAddress || project.owners?.[0]?.displayName || 'Unknown',
            projectType,
            collaborators: project.collaborators || [],
            modifiedTime: project.modifiedTime
          } as UnifiedProject;
        });

        const projectMap = new Map<string, UnifiedProject>();
        processedProjects.forEach(project => {
          if (project.id) {
            if (!projectMap.has(project.id)) {
              projectMap.set(project.id, project);
            } else {
              console.log(`🔄 DUPLICATE REMOVED: ${project.name} (${project.id})`);
            }
          }
        });

        const deduplicatedProjects = Array.from(projectMap.values());
        console.log(`🎯 DEDUPLICATION COMPLETE: ${processedProjects.length} → ${deduplicatedProjects.length} projects`);

        setAllProjects(deduplicatedProjects);

        setLoading(false);
        signalPageReady();

        validateStructuresInBackground(deduplicatedProjects, generation);
        return;
      } else {
        console.error('❌ Error loading projects:', response.status, response.statusText);
        setAllProjects([]);
        signalPageReady();
      }
    } catch (error) {
      console.error('❌ Error loading projects:', error);
      setAllProjects([]);
      signalPageReady();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (session?.accessToken) {
      const shouldBustCache = Boolean(reloadTrigger && reloadTrigger > 0);
      loadAllProjects(shouldBustCache);
    }
  }, [session?.accessToken, userEmail, reloadTrigger]);

  const handleSort = (column: 'name' | 'owner' | 'createdDate' | 'updatedDate' | 'type') => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const filteredProjects = allProjects.filter(project => {
    const matchName = (project.displayName || project.name).toLowerCase().includes(nameSearch.toLowerCase());
    const matchOwner = project.owner.toLowerCase().includes(ownerSearch.toLowerCase());
    const matchOwnerEmail = project.owners?.some(o => o.emailAddress.toLowerCase().includes(ownerSearch.toLowerCase())) ?? false;
    return matchName && (matchOwner || matchOwnerEmail);
  });

  const sortedProjects = [...filteredProjects].sort((a, b) => {
    if (!sortColumn) return 0;

    let aValue: string | number;
    let bValue: string | number;

    switch (sortColumn) {
      case 'name':
        aValue = a.name.toLowerCase();
        bValue = b.name.toLowerCase();
        break;
      case 'owner':
        aValue = a.owner.toLowerCase();
        bValue = b.owner.toLowerCase();
        break;
      case 'createdDate':
        aValue = new Date(a.createdTime).getTime();
        bValue = new Date(b.createdTime).getTime();
        break;
      case 'updatedDate':
        aValue = new Date(a.modifiedTime || a.createdTime).getTime();
        bValue = new Date(b.modifiedTime || b.createdTime).getTime();
        break;
      case 'type':
        aValue = a.projectType;
        bValue = b.projectType;
        break;
      default:
        return 0;
    }

    if (typeof aValue === 'string' && typeof bValue === 'string') {
      return sortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
    } else if (typeof aValue === 'number' && typeof bValue === 'number') {
      return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
    }

    return 0;
  });

  const getSortArrow = (column: 'name' | 'owner' | 'createdDate' | 'updatedDate' | 'type') => {
    if (sortColumn === column) {
      return (
        <span style={{ color: "var(--alma-accent)", fontWeight: 700 }}>
          {sortDirection === 'asc' ? '↑' : '↓'}
        </span>
      );
    }
    return (
      <span style={{ color: "var(--alma-border)", fontWeight: 400 }} className="sort-icon-inactive">
        ↕
      </span>
    );
  };

  const getProjectTypeBadge = (type: 'personal' | 'shared') => {
    const style = type === 'personal'
      ? { backgroundColor: '#e9f7ef', color: 'var(--alma-success)', dot: 'var(--alma-success)' }
      : { backgroundColor: 'var(--alma-accent-soft)', color: 'var(--alma-accent)', dot: 'var(--alma-accent)' };

    const label = type === 'personal' ? t('projectsPage.typeOwned') : t('projectsPage.typeNotOwned');

    return (
      <span style={{
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderRadius: '999px',
        padding: '4px 10px 4px 8px',
        fontSize: '0.72rem',
        fontWeight: 600,
        letterSpacing: '0.01em',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem'
      }}>
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: style.dot, display: 'inline-block' }} />
        {label}
      </span>
    );
  };

  // Deterministic monogram tile gradient — gives every project a stable visual identity.
  const MONOGRAM_GRADIENTS = [
    'linear-gradient(135deg, #6D5BD0 0%, var(--alma-accent) 100%)',
    'linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%)',
    'linear-gradient(135deg, #4F8DF9 0%, #1E3A8A 100%)',
    'linear-gradient(135deg, #2DD4BF 0%, #0F766E 100%)',
    'linear-gradient(135deg, #F472B6 0%, #BE185D 100%)',
    'linear-gradient(135deg, #FBBF24 0%, #B45309 100%)',
  ];

  const getProjectAccent = (id: string) => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return MONOGRAM_GRADIENTS[Math.abs(hash) % MONOGRAM_GRADIENTS.length];
  };

  const getMonogram = (name: string) => (name.trim().charAt(0) || '·').toUpperCase();

  const headerCellStyle: React.CSSProperties = {
    textAlign: 'left',
    padding: '0.85rem 1.25rem',
    fontWeight: 600,
    fontSize: '0.72rem',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--alma-text-muted)',
    userSelect: 'none',
    borderBottom: '1px solid var(--alma-border)',
  };

  const bodyCellStyle: React.CSSProperties = {
    padding: '0.9rem 1.25rem',
    borderBottom: '1px solid var(--alma-border)',
    verticalAlign: 'middle',
    fontSize: '0.875rem',
    color: 'var(--alma-text-muted)',
  };

  const selectedProjectNeedsPatch = sortedProjects.find(p => p.id === selectedProjectId)?.hasValidStructure === false;

  return (
    <>
      <style jsx>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .proj-table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 760px; }
        .proj-th { cursor: pointer; transition: color 0.15s ease; }
        .proj-th:hover { color: var(--alma-accent); }
        .proj-th:hover .sort-icon-inactive { color: var(--alma-text-muted) !important; }
        .proj-row { transition: background-color 0.18s ease, box-shadow 0.18s ease; cursor: pointer; }
        .proj-row:hover { background-color: var(--alma-accent-soft); }
        .proj-row:hover .proj-monogram { transform: scale(1.05); }
        .proj-monogram { transition: transform 0.18s ease; }
        .share-btn { transition: background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease; }
        .share-btn:hover { background-color: var(--alma-accent-hover) !important; color: var(--alma-on-accent) !important; box-shadow: 0 3px 10px rgba(17, 7, 74, 0.25); }
        .proj-row:hover .share-btn { border-color: var(--alma-accent); }
      `}</style>

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", margin: "0 0 1.25rem 0" }}>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--alma-text)", margin: 0, letterSpacing: "-0.01em" }}>{t('projectsPage.allProjectsTitle')}</h2>
        {!loading && (
          <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--alma-text-muted)", backgroundColor: "var(--alma-surface-sunken)", borderRadius: "999px", padding: "2px 10px" }}>
            {sortedProjects.length}
          </span>
        )}
      </div>

      {loadingSetup && <ProjectSetupLoadingBar loadingSetup={loadingSetup} totalSteps={3} />}

      {}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "1rem", background: "transparent", border: "none", boxShadow: "none" }}>
        <div style={{ flex: "1 1 600px", minWidth: 0, background: "var(--alma-surface)", border: "1px solid var(--alma-border)", borderRadius: "16px", boxShadow: "0 1px 3px rgba(17, 7, 74, 0.04), 0 12px 32px -18px rgba(17, 7, 74, 0.18)", overflow: "hidden" }}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "1rem 1.25rem", color: "var(--alma-text-muted)", fontSize: "0.85rem" }}>
              <div style={{ width: "16px", height: "16px", border: "2px solid var(--alma-accent)", borderTop: "2px solid transparent", borderRadius: "50%", animation: "spin 1s linear infinite" }}></div>
              <span>{t('projectsPage.loadingProjectsList')}</span>
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
          <table className="proj-table">
            <thead>
              <tr style={{ backgroundColor: "var(--alma-surface-sunken)" }}>
                <th className="proj-th" style={headerCellStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", flex: 1 }} onClick={() => handleSort('name')}>
                      {t('projectsPage.colProject')} <span style={{ fontSize: "0.75rem" }}>{getSortArrow('name')}</span>
                    </div>
                    {showNameSearch ? (
                      <input
                        type="text"
                        autoFocus
                        value={nameSearch}
                        onChange={(e) => setNameSearch(e.target.value)}
                        onBlur={() => { if (!nameSearch) setShowNameSearch(false); }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ 
                          padding: "0.25rem 0.5rem", 
                          borderRadius: "4px", 
                          border: "none", 
                          background: "transparent",
                          borderBottom: "1px solid var(--alma-border)", 
                          fontSize: "0.75rem", 
                          width: "160px", 
                          fontWeight: "normal", 
                          textTransform: "none",
                          outline: "none",
                          boxShadow: "none"
                        }}
                        placeholder="Search project..."
                      />
                    ) : (
                      <button 
                        onClick={(e) => { e.stopPropagation(); setShowNameSearch(true); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--alma-text-muted)', display: 'flex', alignItems: 'center' }}
                        title="Search projects"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                      </button>
                    )}
                  </div>
                </th>
                <th className="proj-th" style={headerCellStyle} onClick={() => handleSort('type')}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    {t('projectsPage.colType')} <span style={{ fontSize: "0.75rem" }}>{getSortArrow('type')}</span>
                  </div>
                </th>
                <th className="proj-th" style={headerCellStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", flex: 1 }} onClick={() => handleSort('owner')}>
                      {t('projectsPage.colOwner')} <span style={{ fontSize: "0.75rem" }}>{getSortArrow('owner')}</span>
                    </div>
                    {showOwnerSearch ? (
                      <input
                        type="text"
                        autoFocus
                        value={ownerSearch}
                        onChange={(e) => setOwnerSearch(e.target.value)}
                        onBlur={() => { if (!ownerSearch) setShowOwnerSearch(false); }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ 
                          padding: "0.25rem 0.5rem", 
                          borderRadius: "4px", 
                          border: "none", 
                          background: "transparent",
                          borderBottom: "1px solid var(--alma-border)", 
                          fontSize: "0.75rem", 
                          width: "160px", 
                          fontWeight: "normal", 
                          textTransform: "none",
                          outline: "none",
                          boxShadow: "none"
                        }}
                        placeholder="Search owner..."
                      />
                    ) : (
                      <button 
                        onClick={(e) => { e.stopPropagation(); setShowOwnerSearch(true); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--alma-text-muted)', display: 'flex', alignItems: 'center' }}
                        title="Search owners"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                      </button>
                    )}
                  </div>
                </th>
                <th className="proj-th" style={headerCellStyle} onClick={() => handleSort('createdDate')}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    {t('projectsPage.colCreated')} <span style={{ fontSize: "0.75rem" }}>{getSortArrow('createdDate')}</span>
                  </div>
                </th>
                <th className="proj-th" style={headerCellStyle} onClick={() => handleSort('updatedDate')}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    {t('projectsPage.colUpdated')} <span style={{ fontSize: "0.75rem" }}>{getSortArrow('updatedDate')}</span>
                  </div>
                </th>
                <th style={{ ...headerCellStyle, textAlign: "right" }}>
                  {t('projectsPage.colActions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedProjects.length > 0 ? (
                sortedProjects.map((project) => {
                  const isSelected = project.id === selectedProjectId;
                  return (
                  <tr
                    key={project.id}
                    className="proj-row"
                    style={{
                      backgroundColor: isSelected ? 'var(--alma-accent-soft)' : 'transparent',
                      boxShadow: isSelected ? 'inset 3px 0 0 0 var(--alma-accent)' : 'none',
                    }}
                    onClick={() => onSelectProject(project)}
                  >
                    <td style={{ ...bodyCellStyle, color: "var(--alma-text)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0 }}>
                        <span
                          className="proj-monogram"
                          aria-hidden="true"
                          style={{
                            flex: "0 0 auto",
                            width: "36px",
                            height: "36px",
                            borderRadius: "10px",
                            background: getProjectAccent(project.id),
                            color: "var(--alma-on-accent)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 700,
                            fontSize: "0.95rem",
                            boxShadow: "0 2px 6px rgba(17, 7, 74, 0.18)",
                          }}
                        >
                          {getMonogram(project.displayName || project.name)}
                        </span>
                        <span
                          title={project.displayName || project.name}
                          style={{ fontWeight: 600, fontSize: "0.9rem", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '30ch' }}
                        >
                          {project.displayName || project.name}
                        </span>
                        {project.hasValidStructure === false && (
                          <span style={{
                            backgroundColor: "#fef3c7",
                            color: "var(--alma-warning)",
                            borderRadius: "999px",
                            padding: "2px 8px",
                            fontSize: "0.7rem",
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                          }}>
                            {t('projectsPage.needsPatchBadge')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={bodyCellStyle}>
                      {getProjectTypeBadge(project.projectType)}
                    </td>
                    <td style={bodyCellStyle}>
                      {project.owner}
                    </td>
                    <td style={bodyCellStyle}>
                      {new Date(project.createdTime).toLocaleDateString()}
                    </td>
                    <td style={bodyCellStyle}>
                      {project.modifiedTime ? new Date(project.modifiedTime).toLocaleDateString() : new Date(project.createdTime).toLocaleDateString()}
                    </td>
                    <td style={{ ...bodyCellStyle, textAlign: "right" }}>
                      {project.isOwnedByCurrentUser && (
                        <button
                          className="share-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShareTarget(project);
                          }}
                          title={t('projectsPage.shareButtonTitle')}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.35rem",
                            padding: "5px 12px",
                            backgroundColor: "var(--alma-surface)",
                            color: "var(--alma-accent)",
                            border: "1px solid var(--alma-border)",
                            borderRadius: "999px",
                            fontSize: "0.78rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            whiteSpace: "nowrap"
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="18" cy="5" r="3" />
                            <circle cx="6" cy="12" r="3" />
                            <circle cx="18" cy="19" r="3" />
                            <line x1="8.6" y1="10.5" x2="15.4" y2="6.5" />
                            <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
                          </svg>
                          {t('projectsPage.shareButton')}
                        </button>
                      )}
                    </td>
                  </tr>
                  );
                })
              ) : (
                <tr>
                  <td style={{ ...bodyCellStyle, textAlign: "center", padding: "3rem 1.25rem", color: "var(--alma-text-muted)" }} colSpan={6}>
                    {t('projectsPage.noProjectsFound')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>

        {}
        {selectedProjectNeedsPatch && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: "120px", flex: "0 0 auto" }}>
            <button
              style={{
                padding: "8px 12px",
                backgroundColor: loadingSetup ? "var(--alma-surface-sunken)" : "var(--alma-text-muted)",
                color: loadingSetup ? "var(--alma-text-muted)" : "var(--alma-on-accent)",
                border: "none",
                borderRadius: "6px",
                fontSize: "0.85rem",
                fontWeight: "500",
                cursor: loadingSetup ? "not-allowed" : "pointer",
                opacity: loadingSetup ? 0.6 : 1,
                boxShadow: loadingSetup ? "none" : "0 1px 4px rgba(55, 65, 81, 0.2)"
              }}
              onClick={onPatchProject}
              disabled={loadingSetup}
              title={t('projectsPage.patchButtonTitle')}
            >
              {t('projectsPage.patchButton')}
            </button>
          </div>
        )}
      </div>

      {shareTarget && (
        <ShareProjectModal
          project={shareTarget}
          onClose={() => setShareTarget(null)}
          onShared={() => loadAllProjects(true)}
        />
      )}
    </>
  );
};

export default ProjectsTableUnified; 