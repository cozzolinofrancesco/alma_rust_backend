'use client';

import React, { useState, useEffect } from 'react';
import { useSharedSession } from './SharedSessionProvider';

interface MissingFoldersModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  missingFolders: string[];
  totalFolders: number;
}

interface CreateSubfolderResponse {
  subfolder_id: string;
  subfolder_name: string;
  parent_folder_id: string;
  message: string;
}

const MissingFoldersModal: React.FC<MissingFoldersModalProps> = ({
  isOpen,
  onClose,
  projectId,
  missingFolders,
  totalFolders
}) => {
  const { session } = useSharedSession();
  const [isHealing, setIsHealing] = useState(false);
  const [healingProgress, setHealingProgress] = useState(0);
  const [completedFolders, setCompletedFolders] = useState<string[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string>('');
  const [estimatedTime, setEstimatedTime] = useState(0);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen]);

  const foundFolders = totalFolders - missingFolders.length;
  const progressPercentage = Math.round((foundFolders / totalFolders) * 100);

  const createSubfolder = async (
    token: string,
    projectId: string,
    parentFolderId: string,
    subfolderName: string
  ): Promise<CreateSubfolderResponse> => {
    const response = await fetch('/api/create-subfolder', {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json',
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
      throw new Error(errorData.error || 'Failed to create subfolder');
    }

    return response.json() as Promise<CreateSubfolderResponse>;
  };

  const handleHealProject = async () => {
    if (!session?.accessToken) {
      alert('Authentication required. Please refresh the page.');
      return;
    }

    setIsHealing(true);
    setHealingProgress(0);
    setCompletedFolders([]);
    setEstimatedTime(missingFolders.length * 2);

    try {
      for (let i = 0; i < missingFolders.length; i++) {
        const folderName = missingFolders[i];
        setCurrentFolder(folderName);
        
        const progress = Math.round(((i) / missingFolders.length) * 100);
        setHealingProgress(progress);
        setEstimatedTime((missingFolders.length - i) * 2);

        try {
          await createSubfolder(
            session.accessToken,
            projectId,
            projectId,
            folderName
          );

          setCompletedFolders(prev => [...prev, folderName]);
          
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`Error creating folder ${folderName}:`, error);
        }
      }

      setHealingProgress(100);
      setCurrentFolder('');
      setEstimatedTime(0);

      setTimeout(() => {
        setIsHealing(false);
        onClose();
        window.location.reload();
      }, 2000);

    } catch (error) {
      console.error('Error healing project:', error);
      alert('Failed to heal project. Please try again.');
      setIsHealing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(248, 250, 252, 0.8)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10001,
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      {!isHealing ? (
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '12px',
          width: '90%',
          maxWidth: '500px',
          border: '1px solid #AFA8BA',
          overflow: 'hidden',
          boxShadow: 'none'
        }}>
          {}
          <div style={{
            backgroundColor: '#11074A',
            color: '#FFFFFF',
            padding: '1.5rem',
            textAlign: 'center'
          }}>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '600' }}>
              Project Configuration
            </h2>
          </div>

          {}
          <div style={{ padding: '2rem' }}>
            <h3 style={{
              margin: '0 0 1rem 0',
              fontSize: '1.1rem',
              fontWeight: '600',
              color: '#4A4453',
              textAlign: 'center'
            }}>
              Missing Required Folders
            </h3>

            {}
            <div style={{
              backgroundColor: '#f0f9ff',
              border: '1px solid #bae6fd',
              borderRadius: '8px',
              padding: '1rem',
              marginBottom: '1.5rem',
              textAlign: 'center'
            }}>
              <div style={{
                color: '#0c4a6e',
                fontSize: '0.9rem',
                fontWeight: '500',
                marginBottom: '0.5rem'
              }}>
                ✅ Don't worry - your data is safe!
              </div>
              <div style={{
                color: '#0c4a6e',
                fontSize: '0.85rem',
                lineHeight: '1.4'
              }}>
                Adding these folders will not affect any existing files or data in your project. 
                We're only creating the missing folder structure to enable all ALMA features.
              </div>
            </div>

            {}
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{
                color: '#4A4453',
                fontSize: '0.9rem',
                marginBottom: '0.5rem',
                fontWeight: '600'
              }}>
                PROJECT STATUS:
              </div>
              <div style={{
                color: '#4A4453',
                fontSize: '0.85rem',
                marginBottom: '0.5rem'
              }}>
                Found: {foundFolders}/{totalFolders} folders
              </div>
              
              {}
              <div style={{
                width: '100%',
                height: '8px',
                backgroundColor: '#AFA8BA',
                borderRadius: '4px',
                marginBottom: '0.5rem',
                overflow: 'hidden'
              }}>
                <div style={{
                  width: `${progressPercentage}%`,
                  height: '100%',
                  backgroundColor: '#11074A',
                  transition: 'width 0.3s ease'
                }} />
              </div>
              <div style={{
                color: '#4A4453',
                fontSize: '0.85rem'
              }}>
                Missing: {missingFolders.length}/{totalFolders} folders
              </div>
            </div>

            {}
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{
                color: '#4A4453',
                fontSize: '0.9rem',
                fontWeight: '600',
                marginBottom: '0.5rem'
              }}>
                IMPACT:
              </div>
              <ul style={{
                margin: 0,
                paddingLeft: '1.2rem',
                color: '#4A4453',
                fontSize: '0.85rem',
                lineHeight: '1.4'
              }}>
                <li>Limited AI agent functionality</li>
                <li>Missing analysis capabilities</li>
                <li>Reduced workflow options</li>
              </ul>
            </div>

            {}
            <div style={{ marginBottom: '2rem' }}>
              <div style={{
                color: '#4A4453',
                fontSize: '0.9rem',
                fontWeight: '600',
                marginBottom: '0.5rem'
              }}>
                MISSING FOLDERS:
              </div>
              <div style={{
                color: '#4A4453',
                fontSize: '0.85rem',
                lineHeight: '1.4',
                backgroundColor: '#F8FAFC',
                padding: '0.75rem',
                borderRadius: '6px',
                border: '1px solid #AFA8BA'
              }}>
                {missingFolders.join(', ')}
              </div>
            </div>

            {}
            <div style={{
              display: 'flex',
              gap: '1rem',
              justifyContent: 'center'
            }}>
              <button
                onClick={handleHealProject}
                style={{
                  backgroundColor: '#11074A',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0.75rem 1.5rem',
                  fontSize: '0.9rem',
                  fontWeight: '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
                onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#0F0640'}
                onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#11074A'}
              >
                Add Missing Folders
              </button>
              
              <button
                onClick={onClose}
                style={{
                  backgroundColor: '#AFA8BA',
                  color: '#4A4453',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0.75rem 1.5rem',
                  fontSize: '0.9rem',
                  fontWeight: '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
                onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#9B9AAB'}
                onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#AFA8BA'}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '12px',
          width: '90%',
          maxWidth: '500px',
          border: '1px solid #AFA8BA',
          overflow: 'hidden',
          boxShadow: 'none'
        }}>
          {}
          <div style={{
            backgroundColor: '#11074A',
            color: '#FFFFFF',
            padding: '1.5rem',
            textAlign: 'center'
          }}>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '600' }}>
              Healing Project Structure
            </h2>
          </div>

          {}
          <div style={{ padding: '2rem' }}>
            <div style={{
              textAlign: 'center',
              color: '#4A4453',
              fontSize: '1rem',
              marginBottom: '1.5rem'
            }}>
              Creating missing folders
            </div>

            {}
            <div style={{
              width: '100%',
              height: '12px',
              backgroundColor: '#AFA8BA',
              borderRadius: '6px',
              marginBottom: '0.5rem',
              overflow: 'hidden'
            }}>
              <div style={{
                width: `${healingProgress}%`,
                height: '100%',
                backgroundColor: '#11074A',
                transition: 'width 0.3s ease'
              }} />
            </div>
            <div style={{
              textAlign: 'center',
              color: '#4A4453',
              fontSize: '0.9rem',
              marginBottom: '2rem'
            }}>
              {healingProgress}%
            </div>

            {}
            <div style={{ marginBottom: '1.5rem' }}>
              {}
              {completedFolders.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{
                    color: '#4A4453',
                    fontSize: '0.9rem',
                    fontWeight: '600',
                    marginBottom: '0.5rem'
                  }}>
                    COMPLETED:
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#4A4453' }}>
                    {completedFolders.map(folder => (
                      <div key={folder} style={{ marginBottom: '0.25rem' }}>
                        ✓ {folder}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {}
              {currentFolder && (
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{
                    color: '#4A4453',
                    fontSize: '0.9rem',
                    fontWeight: '600',
                    marginBottom: '0.5rem'
                  }}>
                    IN PROGRESS:
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#11074A' }}>
                    → {currentFolder}
                  </div>
                </div>
              )}

              {}
              {missingFolders.filter(f => !completedFolders.includes(f) && f !== currentFolder).length > 0 && (
                <div>
                  <div style={{
                    color: '#4A4453',
                    fontSize: '0.9rem',
                    fontWeight: '600',
                    marginBottom: '0.5rem'
                  }}>
                    PENDING:
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#4A4453' }}>
                    {missingFolders
                      .filter(f => !completedFolders.includes(f) && f !== currentFolder)
                      .map(folder => (
                        <div key={folder} style={{ marginBottom: '0.25rem' }}>
                          • {folder}
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>

            {}
            {estimatedTime > 0 && (
              <div style={{
                textAlign: 'center',
                color: '#4A4453',
                fontSize: '0.85rem'
              }}>
                Estimated time remaining: {estimatedTime} seconds
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MissingFoldersModal; 