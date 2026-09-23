'use client';

import { useSession } from "next-auth/react";
import Script from 'next/script';
import { useEffect, useRef, useState } from "react";
import DisclaimerPopup from "../components/DisclaimerModal";
import MissingFoldersModal from "../components/MissingFoldersModal";
import NewWorkflowPopup from "../components/NewWorkflowPopup2";
import OnboardingModal from "../components/onboarding/OnboardingModal";
import ProjectLoadingModal from "../components/ProjectLoadingModal";
import ProjectsTableUnified, { UnifiedProject as Project } from "../components/ProjectsTableUnified";
import { useProjectState } from "../components/ProjectStateContext";
import { isDisclaimerAccepted, setDisclaimerAccepted, recordDisclaimerAcceptance } from "../lib/disclaimerUtils";
import { useLanguage } from "../contexts/LanguageContext";
import { REQUIRED_FOLDERS, getRequiredFoldersCount } from "../lib/project-constants";
import "../styles/onboarding.css";

interface VantaEffect {
  destroy: () => void;
  resize: () => void;
}

declare global {
  interface Window {
    THREE?: unknown;
    VANTA?: {
      CLOUDS: (options: unknown) => VantaEffect;
      NET: (options: unknown) => VantaEffect;
      HALO: (options: unknown) => VantaEffect;
      CELLS: (options: unknown) => VantaEffect;
      RINGS: (options: unknown) => VantaEffect;
    };
  }
}

interface CreateSubfolderResponse {
  subfolder_id: string;
  subfolder_name: string;
  parent_folder_id: string;
  message: string;
}

const CREATE_SUBFOLDER_API_URL =
  process.env.NEXT_PUBLIC_CREATE_SUBFOLDER_API_URL || "/api/create-subfolder";

const createSubfolder = async (
  token: string,
  projectId: string,
  parentFolderId: string,
  subfolderName: string
): Promise<CreateSubfolderResponse> => {
  const response = await fetch(CREATE_SUBFOLDER_API_URL, {
    method: "POST",
    mode: 'cors',
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      projectId,
      parentFolderId,
      subfolderName,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to create subfolder");
  }

  return response.json() as Promise<CreateSubfolderResponse>;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handleSetupStructure = async (
  token: string,
  projectFolder: { projectId: string; folderName: string; files: unknown[] }
): Promise<{ success: boolean; projectName: string }> => {
  if (!projectFolder || !token) {
    alert("Select a project and ensure you are logged in.");
    return { success: false, projectName: '' };
  }

  const folderNames = REQUIRED_FOLDERS;

  try {
    for (const folderName of folderNames) {
      await createSubfolder(
        token,
        projectFolder.projectId,
        projectFolder.projectId,
        folderName
      );
    }
    return { success: true, projectName: projectFolder.folderName };
  } catch (error) {
    console.error("Unexpected error setting up structure:", error);
    throw error;
  }
};

export default function ProjectsPage() {
  const { t } = useLanguage();
  const { data: session } = useSession();
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const { setProjectFolder } = useProjectState();
  const [showPopup, setShowPopup] = useState(false);

  const [showLoadingModal, setShowLoadingModal] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const loadingSetup = false;
  const [showMissingFoldersModal, setShowMissingFoldersModal] = useState(false);
  const [missingFolders, setMissingFolders] = useState<string[]>([]);
  const [reloadTrigger, setReloadTrigger] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);

  useEffect(() => {
    if (!isDisclaimerAccepted()) {
      setShowDisclaimer(true);
    }
  }, []);

  useEffect(() => {
    const onProjectsUpdated = () => {
      setReloadTrigger((prev) => prev + 1);
    };
    window.addEventListener('alma:projects-updated', onProjectsUpdated);
    return () => {
      window.removeEventListener('alma:projects-updated', onProjectsUpdated);
    };
  }, []);

  const handleDisclaimerClose = () => {
    setShowDisclaimer(false);
    setDisclaimerAccepted();
    recordDisclaimerAcceptance();
  };

  const [showOnboardingModal, setShowOnboardingModal] = useState(false);

  const vantaRef = useRef<HTMLDivElement>(null);
  const [vantaEffect, setVantaEffect] = useState<VantaEffect | null>(null);
  const [threeLoaded, setThreeLoaded] = useState(false);
  const [vantaLoaded, setVantaLoaded] = useState(false);

  console.log('🔄 Component render:', { threeLoaded, vantaLoaded, hasRef: !!vantaRef.current, hasEffect: !!vantaEffect });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const checkProjectStructure = async (projectId: string) => {
    if (!projectId || !session?.accessToken) return;

    try {
      const response = await fetch(
        `/api/projects/${projectId}/folders/folder_id/${projectId}/contents`,
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

        const missing = REQUIRED_FOLDERS.filter(folder => !existingFolders.includes(folder));

        if (missing.length > 0) {
          setMissingFolders(missing);
          setShowMissingFoldersModal(true);
        }
      }
    } catch (error) {
      console.error('Error checking project structure:', error);
    }
  };

  useEffect(() => {
    console.log('🎨 Vanta useEffect triggered:', { threeLoaded, vantaLoaded, hasRef: !!vantaRef.current, hasEffect: !!vantaEffect });

    if (threeLoaded && vantaLoaded && vantaRef.current && !vantaEffect) {
      console.log('✨ Initializing Vanta HALO effect...');

      try {
        if (typeof window !== 'undefined' && window.VANTA) {
          const effect = window.VANTA.HALO({
            el: vantaRef.current,
            mouseControls: true,
            touchControls: true,
            gyroControls: false,
            minHeight: 200.0,
            minWidth: 200.0,
            xOffset: 0.1,
            yOffset: 0.1,
            size: 1.0,
            backgroundColor: 0x11074a,
            baseColor: 0x8a7fff,
            amplitudeFactor: 1.0,
            speed: 1.0
          });

          setVantaEffect(effect);
          console.log('✅ Vanta HALO effect initialized successfully');
        } else {
          console.error('❌ VANTA.HALO is not available');
        }
      } catch (error) {
        console.error('❌ Error initializing Vanta effect:', error);
      }
    }

    return () => {
      if (vantaEffect) {
        console.log('🧹 Cleaning up Vanta effect');
        try {
          vantaEffect.destroy();
        } catch (error) {
          console.error('Error destroying Vanta effect:', error);
        }
        setVantaEffect(null);
      }
    };
  }, [threeLoaded, vantaLoaded, vantaEffect]);

  const handleNewProject = (): void => {
    setShowPopup(true);
  };

  const handleClosePopup = () => {
    setShowPopup(false);
    setReloadTrigger(prev => prev + 1);
  };

  const handleRefreshProjects = () => {
    setIsRefreshing(true);
    setReloadTrigger(prev => prev + 1);
    setTimeout(() => {
      setIsRefreshing(false);
    }, 1000);
  };

  const handleAutoLoadProject = async (project: Project): Promise<void> => {
    setShowLoadingModal(true);
    setLoadingMessage(t('projectsPage.loadingProject'));
    
    try {
      setSelectedProject(project);
      
      setProjectFolder({
        projectId: project.id,
        folderName: project.name,
        files: [],
      });
      
      setLoadingMessage(t('projectsPage.newProjectSelected'));
      
      setTimeout(() => {
        setShowLoadingModal(false);
      }, 1500);
      
    } catch (error) {
      console.error("Failed to load project:", error);
      setLoadingMessage(t('projectsPage.failedToLoadProject'));
      setTimeout(() => {
        setShowLoadingModal(false);
      }, 2000);
    }
  };

  const handlePatchProject = (): void => {
    if (selectedProject) {
      const projectWithStructure = selectedProject as Project & { missingFolders?: string[] };
      const missingFolders = projectWithStructure.missingFolders || [];
      setMissingFolders(missingFolders);
      setShowMissingFoldersModal(true);
    } else {
      console.log("No project selected.");
    }
  };

  return (
    <>
      {}
      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js"
        strategy="afterInteractive"
        onLoad={() => {
          console.log('📦 Three.js loaded successfully');
          setThreeLoaded(true);
        }}
        onError={(error) => {
          console.error('❌ Failed to load Three.js:', error);
        }}
      />

      {}
      {threeLoaded && (
        <Script
          src="https://cdn.jsdelivr.net/npm/vanta@latest/dist/vanta.halo.min.js"
          strategy="afterInteractive"
          onLoad={() => {
            console.log('🌟 Vanta.js HALO loaded successfully');
            setVantaLoaded(true);
          }}
          onError={(error) => {
            console.error('❌ Failed to load Vanta.js:', error);
          }}
        />
      )}

      <main style={{ minHeight: "100vh", background: "#f8f9fa" }}>
        <style jsx>{`
          .all-projects-wrapper {
            background: #f8f9fa;
            border: none;
            box-shadow: none;
            margin: 2rem auto;
            width: 80%;
            max-width: 80%;
            padding: 2rem;
          }
          
          @keyframes slideDown {
            from {
              transform: translateY(-100%);
              opacity: 0;
            }
            to {
              transform: translateY(0);
              opacity: 1;
            }
          }
          @keyframes scaleIn {
            from {
              transform: translate(-50%, -50%) scale(0.8);
              opacity: 0;
            }
            to {
              transform: translate(-50%, -50%) scale(1);
              opacity: 1;
            }
          }
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>

        {}
        <div ref={vantaRef} style={styles.heroSection}>
          <div style={styles.heroContent}>
            <h1 style={styles.heroTitle}>{t('projectsPage.heroTitle')}</h1>
            <p style={styles.heroSubtitle}>{t('projectsPage.heroSubtitle')}</p>
          </div>
        </div>

        {}
        <div className="all-projects-wrapper">
          {}
          <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }} data-tour="projects-header-actions">
            <button
              onClick={handleNewProject}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.75rem 1.4rem',
                backgroundColor: '#11074A',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                fontSize: '0.95rem',
                fontWeight: '600',
                lineHeight: 1,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                boxShadow: '0 2px 4px rgba(17, 7, 74, 0.15)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#1a0f5c';
                e.currentTarget.style.transform = 'scale(1.02)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#11074A';
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {t('projectsPage.newButton')}
            </button>
            <button
              onClick={handleRefreshProjects}
              disabled={isRefreshing}
              data-tour="projects-refresh-btn"
              className={`alma-refresh-button ${isRefreshing ? 'loading' : ''}`}
              title={isRefreshing ? t('projectsPage.refreshTitleRefreshing') : t('projectsPage.refreshTitleIdle')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {isRefreshing ? t('projectsPage.refreshing') : t('projectsPage.refreshProjects')}
            </button>
          </div>

          <div data-tour="projects-table-container">
            <ProjectsTableUnified
              onSelectProject={handleAutoLoadProject}
              selectedProjectId={selectedProject?.id}
              onPatchProject={handlePatchProject}
              onNewProject={handleNewProject}
              loadingSetup={loadingSetup}
              reloadTrigger={reloadTrigger}
            />
          </div>
        </div>

        {}
        {showPopup && (
          <NewWorkflowPopup
            onClose={handleClosePopup}
          />
        )}

        <DisclaimerPopup
          isTriggered={showDisclaimer}
          onClose={handleDisclaimerClose}
        />

        {}
        <MissingFoldersModal
          isOpen={showMissingFoldersModal}
          onClose={() => setShowMissingFoldersModal(false)}
          projectId={selectedProject?.id || ''}
          missingFolders={missingFolders}
          totalFolders={getRequiredFoldersCount()}
        />

        {}
        <OnboardingModal
          isOpen={showOnboardingModal}
          onClose={() => setShowOnboardingModal(false)}
          onComplete={() => {
            console.log('Onboarding completed');
            setShowOnboardingModal(false);
          }}
          projectName={selectedProject?.name}
        />

        {}
        <ProjectLoadingModal
          isVisible={showLoadingModal}
          message={loadingMessage}
          projectName={selectedProject?.name}
        />
      </main>

    </>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  heroSection: {
    position: "relative",
    color: "white",
    padding: "4rem 2rem",
    borderRadius: "0px",
    margin: "0",
    width: "100%",
    minHeight: "360px",
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  heroContent: {
    maxWidth: "800px",
    margin: "0 auto",
    position: "relative",
    zIndex: 2,
    textAlign: "center",
  },
  heroTitle: {
    fontSize: "3rem",
    fontWeight: "700",
    margin: "0 0 1rem",
    lineHeight: "1.2",
    textShadow: "0 2px 4px rgba(0, 0, 0, 0.3)",
  },
  heroSubtitle: {
    fontSize: "1.25rem",
    margin: "0 0 2rem",
    opacity: "0.9",
    lineHeight: "1.6",
    textShadow: "0 1px 2px rgba(0, 0, 0, 0.3)",
  },
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    margin: "2rem auto",
    maxWidth: "80%",
    width: "100%",
    padding: "2rem 3rem",
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    backgroundColor: "#fff",
    color: "#333",
  },
  heading: {
    textAlign: "center",
    marginBottom: "1rem",
    fontSize: "2rem",
  },
  paragraph: {
    textAlign: "center",
    fontSize: "1.2rem",
  },
  button: {
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    backgroundColor: "#F5F5F5",
    color: "#333",
    border: "1px solid #bbb",
    borderRadius: "4px",
    cursor: "pointer",
    display: "block",
    margin: "1rem auto",
    transition: "background-color 0.2s ease",
  },
  successMessage: {
    backgroundColor: "#d4edda",
    color: "#155724",
    padding: "0.5rem 1rem",
    borderRadius: "4px",
    marginBottom: "1rem",
    textAlign: "center",
  },
  projectsSection: {
    background: "#ffffff",
    borderRadius: "8px",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
    overflow: "hidden",
    margin: "2rem auto",
    width: "80%",
    maxWidth: "80%",
    padding: "2rem",
  },
  sectionHeader: {
    padding: "2rem 2rem 1rem",
    background: "linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)",
    borderBottom: "1px solid #dee2e6",
  },

  tableWrapper: {
    padding: "1.5rem",
    background: "#ffffff",
  },

  rootManagerWrapper: {
    padding: "0 2rem 1rem",
    backgroundColor: "#ffffff",
    borderBottom: "1px solid #f1f3f4",
  },

}; 