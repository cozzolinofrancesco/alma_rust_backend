'use client';

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import '../ai-agents/style.css';

interface LoadingOverlayProps {
  show: boolean;
}

const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ show }) => {
  const [isBrowser, setIsBrowser] = useState(false);
  const [isHidden, setIsHidden] = useState(false);

  useEffect(() => {
    setIsBrowser(true);
  }, []);

  useEffect(() => {
    if (!show) {
      setIsHidden(false);
    }
  }, [show]);

  if (!show || !isBrowser) {
    return null;
  }

  if (isHidden) {
    const smallIndicator = (
      <div 
        onClick={() => setIsHidden(false)}
        style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          width: '60px',
          height: '60px',
          background: 'rgba(17, 7, 74, 0.9)',
          borderRadius: '12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 9999,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
          border: '2px solid rgba(175, 168, 186, 0.3)',
          transition: 'all 0.3s ease'
        }}
        title="Step is running in background. Click to show progress."
      >
        <div 
          className="small-cube"
          style={{
            width: '24px',
            height: '24px',
            position: 'relative',
            transformStyle: 'preserve-3d',
            animation: 'trueCube3D 2s linear infinite'
          }}
        >
          <div className="small-cube-face small-cube-front"></div>
          <div className="small-cube-face small-cube-back"></div>
          <div className="small-cube-face small-cube-right"></div>
          <div className="small-cube-face small-cube-left"></div>
          <div className="small-cube-face small-cube-top"></div>
          <div className="small-cube-face small-cube-bottom"></div>
        </div>
      </div>
    );

    return ReactDOM.createPortal(smallIndicator, document.body);
  }

  const overlay = (
    <div 
      className="big-cube-overlay"
      onClick={() => setIsHidden(true)}
      style={{ 
        cursor: 'pointer',
        userSelect: 'none'
      }}
      title="Click to hide overlay (step continues running)"
    >
      <div className="big-cube">
        <div className="big-cube-face front"></div>
        <div className="big-cube-face back"></div>
        <div className="big-cube-face right"></div>
        <div className="big-cube-face left"></div>
        <div className="big-cube-face top"></div>
        <div className="big-cube-face bottom"></div>
      </div>
      
      {}
      <div style={{
        position: 'absolute',
        bottom: '20%',
        left: '50%',
        transform: 'translateX(-50%)',
        color: 'white',
        fontSize: '1.1rem',
        fontWeight: '500',
        textAlign: 'center',
        textShadow: '0 2px 4px rgba(0,0,0,0.5)',
        animation: 'fadeInOut 2s infinite ease-in-out'
      }}>
        Click to hide (step keeps running)
      </div>
    </div>
  );

  return ReactDOM.createPortal(overlay, document.body);
};

export default LoadingOverlay; 