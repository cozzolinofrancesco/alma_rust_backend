'use client';

import nextDynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { isSct272Pathname, SCT272_REOPEN_EVENT } from '../lib/sct272-events';
import { useCallback, useEffect, useState, useRef } from 'react';
import '../styles/navbar.css';
import NavigationHeader from './navigation/NavigationHeader';
import { NavigationHelp, NavigationSettings } from './navigation/NavigationUtilities';
import navigationStyles from './navigation/NavigationHeader.module.css';
import QuestionsModal from './QuestionsModal';
import { Upload } from 'lucide-react';
import SectionTutorialModal from './help/SectionTutorialModal';
import { SECTION_TUTORIALS, type TutorialSectionKey } from './help/sectionTutorials';
import { CacheManager } from '../lib/cacheManager';
import {
  QUESTIONS_CONTACT_INTRO_SEEN_KEY,
} from '../lib/dailyHelpPrompt';
import PolicyModal from './PolicyModal';
import { useProjectState } from './CompatibilityHooks';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { getRecentProjects, getRecentAgents, getRecentAgentsByProject, addRecentProject, type RecentProject, type RecentAgent } from '../lib/recentItemsManager';
import { fetchAgentFiles } from '../lib/api';
import { DEFAULT_MODEL } from '../lib/modelConfig';
import { getCleanProjectName as getSharedCleanProjectName } from '../lib/project-constants';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { useAppBusyOptional } from '../contexts/AppBusyContext';
import { useLanguage } from '../contexts/LanguageContext';

const HowlChat = nextDynamic(() => import('./HowlChat'), { ssr: false });

const Navbar: React.FC = () => {
  const pathname = usePathname();
  const [isHowlChatOpen, setIsHowlChatOpen] = useState(false);
  const [showQuestionsModal, setShowQuestionsModal] = useState(false);
  const [tutorialSection, setTutorialSection] = useState<TutorialSectionKey | null>(null);

  const handleLaunchTraining = useCallback(() => {
    setShowQuestionsModal(false);
  }, []);

  const handleQuickInfoClick = useCallback(() => {
    if (pathname === '/') setTutorialSection('home');
    else if (pathname === '/projects') setTutorialSection('projects');
    else if (pathname === '/upload' || pathname === '/rag-corpus') setTutorialSection('addData');
    else if ((pathname ?? '').startsWith('/ai-agents') || (pathname ?? '').startsWith('/agentnodes')) setTutorialSection('agentBuilder');
    else if (pathname === '/validation' || pathname === '/claim-validation') setTutorialSection('validation');
    else if (isSct272Pathname(pathname)) setTutorialSection('sct272');
    else setTutorialSection('home');
  }, [pathname]);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [recentAgents, setRecentAgents] = useState<RecentAgent[]>([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [refreshingProjects, setRefreshingProjects] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [pendingPdfFile, setPendingPdfFile] = useState<File | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState(1);
  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(1);
  const [uploadProgress, setUploadProgress] = useState<{
    show: boolean;
    fileName: string;
    mode: 'import' | 'ocr';
    status: 'uploading' | 'processing' | 'complete' | 'error';
    message: string;
  } | null>(null);

  const { registerBusy, unregisterBusy } = useAppBusyOptional();

  const pdfUploadBusy =
    uploadProgress !== null &&
    uploadProgress.show &&
    (uploadProgress.status === 'uploading' || uploadProgress.status === 'processing');
  useEffect(() => {
    const id = 'pdf-upload';
    if (pdfUploadBusy) registerBusy(id);
    else unregisterBusy(id);
    return () => unregisterBusy(id);
  }, [pdfUploadBusy, registerBusy, unregisterBusy]);
  
  const { projectFolder, setProjectFolder } = useProjectState();
  
  const { data: session } = useSession();

  const { t } = useLanguage();

  const handleQuestionsModalClose = useCallback(() => {
    try {
      window.localStorage.setItem(QUESTIONS_CONTACT_INTRO_SEEN_KEY, '1');
    } catch {
    }
    setShowQuestionsModal(false);
  }, []);

  const router = useRouter();
  
  const getCleanProjectName = (name: string | undefined): string => {
    if (!name) return t('project.noProjectSelected');
    return getSharedCleanProjectName(name);
  };

  useEffect(() => {
    const loadInitialProjects = async () => {
      const displayedProjects: RecentProject[] = [];
      const displayedIds = new Set<string>();

      try {
        const response = await fetch(`/api/list-projects?_cacheBust=${Date.now()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });

        if (response.ok) {
          const data = await response.json();
          const projects = data.projects ?? [];
          console.log('📡 Fetched all projects from API:', projects.length);

          const projectMap = new Map<string, { id: string; name: string; createdTime?: string }>();
          projects.forEach((project: { id: string; name: string; createdTime?: string }) => {
            if (project.id && !projectMap.has(project.id)) {
              projectMap.set(project.id, project);
            }
          });

          const uniqueProjects = Array.from(projectMap.values());

          const sorted = uniqueProjects.sort((a, b) => {
            const timeA = new Date(a.createdTime || 0).getTime();
            const timeB = new Date(b.createdTime || 0).getTime();
            if (timeB !== timeA) return timeB - timeA;
            return (a.name || '').localeCompare(b.name || '');
          });

          if (projectFolder?.projectId) {
            const active = sorted.find((p) => p.id === projectFolder.projectId);
            if (active) {
              displayedProjects.push({
                id: active.id,
                name: active.name || projectFolder.folderName || active.id,
                lastUsed: Date.now(),
              });
              displayedIds.add(active.id);
            }
          }

          sorted.forEach((p) => {
            if (!displayedIds.has(p.id)) {
              displayedProjects.push({
                id: p.id,
                name: p.name,
                lastUsed: new Date(p.createdTime || 0).getTime(),
              });
              displayedIds.add(p.id);
            }
          });

          console.log('📋 All projects to display:', displayedProjects.length);
        } else {
          if (projectFolder?.projectId) {
            displayedProjects.push({
              id: projectFolder.projectId,
              name: projectFolder.folderName || projectFolder.projectId,
              lastUsed: Date.now(),
            });
            displayedIds.add(projectFolder.projectId);
          }
          const storedRecent = getRecentProjects();
          storedRecent.filter((p) => !displayedIds.has(p.id)).forEach((p) => {
            displayedProjects.push(p);
            displayedIds.add(p.id);
          });
        }
      } catch {
        console.warn('Project list API unavailable during initial load; using local fallback.');
        if (projectFolder?.projectId) {
          displayedProjects.push({
            id: projectFolder.projectId,
            name: projectFolder.folderName || projectFolder.projectId,
            lastUsed: Date.now(),
          });
          displayedIds.add(projectFolder.projectId);
        }
        const storedRecent = getRecentProjects();
        storedRecent.filter((p) => !displayedIds.has(p.id)).forEach((p) => {
          displayedProjects.push(p);
          displayedIds.add(p.id);
        });
      }

      setRecentProjects(displayedProjects);
    };

    loadInitialProjects();
    setRecentAgents(getRecentAgents());
  }, [projectFolder?.projectId, projectFolder?.folderName]);

  const reloadRecentAgents = useCallback(async () => {
    if (!projectFolder?.projectId) {
      setRecentAgents([]);
      return;
    }

    try {
      const allAgents = await fetchAgentFiles(projectFolder.projectId);
      const allAgentsMap = new Map(allAgents.map((a) => [a.id, a]));

      const recentForProject = getRecentAgentsByProject(projectFolder.projectId);

      const validRecent = recentForProject
        .filter((agent) => allAgentsMap.has(agent.id))
        .map((agent) => {
          const actualAgent = allAgentsMap.get(agent.id)!;
          return {
            ...agent,
            name: actualAgent.name,
          };
        });

      if (typeof window !== 'undefined' && validRecent.length !== recentForProject.length) {
        try {
          const RECENT_AGENTS_KEY = 'alma_recent_agents';
          const stored = localStorage.getItem(RECENT_AGENTS_KEY);
          if (stored) {
            const allRecent: RecentAgent[] = JSON.parse(stored);
            const otherProjectsRecent = allRecent.filter((a) => a.projectId !== projectFolder.projectId);
            const updatedRecentStore = [...validRecent, ...otherProjectsRecent].slice(0, 5);
            localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(updatedRecentStore));
          }
        } catch (e) {
          console.error('Error cleaning up local storage recent agents:', e);
        }
      }

      if (validRecent.length > 0) {
        setRecentAgents(validRecent);
        return;
      }

      const latestAgents = allAgents
        .sort((a, b) => {
          const timeA = new Date(a.createdAt || 0).getTime();
          const timeB = new Date(b.createdAt || 0).getTime();
          return timeB - timeA;
        })
        .slice(0, 3)
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          lastUsed: new Date(agent.createdAt || 0).getTime(),
          projectId: projectFolder.projectId,
        }));

      setRecentAgents(latestAgents);
    } catch (error) {
      console.error('Error loading and verifying agents for project:', error);
      const recentForProject = getRecentAgentsByProject(projectFolder.projectId);
      setRecentAgents(recentForProject);
    }
  }, [projectFolder?.projectId]);

  useEffect(() => {
    void reloadRecentAgents();
  }, [reloadRecentAgents]);

  useEffect(() => {
    const handleAgentsUpdated = () => {
      void reloadRecentAgents();
    };
    window.addEventListener('agents-cache-invalidated', handleAgentsUpdated);
    window.addEventListener('alma:agents-updated', handleAgentsUpdated);
    return () => {
      window.removeEventListener('agents-cache-invalidated', handleAgentsUpdated);
      window.removeEventListener('alma:agents-updated', handleAgentsUpdated);
    };
  }, [reloadRecentAgents]);

  useEffect(() => {
    if (projectFolder?.projectId && projectFolder?.folderName) {
      addRecentProject(projectFolder.projectId, projectFolder.folderName);
      setRecentProjects(getRecentProjects());
    }
  }, [projectFolder]);



  useEffect(() => {
    if (showPdfModal) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [showPdfModal]);


  const handleSct272LinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (isSct272Pathname(pathname)) {
        e.preventDefault();
        window.dispatchEvent(new Event(SCT272_REOPEN_EVENT));
      }
    },
    [pathname],
  );


  const handleClearCache = () => {
    try {
      CacheManager.clearAll();
      window.location.reload();
    } catch (error) {
      console.error('Cache clear error:', error);
    }
  };


  const { startNavigation } = useNavigationLoading();

  const handleSelectProject = (project: RecentProject) => {
    setProjectFolder({
      projectId: project.id,
      folderName: project.name,
      files: [],
    });
    startNavigation('Loading project...');
    router.push('/projects');
  };

  const handleSelectAgent = (agent: RecentAgent) => {
    startNavigation('Loading agent...');
    router.push(`/ai-agents/edit/${agent.id}`);
  };

  const refreshProjectsList = async () => {
    setRefreshingProjects(true);
    try {
      const response = await fetch(`/api/list-projects?_cacheBust=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (response.ok) {
        const data = await response.json();
        const projects = data.projects ?? [];
        console.log('✅ Projects refreshed:', projects.length);

        const displayedProjects: RecentProject[] = [];
        const displayedIds = new Set<string>();

        const projectMap = new Map<string, { id: string; name: string; createdTime?: string }>();
        projects.forEach((project: { id: string; name: string; createdTime?: string }) => {
          if (project.id && !projectMap.has(project.id)) {
            projectMap.set(project.id, project);
          }
        });

        const uniqueProjects = Array.from(projectMap.values());
        const sorted = uniqueProjects.sort((a, b) => {
          const timeA = new Date(a.createdTime || 0).getTime();
          const timeB = new Date(b.createdTime || 0).getTime();
          if (timeB !== timeA) return timeB - timeA;
          return (a.name || '').localeCompare(b.name || '');
        });

        if (projectFolder?.projectId) {
          const active = sorted.find((p) => p.id === projectFolder.projectId);
          if (active) {
            displayedProjects.push({
              id: active.id,
              name: active.name || projectFolder.folderName || active.id,
              lastUsed: Date.now(),
            });
            displayedIds.add(active.id);
          }
        }

        sorted.forEach((p) => {
          if (!displayedIds.has(p.id)) {
            displayedProjects.push({
              id: p.id,
              name: p.name,
              lastUsed: new Date(p.createdTime || 0).getTime(),
            });
            displayedIds.add(p.id);
          }
        });

        console.log('📋 All projects refreshed:', displayedProjects.length);
        setRecentProjects(displayedProjects);
      }
    } catch {
      console.warn('Project list refresh failed.');
    } finally {
      setRefreshingProjects(false);
    }
  };

  const getPdfPageCount = async (file: File): Promise<number> => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const text = new TextDecoder().decode(uint8Array);
      
      const matches = text.match(/\/Type\s*\/Page[^s]/g);
      return matches ? matches.length : 1;
    } catch (error) {
      console.error('Error getting PDF page count:', error);
      return 1;
    }
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
    
    const files = Array.from(e.dataTransfer.files);
    const pdfFile = files.find(file => file.type === 'application/pdf');
    
    if (pdfFile) {
      setPendingPdfFile(pdfFile);
      const pageCount = await getPdfPageCount(pdfFile);
      setPdfPageCount(pageCount);
      setStartPage(1);
      setEndPage(pageCount);
      setShowPdfModal(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
  };

  const handleDropzoneClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const pdfFile = files.find(file => file.type === 'application/pdf');
    
    if (pdfFile) {
      setPendingPdfFile(pdfFile);
      const pageCount = await getPdfPageCount(pdfFile);
      setPdfPageCount(pageCount);
      setStartPage(1);
      setEndPage(pageCount);
      setShowPdfModal(true);
    }
  };

  const handlePdfChoice = async (choice: 'import' | 'ocr') => {
    if (!pendingPdfFile || !projectFolder || !session?.accessToken) {
      alert('Please select a project first');
      return;
    }
    
    setShowPdfModal(false);
    setUploadProgress({
      show: true,
      fileName: pendingPdfFile.name,
      mode: choice,
      status: 'uploading',
      message: 'Uploading file...'
    });

    const token = session.accessToken;
    const finalFileName = pendingPdfFile.name;

    try {
      const formData = new FormData();
      formData.append('file', pendingPdfFile, finalFileName);

      const uploadResponse = await fetch(
        `/api/projects/${projectFolder.projectId}/folders/PDFs/files`,
        {
          method: 'POST',
          mode: 'cors',
          headers: { Authorization: `Bearer ${token}` },
          body: formData
        }
      );

      if (!uploadResponse.ok) {
        throw new Error('Upload failed');
      }

      if (choice === 'ocr') {
        const pageRange = startPage === endPage ? `page ${startPage}` : `pages ${startPage}-${endPage}`;
        setUploadProgress(prev => prev ? {
          ...prev,
          status: 'processing',
          message: `Processing ${pageRange} with OCR...`
        } : null);
        
        const ocrFormData = new FormData();
        ocrFormData.append("project_id", projectFolder.projectId);
        ocrFormData.append("pdf_file", pendingPdfFile, pendingPdfFile.name);
        ocrFormData.append("force_ocr", "false");
        ocrFormData.append("start_page", startPage.toString());
        ocrFormData.append("end_page", endPage.toString());
        ocrFormData.append("model", DEFAULT_MODEL);

        const ocrResponse = await fetch(`/api/ocr`, {
          method: "POST",
          mode: 'cors',
          body: ocrFormData,
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!ocrResponse.ok) {
          throw new Error('OCR processing failed');
        }
      }
      
      setUploadProgress(prev => prev ? {
        ...prev,
        status: 'complete',
        message: choice === 'ocr' ? 'OCR completed!' : 'Upload complete!'
      } : null);
      
      setTimeout(() => {
        setUploadProgress(null);
        setPendingPdfFile(null);
      }, 3000);
      
    } catch (error) {
      console.error('Upload/OCR error:', error);
      setUploadProgress(prev => prev ? {
        ...prev,
        status: 'error',
        message: 'Upload failed. Please try again.'
      } : null);
    }
  };

  return (
    <div className="navbar-container navbar-redesigned">
      <input ref={fileInputRef} type="file" accept="application/pdf" multiple onChange={handleFileSelect} hidden />
      <NavigationHeader
        pathname={pathname}
        t={t}
        projectId={projectFolder?.projectId}
        projectName={projectFolder?.folderName ? getCleanProjectName(projectFolder.folderName) : t('project.selectProject')}
        projects={recentProjects}
        agents={recentAgents}
        refreshingProjects={refreshingProjects}
        onSelectProject={handleSelectProject}
        onSelectAgent={handleSelectAgent}
        onRefreshProjects={() => { void refreshProjectsList(); }}
        onSct272Click={handleSct272LinkClick}
        voiceControl={() => null}
        helpContent={(close) => (
          <NavigationHelp
            close={close}
            onQuestions={() => setShowQuestionsModal(true)}
            onTraining={handleLaunchTraining}
            onQuickInfo={handleQuickInfoClick}
            onAssistant={() => setIsHowlChatOpen((prev) => !prev)}
            onTutorial={setTutorialSection}
          />
        )}
        settingsContent={(close) => (
          <NavigationSettings
            close={close}
            userName={session?.user?.name || session?.user?.email}
            onPrivacy={() => setShowPrivacyModal(true)}
            onTerms={() => setShowTermsModal(true)}
            onClearCache={handleClearCache}
            onSignOut={() => { void signOut({ callbackUrl: '/' }); }}
          />
        )}
        uploadContent={(close) => (
          <button
            type="button"
            className={navigationStyles.dropzone}
            data-dragging={isDraggingFile}
            onClick={(event) => { close(); handleDropzoneClick(event); }}
            onDrop={(event) => { close(); void handleFileDrop(event); }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <Upload size={22} aria-hidden="true" />
            <span>{isDraggingFile ? t('nav.dropPdfHere') : t('navigation.uploadPdf')}</span>
          </button>
        )}
      />

      {isHowlChatOpen && <HowlChat onClose={() => setIsHowlChatOpen(false)} />}
      <QuestionsModal
        isOpen={showQuestionsModal}
        onClose={handleQuestionsModalClose}
      />
      <SectionTutorialModal
        isOpen={tutorialSection !== null}
        steps={tutorialSection ? SECTION_TUTORIALS[tutorialSection].steps : []}
        onClose={() => setTutorialSection(null)}
      />
      
      {}
      <PolicyModal
        isOpen={showPrivacyModal}
        onClose={() => setShowPrivacyModal(false)}
        title={t('policy.privacyTitle')}
        policyFile="/policies/privacy-disclaimer.txt"
      />
      
      <PolicyModal
        isOpen={showTermsModal}
        onClose={() => setShowTermsModal(false)}
        title={t('policy.termsTitle')}
        policyFile="/policies/terms-of-use.txt"
      />

      {}
      {showPdfModal && pendingPdfFile && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          zIndex: 10000,
          backdropFilter: 'blur(8px)',
          padding: '20px',
          paddingTop: '80px',
          boxSizing: 'border-box'
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '16px',
            padding: '1.5rem',
            maxWidth: '700px',
            width: '90%',
            maxHeight: '90vh',
            overflow: 'auto',
            boxShadow: '0 25px 50px rgba(0, 0, 0, 0.3)',
            border: '1px solid #e5e7eb'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1.25rem',
              paddingBottom: '1rem',
              borderBottom: '2px solid #F0F4FC'
            }}>
              <h3 style={{
                margin: 0,
                color: '#11074A',
                fontSize: '1.5rem',
                fontWeight: '700'
              }}>{t('pdfModal.title')}</h3>
              <button
                onClick={() => {
                  setShowPdfModal(false);
                  setPendingPdfFile(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.5rem',
                  color: '#6b7280',
                  cursor: 'pointer',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '4px'
                }}
              >
                ✕
              </button>
            </div>

            <div style={{
              marginBottom: '1.25rem',
              padding: '0.75rem 1rem',
              backgroundColor: '#F0F4FC',
              borderRadius: '8px',
              fontSize: '0.9rem',
              color: '#11074A',
              borderLeft: '3px solid #11074A'
            }}>
              <strong>{t('pdfModal.fileLabel')}</strong> {pendingPdfFile.name}
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '1.25rem'
            }}>
              {}
              <div style={{
                padding: '1.25rem',
                border: '2px solid #e5e7eb',
                borderRadius: '12px',
                backgroundColor: '#FFFFFF',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)'
              }}>
                <h4 style={{
                  margin: '0 0 0.5rem 0',
                  color: '#11074A',
                  fontSize: '1.1rem',
                  fontWeight: '700'
                }}>{t('pdfModal.justImportTitle')}</h4>
                <p style={{
                  margin: '0 0 0.75rem 0',
                  color: '#6b7280',
                  fontSize: '0.85rem',
                  lineHeight: '1.4'
                }}>{t('pdfModal.justImportDesc')}</p>
                <ul style={{
                  margin: '0 0 1rem 0',
                  paddingLeft: '1.25rem',
                  color: '#4a5568',
                  fontSize: '0.85rem',
                  lineHeight: '1.6'
                }}>
                  <li>{t('pdfModal.justImportBullet1')}</li>
                  <li>{t('pdfModal.justImportBullet2')}</li>
                  <li>{t('pdfModal.justImportBullet3')}</li>
                </ul>
                <button
                  onClick={() => handlePdfChoice('import')}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: 'none',
                    borderRadius: '8px',
                    backgroundColor: '#11074A',
                    color: '#FFFFFF',
                    cursor: 'pointer',
                    fontSize: '0.95rem',
                    fontWeight: '600',
                    transition: 'all 0.2s ease',
                    marginTop: '0.5rem'
                  }}
                >
                  {t('pdfModal.justImportButton')}
                </button>
              </div>

              {}
              <div style={{
                padding: '1.25rem',
                border: '2px solid #e5e7eb',
                borderRadius: '12px',
                backgroundColor: '#FFFFFF',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)'
              }}>
                <h4 style={{
                  margin: '0 0 0.5rem 0',
                  color: '#11074A',
                  fontSize: '1.1rem',
                  fontWeight: '700'
                }}>{t('pdfModal.ocrTitle')}</h4>
                <p style={{
                  margin: '0 0 0.75rem 0',
                  color: '#6b7280',
                  fontSize: '0.85rem',
                  lineHeight: '1.4'
                }}>{t('pdfModal.ocrDesc')}</p>
                <ul style={{
                  margin: '0 0 1rem 0',
                  paddingLeft: '1.25rem',
                  color: '#4a5568',
                  fontSize: '0.85rem',
                  lineHeight: '1.6'
                }}>
                  <li>{t('pdfModal.ocrBullet1')}</li>
                  <li>{t('pdfModal.ocrBullet2')}</li>
                  <li>{t('pdfModal.ocrBullet3')}</li>
                  <li>{t('pdfModal.ocrBullet4')}</li>
                </ul>
                
                {}
                <div style={{
                  marginBottom: '1rem',
                  padding: '0.75rem',
                  backgroundColor: '#F8F9FA',
                  borderRadius: '8px',
                  border: '1px solid #e5e7eb'
                }}>
                  <label style={{
                    display: 'block',
                    marginBottom: '0.5rem',
                    color: '#11074A',
                    fontSize: '0.85rem',
                    fontWeight: '600'
                  }}>{t('pdfModal.pageRange')}</label>
                  <div style={{
                    display: 'flex',
                    gap: '0.75rem',
                    marginBottom: '0.5rem'
                  }}>
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.25rem',
                      flex: 1
                    }}>
                      <label style={{
                        display: 'block',
                        marginBottom: '0.25rem',
                        color: '#6b7280',
                        fontSize: '0.75rem',
                        fontWeight: '500'
                      }}>{t('pdfModal.start')}</label>
                      <input
                        type="number"
                        value={startPage}
                        onChange={(e) => {
                          const newStart = Math.max(1, Math.min(pdfPageCount, parseInt(e.target.value) || 1));
                          setStartPage(newStart);
                          if (newStart > endPage) setEndPage(newStart);
                        }}
                        min="1"
                        max={pdfPageCount}
                        style={{
                          padding: '0.5rem',
                          borderRadius: '6px',
                          border: '1px solid #e5e7eb',
                          backgroundColor: '#FFFFFF',
                          fontSize: '0.9rem',
                          color: '#11074A',
                          fontWeight: '600'
                        }}
                      />
                    </div>
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.25rem',
                      flex: 1
                    }}>
                      <label style={{
                        display: 'block',
                        marginBottom: '0.25rem',
                        color: '#6b7280',
                        fontSize: '0.75rem',
                        fontWeight: '500'
                      }}>{t('pdfModal.end')}</label>
                      <input
                        type="number"
                        value={endPage}
                        onChange={(e) => setEndPage(Math.max(startPage, Math.min(pdfPageCount, parseInt(e.target.value) || startPage)))}
                        min={startPage}
                        max={pdfPageCount}
                        style={{
                          padding: '0.5rem',
                          borderRadius: '6px',
                          border: '1px solid #e5e7eb',
                          backgroundColor: '#FFFFFF',
                          fontSize: '0.9rem',
                          color: '#11074A',
                          fontWeight: '600'
                        }}
                      />
                    </div>
                  </div>
                  <p style={{
                    margin: '0',
                    fontSize: '0.75rem',
                    color: '#6b7280',
                    fontWeight: '500'
                  }}>
                    {t('pdfModal.pageEstimate', {
                      n: endPage - startPage + 1,
                      total: pdfPageCount,
                      min: Math.ceil((endPage - startPage + 1) * 40 / 60),
                    })}
                  </p>
                </div>

                <button
                  onClick={() => handlePdfChoice('ocr')}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: 'none',
                    borderRadius: '8px',
                    backgroundColor: '#11074A',
                    color: '#FFFFFF',
                    cursor: 'pointer',
                    fontSize: '0.95rem',
                    fontWeight: '600',
                    transition: 'all 0.2s ease',
                    marginTop: '0.5rem'
                  }}
                >
                  {t('pdfModal.ocrButton')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


      {}
      {uploadProgress && uploadProgress.show && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          backgroundColor: '#FFFFFF',
          borderRadius: '12px',
          padding: '1rem 1.25rem',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15)',
          border: '2px solid #11074A',
          minWidth: '320px',
          zIndex: 9999,
          animation: 'slideInUp 0.3s ease-out'
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: '0.75rem'
          }}>
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: '0.9rem',
                fontWeight: '700',
                color: '#11074A',
                marginBottom: '0.25rem'
              }}>
                {uploadProgress.mode === 'ocr' ? t('uploadToast.processingOcr') : t('uploadToast.uploadingFile')}
              </div>
              <div style={{
                fontSize: '0.8rem',
                color: '#6b7280',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>
                {uploadProgress.fileName}
              </div>
            </div>
            <button
              onClick={() => setUploadProgress(null)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '1.25rem',
                color: '#6b7280',
                cursor: 'pointer',
                padding: '0',
                marginLeft: '0.5rem',
                lineHeight: 1
              }}
            >
              ✕
            </button>
          </div>
          
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem'
          }}>
            {uploadProgress.status !== 'complete' && uploadProgress.status !== 'error' && (
              <div style={{
                width: '20px',
                height: '20px',
                border: '3px solid #e5e7eb',
                borderTopColor: '#11074A',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite'
              }} />
            )}
            {uploadProgress.status === 'complete' && (
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                backgroundColor: '#10B981',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                fontSize: '0.75rem'
              }}>
                ✓
              </div>
            )}
            {uploadProgress.status === 'error' && (
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                backgroundColor: '#EF4444',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                fontSize: '0.75rem'
              }}>
                !
              </div>
            )}
            <div style={{
              fontSize: '0.85rem',
              color: uploadProgress.status === 'error' ? '#EF4444' : '#4a5568'
            }}>
              {uploadProgress.message}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Navbar;
