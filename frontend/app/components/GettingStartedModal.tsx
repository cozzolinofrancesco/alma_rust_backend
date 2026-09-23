'use client';

import React, { useState, useEffect } from 'react';

interface GettingStartedModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function GettingStartedModal({ isOpen, onClose }: GettingStartedModalProps) {
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const steps = [
    {
      title: "Create Project",
      description: "Start by creating a new research project. This will be your workspace where you can organize files, documents, and collaborate with your team.",
      icon: "1",
      action: "Create Project",
      link: "/projects"
    },
    {
      title: "Create Agent",
      description: "Set up an AI agent to help automate your research workflows. Agents can assist with data analysis, literature reviews, and more.",
      icon: "2",
      action: "Create Agent", 
      link: "/ai-agents"
    }
  ];

  const currentStepData = steps[currentStep];

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleStepAction = () => {
    window.location.href = currentStepData.link;
  };

  const handleClose = () => {
    setCurrentStep(0);
    onClose();
  };

  return (
    <div style={styles.overlay} onClick={handleClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {}
        <div style={styles.header}>
          <h2 style={styles.title}>Getting Started with ALMA</h2>
          <button style={styles.closeButton} onClick={handleClose}>×</button>
        </div>

        {}
        <div style={styles.progressContainer}>
          {steps.map((_, index) => (
            <div key={index} style={{
              ...styles.progressDot,
              ...(index === currentStep ? styles.progressDotActive : {}),
              ...(index < currentStep ? styles.progressDotCompleted : {})
            }} />
          ))}
        </div>

        {}
        <div style={styles.content}>
          <div style={styles.stepIcon}>{currentStepData.icon}</div>
          <h3 style={styles.stepTitle}>{currentStepData.title}</h3>
          <p style={styles.stepDescription}>{currentStepData.description}</p>
        </div>

        {}
        <div style={styles.actions}>
          <div style={styles.navigation}>
            {currentStep > 0 && (
              <button style={styles.navButton} onClick={handlePrevious}>
                ← Previous
              </button>
            )}
            {currentStep < steps.length - 1 && (
              <button style={styles.navButton} onClick={handleNext}>
                Next →
              </button>
            )}
          </div>
          
          <button style={styles.actionButton} onClick={handleStepAction}>
            {currentStepData.action}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'var(--alma-overlay)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: '120px',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: 'var(--alma-surface)',
    borderRadius: '16px',
    padding: '2rem',
    maxWidth: '500px',
    width: '90%',
    maxHeight: '80vh',
    position: 'relative',
    boxShadow: '0 20px 40px rgba(0, 0, 0, 0.15)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '2rem',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: '600',
    color: 'var(--alma-text)',
    margin: 0,
  },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: '2rem',
    cursor: 'pointer',
    color: 'var(--alma-text-muted)',
    padding: 0,
    lineHeight: 1,
  },
  progressContainer: {
    display: 'flex',
    justifyContent: 'center',
    gap: '1rem',
    marginBottom: '2rem',
  },
  progressDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    backgroundColor: 'var(--alma-border)',
    transition: 'all 0.3s ease',
  },
  progressDotActive: {
    backgroundColor: 'var(--alma-accent)',
    transform: 'scale(1.2)',
  },
  progressDotCompleted: {
    backgroundColor: 'var(--alma-success)',
  },
  content: {
    textAlign: 'center',
    marginBottom: '2rem',
  },
  stepIcon: {
    width: '80px',
    height: '80px',
    borderRadius: '50%',
    backgroundColor: 'var(--alma-accent)',
    color: 'var(--alma-on-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '2rem',
    fontWeight: '600',
    margin: '0 auto 1rem',
  },
  stepTitle: {
    fontSize: '1.5rem',
    fontWeight: '600',
    color: 'var(--alma-text)',
    marginBottom: '1rem',
  },
  stepDescription: {
    fontSize: '1rem',
    color: 'var(--alma-text-muted)',
    lineHeight: '1.6',
    marginBottom: '2rem',
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  navigation: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  navButton: {
    background: 'none',
    border: '2px solid var(--alma-accent)',
    color: 'var(--alma-accent)',
    padding: '0.5rem 1rem',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: '600',
    transition: 'all 0.2s ease',
  },
  actionButton: {
    backgroundColor: 'var(--alma-accent)',
    color: 'var(--alma-on-accent)',
    border: 'none',
    padding: '1rem 2rem',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    width: '100%',
  },
}; 