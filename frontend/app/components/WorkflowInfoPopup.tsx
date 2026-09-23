import React, { useEffect } from 'react';
import { useProjectState } from './ProjectStateContext';

interface WorkflowInfoPopupProps {
  workflow: {
    id: string;
    name: string;
  };
  onClose: () => void;
}

const WorkflowInfoPopup: React.FC<WorkflowInfoPopupProps> = ({ workflow, onClose }) => {
  const { setProjectFolder } = useProjectState();

  const handleOpenFolder = () => {
    console.log("Opening folder for workflow:", workflow);
    setProjectFolder({
      projectId: workflow.id,
      folderName: workflow.name,
      files: [],
    });
    console.log("Global project folder state updated to:", {
      projectId: workflow.id,
      folderName: workflow.name,
      files: []
    });
    onClose();
  };

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const popupElement = document.querySelector('.popup-content');
      if (popupElement && !popupElement.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [onClose]);

  return (
    <div className="project-info-popup">
      <div className="popup-content">
        <h2>{workflow.name}</h2>
        <button onClick={handleOpenFolder} className="google-style-button">
          Open Folder
        </button>
        <button onClick={onClose} className="google-style-button">
          Close
        </button>
      </div>
    </div>
  );
};

export default WorkflowInfoPopup;
