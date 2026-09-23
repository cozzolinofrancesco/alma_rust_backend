import React, { useState } from 'react';
import WorkflowInfoPopup from './WorkflowInfoPopup';

interface WorkflowCardProps {
  id: string;
  name: string;
}

const WorkflowCard: React.FC<WorkflowCardProps> = ({ id, name }) => {
  const [showPopup, setShowPopup] = useState(false);

  const handleCardClick = () => {
    setShowPopup(true);
  };

  const handleClosePopup = () => {
    setShowPopup(false);
  };

  return (
    <>
      <div className="workflow-card" onClick={handleCardClick}>
        <h3 className="font-bold text-xl">{name}</h3>
      </div>
      {showPopup && (
        <WorkflowInfoPopup
          workflow={{ id, name }}
          onClose={handleClosePopup}
        />
      )}
    </>
  );
};

export default WorkflowCard;
