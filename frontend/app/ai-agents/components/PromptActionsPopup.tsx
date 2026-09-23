import React from 'react';
import ReactDOM from 'react-dom';
import { FaExpand, FaMagic, FaTimes, FaUser } from 'react-icons/fa';
import '../style.css';

interface PromptActionsPopupProps {
  onClose: () => void;
  onSelectPersona: () => void;
  onExpandEditor: () => void;
  onEnhancePrompt: () => void;
  position: { top: number; left: number };
}

const PromptActionsPopup: React.FC<PromptActionsPopupProps> = ({
  onClose,
  onSelectPersona,
  onExpandEditor,
  onEnhancePrompt,
  position,
}) => {
  return ReactDOM.createPortal(
    <div className="prompt-actions-overlay" onClick={onClose}>
      <div
        className="prompt-actions-popup"
        style={{ top: position.top, left: position.left }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prompt-actions-header">
          <h3>Prompt Actions</h3>
          <button onClick={onClose} className="prompt-actions-close-btn">
            <FaTimes />
          </button>
        </div>
        <div className="prompt-actions-body">
          <button onClick={onSelectPersona}>
            <FaUser />
            <span>Persona</span>
          </button>
          <button onClick={onExpandEditor}>
            <FaExpand />
            <span>Guided Prompt</span>
          </button>
          <button onClick={onEnhancePrompt}>
            <FaMagic />
            <span>Magic Prompt</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default PromptActionsPopup; 