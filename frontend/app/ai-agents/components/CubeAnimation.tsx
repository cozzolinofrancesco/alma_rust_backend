import React, { useState, useEffect } from 'react';
import './cube-animation.module.css';

interface CubeAnimationProps {
  isAnimating: boolean;
  onAnimationComplete?: () => void;
  size?: number;
}

const CubeAnimation: React.FC<CubeAnimationProps> = ({ 
  isAnimating, 
  onAnimationComplete,
  size = 24 
}) => {
  const [animationPhase, setAnimationPhase] = useState<'idle' | 'spinning' | 'complete'>('idle');

  useEffect(() => {
    if (isAnimating && animationPhase === 'idle') {
      setAnimationPhase('spinning');
      
      const timer = setTimeout(() => {
        setAnimationPhase('complete');
        onAnimationComplete?.();
        
        setTimeout(() => {
          setAnimationPhase('idle');
        }, 200);
      }, 1200);

      return () => clearTimeout(timer);
    }
  }, [isAnimating, animationPhase, onAnimationComplete]);

  return (
    <div 
      className={`cube-animation-container ${animationPhase}`}
      style={{ 
        width: `${size}px`, 
        height: `${size}px`,
        perspective: `${size * 4}px`
      }}
    >
      <div className="cube" style={{ width: `${size}px`, height: `${size}px` }}>
        <div className="cube-face cube-face-front"></div>
        <div className="cube-face cube-face-back"></div>
        <div className="cube-face cube-face-right"></div>
        <div className="cube-face cube-face-left"></div>
        <div className="cube-face cube-face-top"></div>
        <div className="cube-face cube-face-bottom"></div>
      </div>
    </div>
  );
};

export default CubeAnimation; 