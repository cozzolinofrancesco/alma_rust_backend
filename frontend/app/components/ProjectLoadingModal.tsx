'use client';

import { useEffect } from 'react';

interface ProjectLoadingModalProps {
  isVisible: boolean;
  message: string;
  projectName?: string;
}

const ProjectLoadingModal: React.FC<ProjectLoadingModalProps> = ({ 
  isVisible, 
  message, 
  projectName 
}) => {
  useEffect(() => {
    if (isVisible) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <div className="project-loading-overlay">
      <div className="project-loading-modal">
        <div className="loading-content">
          <div className="loading-spinner"></div>
          <div className="loading-message">{message}</div>
          {projectName && (
            <div className="project-name">{projectName}</div>
          )}
        </div>
      </div>

      <style jsx>{`
        .project-loading-overlay {
          position: fixed;
          inset: 0;
          background: rgba(17, 7, 74, 0.4);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          animation: fadeIn 0.2s ease-out;
        }

        @keyframes fadeIn {
          from { 
            opacity: 0;
            backdrop-filter: blur(0px);
            -webkit-backdrop-filter: blur(0px);
          }
          to { 
            opacity: 1;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
          }
        }

        @keyframes slideIn {
          from { 
            opacity: 0;
            transform: translateY(-20px) scale(0.95);
          }
          to { 
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        .project-loading-modal {
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.3);
          border-radius: 16px;
          padding: 2rem;
          box-shadow: 
            0 20px 60px rgba(17, 7, 74, 0.2),
            0 8px 32px rgba(17, 7, 74, 0.1);
          animation: slideIn 0.3s ease-out;
          min-width: 300px;
          max-width: 400px;
          text-align: center;
        }

        .loading-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1rem;
        }

        .loading-spinner {
          width: 32px;
          height: 32px;
          border: 3px solid rgba(17, 7, 74, 0.2);
          border-top: 3px solid #11074A;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        .loading-message {
          color: #11074A;
          font-size: 1.1rem;
          font-weight: 600;
          margin: 0;
        }

        .project-name {
          color: #6B7280;
          font-size: 0.9rem;
          margin: 0;
          font-style: italic;
        }
      `}</style>
    </div>
  );
};

export default ProjectLoadingModal; 