'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, ChevronLeft, Plus } from 'lucide-react';
import { useProjectState } from '../components/ProjectStateContext';
import { useProjectList, type ProjectListItem } from '../hooks/useProjectList';
import { useLanguage } from '../contexts/LanguageContext';
import { getCleanProjectName } from '../lib/project-constants';
import WorkspaceNewProjectModal from './WorkspaceNewProjectModal';

interface MenuAnchor {
  top: number;
  left: number;
  width: number;
}

// Left-bar project control: replaces the old static `aw-project` button. Opens a
// dropdown listing every project (active one checked) plus a "New project" row
// that launches the styled create modal. Selecting a project sets projectFolder
// — the one switch useAgentNodesData watches to reload the middle "do stuff"
// page for the new project.
export default function WorkspaceProjectSwitcher() {
  const { t } = useLanguage();
  const router = useRouter();
  const { projectFolder, setProjectFolder } = useProjectState();
  const { projects, loading, error, refresh } = useProjectList();

  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const currentLabel = projectFolder?.folderName ?? t('almaStudioProjects.noProjectSelected');
  const currentId = projectFolder?.projectId ?? null;

  // The menu is position:fixed (not absolute) so it escapes the .aw-card
  // overflow:hidden that would otherwise clip a long list. Anchor it to the
  // trigger's viewport rect, recomputed whenever it opens or the window resizes.
  const positionMenu = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', positionMenu);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', positionMenu);
    };
  }, [menuOpen, positionMenu]);

  const openMenu = () => {
    positionMenu();
    setMenuOpen(true);
  };

  const selectProject = useCallback(
    (project: ProjectListItem) => {
      setMenuOpen(false);
      // Re-selecting the active project would needlessly navigate away from an
      // open agent that belongs to it, so just close the menu.
      if (project.id === projectFolder?.projectId) return;
      setProjectFolder({
        projectId: project.id,
        folderName: project.displayName || project.name,
        files: [],
      });
      // Return to the workspace index so a stale agent from the previous project
      // isn't left open in the middle page. No-op when already on the index.
      router.push('/agent-workspace');
    },
    [router, setProjectFolder, projectFolder?.projectId],
  );

  const handleCreated = useCallback(
    (project: { id: string; name: string }) => {
      void refresh(true);
      // The API returns the raw alma_<name>_<ts> folder name; strip it to the
      // clean base name for the switcher label (list-projects does the same).
      const displayName = getCleanProjectName(project.name);
      setProjectFolder({ projectId: project.id, folderName: displayName, files: [] });
      router.push('/agent-workspace');
      // Keep the /projects page in sync (it listens for this event).
      window.dispatchEvent(new Event('alma:projects-updated'));
    },
    [refresh, setProjectFolder, router],
  );

  return (
    <div className="aw-projswitch" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="aw-project"
        onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={currentLabel}
      >
        <ChevronLeft size={15} aria-hidden />
        <span className="aw-project__name">{currentLabel}</span>
        <ChevronDown size={14} aria-hidden />
      </button>

      <button
        type="button"
        className="aw-projswitch__new"
        onClick={() => {
          setMenuOpen(false);
          setModalOpen(true);
        }}
      >
        <Plus size={15} aria-hidden />
        {t('almaStudioProjects.newProject')}
      </button>

      {menuOpen && anchor ? (
        <div
          className="aw-projmenu"
          role="menu"
          style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
        >
          {loading ? (
            <div className="aw-projmenu__hint">{t('almaStudioProjects.loading')}</div>
          ) : error ? (
            <div className="aw-projmenu__hint aw-projmenu__hint--error">
              {t('almaStudioProjects.loadError')}
            </div>
          ) : projects.length === 0 ? (
            <div className="aw-projmenu__hint">{t('almaStudioProjects.noProjects')}</div>
          ) : (
            projects.map((project) => {
              const active = project.id === currentId;
              return (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  className={`aw-projmenu__item${active ? ' aw-projmenu__item--active' : ''}`}
                  onClick={() => selectProject(project)}
                  title={project.displayName}
                >
                  <span className="aw-projmenu__label">{project.displayName}</span>
                  {active ? <Check size={14} aria-hidden /> : null}
                </button>
              );
            })
          )}

          <div className="aw-projmenu__divider" />

          <button
            type="button"
            role="menuitem"
            className="aw-projmenu__new"
            onClick={() => {
              setMenuOpen(false);
              setModalOpen(true);
            }}
          >
            <Plus size={15} aria-hidden />
            {t('almaStudioProjects.newProject')}
          </button>
        </div>
      ) : null}

      <WorkspaceNewProjectModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}
