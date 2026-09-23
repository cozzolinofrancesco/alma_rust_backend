'use client';

import DOMPurify from 'dompurify';
import { useState } from 'react';

const MAX_AGENT_NAME_LENGTH = 50;

interface AgentNameModalProps {
  onClose: () => void;
  onCreateAgent: (agentName: string) => Promise<void>;
  isSubmitting?: boolean;
  errorMessage?: string | null;
}

const AgentNameModal: React.FC<AgentNameModalProps> = ({ 
  onClose, 
  onCreateAgent, 
  isSubmitting = false,
  errorMessage: externalError = null 
}) => {
  const [name, setName] = useState('');
  const [internalError, setInternalError] = useState<string | null>(null);

  const errorMessage = externalError || internalError;

  const sanitizeInput = (input: string) =>
    DOMPurify.sanitize(input);

  const handleCreate = async () => {
    setInternalError(null);
    const sanitized = sanitizeInput(name.trim());
    
    if (!sanitized) {
      return setInternalError('Agent name is required.');
    }
    
    if (sanitized.length > MAX_AGENT_NAME_LENGTH) {
      return setInternalError(`Agent name must be at most ${MAX_AGENT_NAME_LENGTH} characters.`);
    }
    
    if (!/^[a-zA-Z0-9 _-]+$/.test(sanitized)) {
      return setInternalError('Agent name can only contain letters, numbers, spaces, underscores or hyphens.');
    }
    
    setName(sanitized);
    await onCreateAgent(sanitized);
  };

  return (
    <div className="popup-overlay">
      <div className="floating-input-container">
        {errorMessage && <div className="error-box">{errorMessage}</div>}

        <div className="input-group">
          <input
            type="text"
            className="floating-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={`Enter agent name (max ${MAX_AGENT_NAME_LENGTH} chars)`}
            disabled={isSubmitting}
            maxLength={MAX_AGENT_NAME_LENGTH}
            onKeyPress={(e) => {
              if (e.key === 'Enter' && name.trim() && !isSubmitting) {
                handleCreate();
              }
            }}
          />
          <button
            onClick={handleCreate}
            disabled={!name.trim() || isSubmitting}
            className="create-btn"
          >
            {isSubmitting ? 'Creating...' : 'Create Agent'}
          </button>
        </div>

        {isSubmitting && (
          <div className="loading-indicator">
            <div className="loading-spinner"></div>
            <span>Creating agent...</span>
          </div>
        )}

        <button onClick={onClose} className="close-btn-floating" disabled={isSubmitting}>×</button>
      </div>

      <style jsx>{`
  .popup-overlay {
    position: fixed;
    inset: 0;
    background: rgba(17, 7, 74, 0.6);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10100;
    animation: fadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  @keyframes fadeIn {
    from { 
      opacity: 0; 
      backdrop-filter: blur(0px);
      -webkit-backdrop-filter: blur(0px);
    }
    to { 
      opacity: 1; 
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
  }

  @keyframes slideUp {
    from { 
      opacity: 0;
      transform: translateY(40px) scale(0.92);
      filter: blur(4px);
    }
    to { 
      opacity: 1;
      transform: translateY(0) scale(1);
      filter: blur(0px);
    }
  }

  .floating-input-container {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    animation: slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .input-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 12px;
    padding: 0.5rem;
    box-shadow: 0 8px 32px rgba(17, 7, 74, 0.2);
  }

  .floating-input {
    background: transparent;
    border: none;
    color: white;
    font-size: 1rem;
    padding: 0.75rem 1rem;
    min-width: 300px;
    outline: none;
    transition: all 0.2s ease;
  }

  .floating-input::placeholder {
    color: rgba(255, 255, 255, 0.7);
  }

  .floating-input:focus {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 8px;
  }

  .floating-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .create-btn {
    background: rgba(255, 255, 255, 0.2);
    color: white;
    border: none;
    border-radius: 8px;
    padding: 0.75rem 1.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
  }

  .create-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.3);
    transform: translateY(-1px);
  }

  .create-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .loading-indicator {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: white;
    font-size: 0.9rem;
  }

  .loading-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top: 2px solid white;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .close-btn-floating {
    position: absolute;
    top: -2rem;
    right: -2rem;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    border: none;
    border-radius: 50%;
    width: 32px;
    height: 32px;
    font-size: 1.2rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s ease;
  }

  .close-btn-floating:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }

  .close-btn-floating:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error-box {
    background: rgba(220, 38, 38, 0.9);
    color: white;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    font-size: 0.9rem;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
`}</style>
    </div>
  );
};

export default AgentNameModal; 