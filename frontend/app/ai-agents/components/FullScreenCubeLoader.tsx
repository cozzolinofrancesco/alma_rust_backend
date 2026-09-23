import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './fullscreen-cube-loader.module.css';

interface FullScreenCubeLoaderProps {
  isVisible: boolean;
  agentName?: string;
  onComplete?: () => void;
  duration?: number;
}

const FullScreenCubeLoader: React.FC<FullScreenCubeLoaderProps> = ({ 
  isVisible, 
  agentName = "Agent",
  onComplete,
  duration = 1200 
}) => {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setPortalContainer(document.body);
    }
  }, []);

  useEffect(() => {
    if (isVisible && onComplete) {
      const timer = setTimeout(() => {
        onComplete();
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [isVisible, onComplete, duration]);

  if (!isVisible || !portalContainer) return null;

  const loaderContent = (
    <div className={styles['agent-loading-overlay']}>
      <div className={styles['agent-loading-container']}>
        <div className={styles['agent-loading-cube']}>
          <div className={`${styles['agent-loading-cube-face']} ${styles['agent-loading-cube-front']}`}></div>
          <div className={`${styles['agent-loading-cube-face']} ${styles['agent-loading-cube-back']}`}></div>
          <div className={`${styles['agent-loading-cube-face']} ${styles['agent-loading-cube-right']}`}></div>
          <div className={`${styles['agent-loading-cube-face']} ${styles['agent-loading-cube-left']}`}></div>
          <div className={`${styles['agent-loading-cube-face']} ${styles['agent-loading-cube-top']}`}></div>
          <div className={`${styles['agent-loading-cube-face']} ${styles['agent-loading-cube-bottom']}`}></div>
        </div>
        <div className={styles['agent-loading-text']}>
          <h3>Preparing Agent Preview</h3>
          <p>Loading {agentName} details...</p>
        </div>
      </div>
    </div>
  );

  return createPortal(loaderContent, portalContainer);
};

export default FullScreenCubeLoader; 