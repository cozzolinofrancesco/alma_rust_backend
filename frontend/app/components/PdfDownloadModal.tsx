import React, { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useProjectState } from './ProjectStateContext';

interface PdfDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  pdfUrl: string;
  paperTitle: string;
  doi: string;
}

const PdfDownloadModal: React.FC<PdfDownloadModalProps> = ({
  isOpen,
  onClose,
  pdfUrl,
  paperTitle,
  doi
}) => {
  const { data: session } = useSession();
  const { projectFolder } = useProjectState();
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [hasAcceptedDisclaimer, setHasAcceptedDisclaimer] = useState(false);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleRedirect = () => {
    if (!hasAcceptedDisclaimer) {
      return;
    }
    
    window.open(pdfUrl, '_blank', 'noopener,noreferrer');
    onClose();
  };

  const handleDownloadToProject = async () => {
    if (!hasAcceptedDisclaimer) {
      return;
    }
    
    if (!projectFolder || !session?.accessToken) {
      alert('Please select a project first to save the PDF.');
      return;
    }

    setIsDownloading(true);
    setDownloadStatus('idle');

    try {
      const sanitizedTitle = paperTitle
        .replace(/[^a-zA-Z0-9\s\-_]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 50);
      
      const filename = `${sanitizedTitle}_${doi.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

      const response = await fetch('/api/download-pdf', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pdfUrl,
          filename,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to download PDF from publisher');
      }

      const pdfBlob = await response.blob();

      const formData = new FormData();
      formData.append('file', pdfBlob, filename);

      const uploadResponse = await fetch(
        `/api/projects/${projectFolder.projectId}/folders/PDFs/files`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.accessToken}`,
          },
          body: formData,
        }
      );

      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json();
        throw new Error(errorData.error || 'Failed to upload PDF to project');
      }

      setDownloadStatus('success');
      setTimeout(() => {
        onClose();
      }, 2000);

    } catch (error) {
      console.error('Error downloading PDF to project:', error);
      setDownloadStatus('error');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="pdf-modal-overlay" onClick={onClose}>
      <div className="pdf-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="pdf-modal-header">
          <h3>PDF Download Options</h3>
          <button className="pdf-modal-close" onClick={onClose}>×</button>
        </div>
        
        <div className="pdf-modal-body">
          <div className="pdf-paper-info">
            <h4>{paperTitle}</h4>
            <p className="pdf-doi">DOI: {doi}</p>
          </div>

          {}
          <div className="pdf-disclaimer">
            <div className="disclaimer-content">
              <h5>Copyright Notice</h5>
              <p>
                PDFs from DOI.org are for personal academic use only and remain under the original copyright—check the paper's license or publisher's terms before sharing or adapting. For any use beyond private study or fair use, obtain explicit permission from the copyright holder.
              </p>
            </div>
            <label className="disclaimer-checkbox">
              <input
                type="checkbox"
                checked={hasAcceptedDisclaimer}
                onChange={(e) => setHasAcceptedDisclaimer(e.target.checked)}
              />
              <span>I understand and agree to these terms</span>
            </label>
          </div>

          <div className={`pdf-options ${!hasAcceptedDisclaimer ? 'disabled' : ''}`}>
            <div className="pdf-option">
              <h5>Open in Browser</h5>
              <p>View the PDF directly from the publisher's website</p>
              <button 
                className={`pdf-option-btn primary ${!hasAcceptedDisclaimer ? 'disabled' : ''}`}
                onClick={handleRedirect}
                disabled={!hasAcceptedDisclaimer}
              >
                Open PDF
              </button>
            </div>

            <div className="pdf-option">
              <h5>Save to Project</h5>
              {projectFolder ? (
                <>
                  <p>Download and save to: <strong>{projectFolder.folderName}</strong> → PDFs folder</p>
                  <button 
                    className={`pdf-option-btn secondary ${!hasAcceptedDisclaimer ? 'disabled' : ''}`}
                    onClick={handleDownloadToProject}
                    disabled={isDownloading || !hasAcceptedDisclaimer}
                  >
                    {isDownloading ? 'Downloading...' : 'Save to Project'}
                  </button>
                  {downloadStatus === 'success' && (
                    <div className="pdf-status success">PDF saved successfully!</div>
                  )}
                  {downloadStatus === 'error' && (
                    <div className="pdf-status error">Failed to save PDF. Please try again.</div>
                  )}
                </>
              ) : (
                <>
                  <p className="pdf-no-project">No project selected. Please select a project first.</p>
                  <button className="pdf-option-btn disabled" disabled>
                    Save to Project
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PdfDownloadModal; 