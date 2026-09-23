'use client';
import React from 'react';
import Image from 'next/image';
import almaLogo from '../../public/images/alma_logo_dark.png';

interface PageTransitionProps {
  children: React.ReactNode;
  isTransitioning: boolean;
}

const PageTransition: React.FC<PageTransitionProps> = ({ children, isTransitioning }) => {
  return (
    <>
      <div 
        className={`page-content ${isTransitioning ? 'transitioning' : 'visible'}`}
        style={{
          transition: 'opacity 0.3s ease-in-out, transform 0.3s ease-in-out',
          opacity: isTransitioning ? 0.7 : 1,
          transform: isTransitioning ? 'translateY(0px)' : 'translateY(0)',
          pointerEvents: isTransitioning ? 'none' : 'auto',
        }}
      >
        {children}
      </div>
      
      {}
      {isTransitioning && (
        <div className="northern-lights-transition">
          <div className="aurora-container">
            <div className="aurora aurora-1"></div>
            <div className="aurora aurora-2"></div>
            <div className="aurora aurora-3"></div>
            <div className="aurora aurora-4"></div>
            <div className="aurora aurora-5"></div>
            <div className="aurora aurora-6"></div>
          </div>
          <div className="stars">
            <div className="star star-1"></div>
            <div className="star star-2"></div>
            <div className="star star-3"></div>
            <div className="star star-4"></div>
            <div className="star star-5"></div>
            <div className="star star-6"></div>
            <div className="star star-7"></div>
            <div className="star star-8"></div>
          </div>
          
          {}
          <div className="logo-center">
            <Image 
              src={almaLogo} 
              alt="ALMA Logo" 
              width={350}
              height={150}
              priority
              className="alma-logo-transition"
              style={{ width: 'auto', height: 'auto', maxWidth: '350px' }}
            />
          </div>
          
          {}
          <div className="blur-overlay"></div>
        </div>
      )}
      
      <style jsx>{`
        .northern-lights-transition {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: linear-gradient(180deg, #ffffff 0%, #f8f9ff 50%, #ffffff 100%);
          z-index: 10000;
          animation: fadeInOut 5s ease-in-out forwards;
          pointer-events: none;
        }

        .aurora-container {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          z-index: 10001;
        }

        .aurora {
          position: absolute;
          width: 150%;
          height: 150%;
          top: -25%;
          left: -25%;
          opacity: 0.6;
          mix-blend-mode: multiply;
          z-index: 10001;
        }

        .aurora-1 {
          background: linear-gradient(to right, 
            transparent 0%,
            rgba(255, 20, 147, 0.4) 5%,
            rgba(0, 255, 127, 0.6) 15%,
            rgba(255, 69, 0, 0.3) 25%,
            transparent 35%,
            rgba(138, 43, 226, 0.5) 45%,
            transparent 55%,
            rgba(0, 255, 127, 0.4) 65%,
            rgba(255, 20, 147, 0.3) 75%,
            transparent 85%,
            rgba(255, 215, 0, 0.4) 95%,
            transparent 100%);
          animation: aurora1 5s linear infinite;
          transform: skewY(-5deg);
        }

        .aurora-2 {
          background: linear-gradient(to left,
            transparent 0%,
            rgba(138, 43, 226, 0.5) 10%,
            transparent 20%,
            rgba(255, 215, 0, 0.6) 30%,
            rgba(0, 191, 255, 0.4) 40%,
            transparent 50%,
            rgba(255, 105, 180, 0.5) 60%,
            rgba(124, 252, 0, 0.3) 70%,
            transparent 80%,
            rgba(30, 144, 255, 0.4) 90%,
            transparent 100%);
          animation: aurora2 6s linear infinite reverse;
          transform: skewY(3deg);
        }

        .aurora-3 {
          background: linear-gradient(45deg,
            transparent 0%,
            rgba(255, 105, 180, 0.3) 8%,
            transparent 16%,
            rgba(50, 205, 50, 0.5) 24%,
            rgba(255, 165, 0, 0.4) 32%,
            transparent 40%,
            rgba(30, 144, 255, 0.6) 48%,
            transparent 56%,
            rgba(255, 20, 147, 0.4) 64%,
            rgba(124, 252, 0, 0.3) 72%,
            transparent 80%,
            rgba(138, 43, 226, 0.5) 88%,
            transparent 100%);
          animation: aurora3 5.5s linear infinite;
          transform: skewX(-3deg);
        }

        .aurora-4 {
          background: linear-gradient(-45deg,
            transparent 0%,
            rgba(30, 144, 255, 0.4) 12%,
            rgba(255, 20, 147, 0.5) 24%,
            transparent 36%,
            rgba(124, 252, 0, 0.3) 48%,
            rgba(255, 165, 0, 0.6) 60%,
            transparent 72%,
            rgba(138, 43, 226, 0.4) 84%,
            rgba(0, 255, 127, 0.3) 96%,
            transparent 100%);
          animation: aurora4 6.5s linear infinite reverse;
          transform: skewX(2deg);
        }

        .aurora-5 {
          background: linear-gradient(to bottom,
            transparent 0%,
            rgba(255, 215, 0, 0.3) 15%,
            transparent 30%,
            rgba(255, 105, 180, 0.5) 45%,
            rgba(0, 191, 255, 0.4) 60%,
            transparent 75%,
            rgba(124, 252, 0, 0.6) 90%,
            transparent 100%);
          animation: aurora5 4.5s linear infinite;
          transform: skewX(-1deg);
        }

        .aurora-6 {
          background: linear-gradient(to top,
            transparent 0%,
            rgba(138, 43, 226, 0.4) 20%,
            rgba(0, 255, 127, 0.5) 40%,
            transparent 60%,
            rgba(255, 20, 147, 0.4) 80%,
            rgba(30, 144, 255, 0.3) 100%);
          animation: aurora6 7s linear infinite reverse;
          transform: skewY(-2deg);
        }

        .stars {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 10002;
        }

        .star {
          position: absolute;
          background: linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #feca57);
          border-radius: 50%;
          animation: twinkle 3s ease-in-out infinite alternate;
          box-shadow: 0 0 10px rgba(255, 107, 107, 0.8);
          z-index: 10002;
        }

        .star-1 {
          top: 20%;
          left: 10%;
          width: 3px;
          height: 3px;
          animation-delay: 0s;
          background: #ff6b6b;
          box-shadow: 0 0 12px rgba(255, 107, 107, 0.9);
        }

        .star-2 {
          top: 15%;
          left: 80%;
          width: 2px;
          height: 2px;
          animation-delay: 0.3s;
          background: #4ecdc4;
          box-shadow: 0 0 10px rgba(78, 205, 196, 0.8);
        }

        .star-3 {
          top: 30%;
          left: 60%;
          width: 4px;
          height: 4px;
          animation-delay: 0.6s;
          background: #45b7d1;
          box-shadow: 0 0 15px rgba(69, 183, 209, 0.9);
        }

        .star-4 {
          top: 10%;
          left: 40%;
          width: 2px;
          height: 2px;
          animation-delay: 0.2s;
          background: #96ceb4;
          box-shadow: 0 0 8px rgba(150, 206, 180, 0.7);
        }

        .star-5 {
          top: 25%;
          left: 25%;
          width: 3px;
          height: 3px;
          animation-delay: 0.5s;
          background: #feca57;
          box-shadow: 0 0 12px rgba(254, 202, 87, 0.8);
        }

        .star-6 {
          top: 35%;
          left: 90%;
          width: 2px;
          height: 2px;
          animation-delay: 0.8s;
          background: #ff9ff3;
          box-shadow: 0 0 10px rgba(255, 159, 243, 0.8);
        }

        .star-7 {
          top: 5%;
          left: 20%;
          width: 2px;
          height: 2px;
          animation-delay: 1s;
          background: #54a0ff;
          box-shadow: 0 0 10px rgba(84, 160, 255, 0.8);
        }

        .star-8 {
          top: 40%;
          left: 15%;
          width: 3px;
          height: 3px;
          animation-delay: 0.7s;
          background: #ff6348;
          box-shadow: 0 0 12px rgba(255, 99, 72, 0.8);
        }

        .logo-center {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 10005;
        }

        .blur-overlay {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: radial-gradient(
            ellipse at center,
            transparent 15%,
            rgba(255, 255, 255, 0.1) 25%,
            rgba(255, 255, 255, 0.3) 35%,
            rgba(255, 255, 255, 0.5) 45%,
            rgba(255, 255, 255, 0.7) 55%,
            rgba(255, 255, 255, 0.85) 65%,
            rgba(255, 255, 255, 0.95) 75%,
            rgba(255, 255, 255, 1) 85%,
            rgba(255, 255, 255, 1) 100%
          );
          backdrop-filter: blur(15px);
          z-index: 10003;
          animation: blurPulse 5s ease-in-out forwards;
        }

        /* Additional blur layer for extra softness */
        .blur-overlay::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: radial-gradient(
            ellipse at center,
            transparent 20%,
            rgba(255, 255, 255, 0.2) 40%,
            rgba(255, 255, 255, 0.6) 60%,
            rgba(255, 255, 255, 0.9) 80%,
            rgba(255, 255, 255, 1) 100%
          );
          backdrop-filter: blur(25px);
          z-index: 10003;
        }

        :global(.alma-logo-transition) {
          filter: drop-shadow(0 0 20px rgba(0, 0, 0, 0.3)) 
                  drop-shadow(0 0 40px rgba(100, 50, 200, 0.4));
          animation: logoGlow 5s ease-in-out forwards;
          opacity: 0;
          transform: scale(0.8);
          position: relative;
          z-index: 10010;
        }

        @keyframes fadeInOut {
          0% {
            opacity: 0;
          }
          15% {
            opacity: 1;
          }
          85% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }

        @keyframes logoGlow {
          0% {
            opacity: 0;
            transform: scale(0.8);
            filter: drop-shadow(0 0 20px rgba(0, 0, 0, 0.3)) 
                    drop-shadow(0 0 40px rgba(100, 50, 200, 0.4)) blur(10px);
          }
          15% {
            opacity: 0.6;
            transform: scale(0.9);
            filter: drop-shadow(0 0 25px rgba(0, 0, 0, 0.4)) 
                    drop-shadow(0 0 50px rgba(100, 50, 200, 0.5)) blur(5px);
          }
          30% {
            opacity: 1;
            transform: scale(1);
            filter: drop-shadow(0 0 30px rgba(0, 0, 0, 0.5)) 
                    drop-shadow(0 0 60px rgba(100, 50, 200, 0.6)) blur(0px);
          }
          70% {
            opacity: 1;
            transform: scale(1);
            filter: drop-shadow(0 0 25px rgba(0, 0, 0, 0.5)) 
                    drop-shadow(0 0 50px rgba(100, 50, 200, 0.6)) blur(0px);
          }
          85% {
            opacity: 0.8;
            transform: scale(0.95);
            filter: drop-shadow(0 0 20px rgba(0, 0, 0, 0.3)) 
                    drop-shadow(0 0 40px rgba(100, 50, 200, 0.4)) blur(3px);
          }
          100% {
            opacity: 0;
            transform: scale(0.9);
            filter: drop-shadow(0 0 15px rgba(0, 0, 0, 0.2)) 
                    drop-shadow(0 0 30px rgba(100, 50, 200, 0.3)) blur(8px);
          }
        }

        @keyframes blurPulse {
          0% {
            background: radial-gradient(
              ellipse at center,
              transparent 15%,
              rgba(255, 255, 255, 0.1) 25%,
              rgba(255, 255, 255, 0.3) 35%,
              rgba(255, 255, 255, 0.5) 45%,
              rgba(255, 255, 255, 0.7) 55%,
              rgba(255, 255, 255, 0.85) 65%,
              rgba(255, 255, 255, 0.95) 75%,
              rgba(255, 255, 255, 1) 85%,
              rgba(255, 255, 255, 1) 100%
            );
            backdrop-filter: blur(15px);
          }
          30% {
            background: radial-gradient(
              ellipse at center,
              transparent 12%,
              rgba(255, 255, 255, 0.15) 22%,
              rgba(255, 255, 255, 0.35) 32%,
              rgba(255, 255, 255, 0.55) 42%,
              rgba(255, 255, 255, 0.75) 52%,
              rgba(255, 255, 255, 0.9) 62%,
              rgba(255, 255, 255, 0.98) 72%,
              rgba(255, 255, 255, 1) 82%,
              rgba(255, 255, 255, 1) 100%
            );
            backdrop-filter: blur(20px);
          }
          70% {
            background: radial-gradient(
              ellipse at center,
              transparent 10%,
              rgba(255, 255, 255, 0.2) 20%,
              rgba(255, 255, 255, 0.4) 30%,
              rgba(255, 255, 255, 0.6) 40%,
              rgba(255, 255, 255, 0.8) 50%,
              rgba(255, 255, 255, 0.95) 60%,
              rgba(255, 255, 255, 1) 70%,
              rgba(255, 255, 255, 1) 100%
            );
            backdrop-filter: blur(25px);
          }
          100% {
            background: radial-gradient(
              ellipse at center,
              transparent 15%,
              rgba(255, 255, 255, 0.1) 25%,
              rgba(255, 255, 255, 0.3) 35%,
              rgba(255, 255, 255, 0.5) 45%,
              rgba(255, 255, 255, 0.7) 55%,
              rgba(255, 255, 255, 0.85) 65%,
              rgba(255, 255, 255, 0.95) 75%,
              rgba(255, 255, 255, 1) 85%,
              rgba(255, 255, 255, 1) 100%
            );
            backdrop-filter: blur(15px);
          }
        }

        @keyframes aurora1 {
          0% {
            transform: translateX(-100%) skewY(-5deg);
          }
          100% {
            transform: translateX(100%) skewY(-5deg);
          }
        }

        @keyframes aurora2 {
          0% {
            transform: translateX(100%) skewY(3deg);
          }
          100% {
            transform: translateX(-100%) skewY(3deg);
          }
        }

        @keyframes aurora3 {
          0% {
            transform: translateX(-100%) translateY(-50%) skewX(-3deg);
          }
          100% {
            transform: translateX(100%) translateY(50%) skewX(-3deg);
          }
        }

        @keyframes aurora4 {
          0% {
            transform: translateX(100%) translateY(50%) skewX(2deg);
          }
          100% {
            transform: translateX(-100%) translateY(-50%) skewX(2deg);
          }
        }

        @keyframes aurora5 {
          0% {
            transform: translateY(-100%) skewX(-1deg);
          }
          100% {
            transform: translateY(100%) skewX(-1deg);
          }
        }

        @keyframes aurora6 {
          0% {
            transform: translateY(100%) skewY(-2deg);
          }
          100% {
            transform: translateY(-100%) skewY(-2deg);
          }
        }

        @keyframes twinkle {
          0% {
            opacity: 0.3;
            transform: scale(0.8);
          }
          100% {
            opacity: 1;
            transform: scale(1.2);
          }
        }
        
        .page-content {
          width: 100%;
          height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          overflow: hidden;
        }
        
        .page-content.transitioning {
          pointer-events: none;
        }
        
        .page-content.visible {
          pointer-events: auto;
        }
      `}</style>
    </>
  );
};

export default PageTransition; 