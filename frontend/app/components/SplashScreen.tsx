import { useState, useEffect } from "react";

interface SplashScreenProps {
  onAnimationEnd?: () => void;
}

const SplashScreen = ({ onAnimationEnd }: SplashScreenProps) => {
  const [gifLoaded, setGifLoaded] = useState(false);

  useEffect(() => {
    const whiteTransitionTimer = setTimeout(() => {
      if (onAnimationEnd) {
        onAnimationEnd();
      }
    }, 4580);

    return () => clearTimeout(whiteTransitionTimer);
  }, [onAnimationEnd]);

  useEffect(() => {
    const loadTimer = setTimeout(() => {
      setGifLoaded(true);
    }, 100);

    return () => clearTimeout(loadTimer);
  }, []);

  return (
    <>
      <div
        className={`splash-screen ${gifLoaded ? 'bg-active' : ''}`}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "var(--app-height)",
          background: "#000",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          zIndex: 10000,
          overflow: "hidden",
        }}
      >
        {}
        <div 
          className="gif-background"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundImage: "url('/images/splash_screen.gif')",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            zIndex: 1,
          }}
        />
      </div>
      <style jsx>{`
        /* Background GIF Animation */
        .splash-screen.bg-active .gif-background {
          animation: gifZoom 5s ease-out forwards;
        }

        @keyframes gifZoom {
          0% {
            transform: scale(1.1);
            filter: blur(0px);
          }
          20% {
            transform: scale(1);
            filter: blur(0px);
          }
          80% {
            transform: scale(1);
            filter: blur(0px);
          }
          100% {
            transform: scale(1.05);
            filter: blur(1px);
          }
        }

        /* White Fog Overlay - Final Fade to White */
        .white-fog {
          position: absolute;
          top: 0;
          left: 0;
          width: 100vw;
          height: var(--app-height);
          background: rgba(255, 255, 255, 0);
          opacity: 0;
          z-index: 8;
          pointer-events: none;
        }

        .white-fog.fog-active {
          animation: whiteFogSpread 1.5s ease-in-out forwards;
          animation-delay: 2.5s;
        }

        @keyframes whiteFogSpread {
          0% {
            opacity: 0;
            background: rgba(255, 255, 255, 0);
          }
          30% {
            opacity: 0.4;
            background: radial-gradient(circle at center, rgba(255, 255, 255, 0.3) 30%, rgba(255, 255, 255, 0.7) 70%);
          }
          60% {
            opacity: 0.8;
            background: radial-gradient(circle at center, rgba(255, 255, 255, 0.6) 20%, rgba(255, 255, 255, 0.9) 60%);
          }
          100% {
            opacity: 1;
            background: rgba(255, 255, 255, 1);
          }
        }
      `}</style>
    </>
  );
};

export default SplashScreen;

