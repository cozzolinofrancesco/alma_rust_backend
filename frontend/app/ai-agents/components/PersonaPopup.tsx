import React, { useEffect, useRef } from 'react';
import { FaTimes } from 'react-icons/fa';
import SystemInstructionsSelector from '../../components/SystemInstructionsSelector';

interface PersonaPopupProps {
    isVisible: boolean;
    onClose: () => void;
    onPersonaSelect: (instruction: string) => void;
    currentInstruction: string;
}

const PersonaPopup: React.FC<PersonaPopupProps> = ({
    isVisible,
    onClose,
    onPersonaSelect,
    currentInstruction
}) => {
    const popupRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleEscapeKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        if (isVisible) {
            document.addEventListener('keydown', handleEscapeKey);
        }

        return () => {
            document.removeEventListener('keydown', handleEscapeKey);
        };
    }, [isVisible, onClose]);

    const handleInstructionsChange = (instruction: string) => {
        onPersonaSelect(instruction);
        onClose();
    };

    if (!isVisible) return null;

    return (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                zIndex: 12000
            }}
            onClick={onClose}
        >
            <div
                ref={popupRef}
                onClick={(e) => e.stopPropagation()}
                style={{
                    position: 'fixed',
                    top: '40%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    backgroundColor: '#ffffff',
                    border: '1px solid #e9ecef',
                    borderRadius: '12px',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)',
                    maxWidth: '600px',
                    width: '90%',
                    maxHeight: '80vh',
                    overflow: 'auto',
                    zIndex: 12001
                }}
            >
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '20px 24px 16px 24px',
                    borderBottom: '1px solid #e9ecef'
                }}>
                    <h3 style={{
                        margin: 0,
                        color: '#11074A',
                        fontSize: '18px',
                        fontWeight: '600'
                    }}>
                        Select Agent Persona
                    </h3>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            color: '#6c757d',
                            fontSize: '16px',
                            padding: '8px',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '32px',
                            height: '32px'
                        }}
                        aria-label="Close persona selector"
                    >
                        <FaTimes />
                    </button>
                </div>

                <SystemInstructionsSelector
                    onInstructionsChange={handleInstructionsChange}
                    currentInstruction={currentInstruction}
                />
            </div>
        </div>
    );
};

export default PersonaPopup; 