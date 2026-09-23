'use client';
import { usePathname } from 'next/navigation';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import PageTransition from "./PageTransition";
import SplashScreen from "./SplashScreen";
import { NavigationLoadingProvider, useNavigationLoading } from '../contexts/NavigationLoadingContext';
import NavigationLoadingOverlay from './NavigationLoadingOverlay';

function DismissNavigationLoadingWhenAuroraStarts({ isTransitioning }: { isTransitioning: boolean }) {
  const { endNavigation } = useNavigationLoading();
  useEffect(() => {
    if (isTransitioning) endNavigation();
  }, [isTransitioning, endNavigation]);
  return null;
}

interface SplashContextType {
  isInitialLoad: boolean;
  setPageReady: (ready: boolean) => void;
  isPageReady: boolean;
  isAuroraComplete: boolean;
}

const SplashContext = createContext<SplashContextType>({
  isInitialLoad: false,
  setPageReady: () => { },
  isPageReady: false,
  isAuroraComplete: false
});

export const useSplashState = () => useContext(SplashContext);

export const usePageReady = () => {
  const { setPageReady } = useSplashState();

  const signalPageReady = useCallback(() => {
    console.log('📢 Page signaling ready to end aurora');
    setPageReady(true);
  }, [setPageReady]);

  const signalPageNotReady = useCallback(() => {
    console.log('📢 Page signaling not ready, continue aurora');
    setPageReady(false);
  }, [setPageReady]);

  return { signalPageReady, signalPageNotReady };
};

export default function ClientWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const [shouldShowVideoSplash, setShouldShowVideoSplash] = useState(false);
  const [cookieChecked, setCookieChecked] = useState(false);

  const [showSplash, setShowSplash] = useState(false);
  const [showWhiteTransition, setShowWhiteTransition] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(pathname === '/');
  const [isTransitioning, setIsTransitioning] = useState(pathname !== '/');

  const [isPageReady, setIsPageReady] = useState(false);
  const [isAuroraComplete, setIsAuroraComplete] = useState(false);
  const [auroraStartTime, setAuroraStartTime] = useState<number | null>(null);
  const [minimumAuroraDuration] = useState(2000);
  const [maximumAuroraDuration] = useState(3000);

  useEffect(() => {
    if (pathname === '/') {
      setShouldShowVideoSplash(false);
      setShowSplash(false);
      setIsTransitioning(true);
      setIsAuroraComplete(false);
      setAuroraStartTime(Date.now());
      console.log('🚀 Skipping video splash, showing aurora');

      setCookieChecked(true);
    } else {
      setCookieChecked(true);
    }
  }, [pathname]);

  const handleSplashAnimationEnd = () => {
    setShowSplash(false);
    setShowWhiteTransition(true);

    setTimeout(() => {
      setShowWhiteTransition(false);
      setIsInitialLoad(false);
    }, 200);
  };

  const endAuroraWhenReady = () => {
    if (!auroraStartTime) return;

    const currentTime = Date.now();
    const elapsedTime = currentTime - auroraStartTime;

    const remainingMinimumTime = Math.max(0, minimumAuroraDuration - elapsedTime);

    setTimeout(() => {
      setIsTransitioning(false);
      setIsInitialLoad(false);
      setIsPageReady(false);
      setIsAuroraComplete(true);
      console.log('🌅 Aurora animation completed');
    }, remainingMinimumTime);
  };

  useEffect(() => {
    if (pathname !== '/' && cookieChecked) {
      setIsTransitioning(true);
      setIsPageReady(false);
      setIsAuroraComplete(false);
      setAuroraStartTime(Date.now());

      const timeoutTimer = setTimeout(() => {
        console.log('⏰ Aurora safety timeout triggered');
        setIsTransitioning(false);
        setIsInitialLoad(false);
        setIsPageReady(false);
        setIsAuroraComplete(true);
      }, maximumAuroraDuration);

      return () => clearTimeout(timeoutTimer);
    }
  }, [pathname, cookieChecked]);

  useEffect(() => {
    if (pathname === '/' && cookieChecked && !shouldShowVideoSplash && isTransitioning) {
      const timeoutTimer = setTimeout(() => {
        console.log('⏰ Homepage aurora safety timeout triggered');
        setIsTransitioning(false);
        setIsInitialLoad(false);
        setIsPageReady(false);
        setIsAuroraComplete(true);
      }, maximumAuroraDuration);

      return () => clearTimeout(timeoutTimer);
    }
  }, [pathname, cookieChecked, shouldShowVideoSplash, isTransitioning]);

  useEffect(() => {
    if (!isInitialLoad && cookieChecked) {
      setIsTransitioning(true);
      setIsPageReady(false);
      setIsAuroraComplete(false);
      setAuroraStartTime(Date.now());

      const timeoutTimer = setTimeout(() => {
        console.log('⏰ Aurora navigation safety timeout triggered');
        setIsTransitioning(false);
        setIsInitialLoad(false);
        setIsPageReady(false);
        setIsAuroraComplete(true);
      }, maximumAuroraDuration);

      return () => clearTimeout(timeoutTimer);
    }
  }, [pathname, cookieChecked]);

  useEffect(() => {
    if (isPageReady && isTransitioning && auroraStartTime) {
      console.log('✅ Page signaled ready, ending aurora gracefully');
      endAuroraWhenReady();
    }
  }, [isPageReady, isTransitioning, auroraStartTime]);

  const memoizedSetPageReady = useCallback((ready: boolean) => {
    console.log(`📍 Page ready state changed: ${ready}`);
    setIsPageReady(ready);
  }, []);

  if (!cookieChecked) {
    return null;
  }

  return (
    <NavigationLoadingProvider>
      <DismissNavigationLoadingWhenAuroraStarts isTransitioning={isTransitioning} />
      <SplashContext.Provider value={{
        isInitialLoad,
        setPageReady: memoizedSetPageReady,
        isPageReady,
        isAuroraComplete
      }}>
        {}
        <PageTransition isTransitioning={isTransitioning}>
          {children}
        </PageTransition>

        {}
        {showSplash && shouldShowVideoSplash && <SplashScreen onAnimationEnd={handleSplashAnimationEnd} />}
        {showWhiteTransition && <WhiteTransition />}
      </SplashContext.Provider>
      <NavigationLoadingOverlay />
    </NavigationLoadingProvider>
  );
}

const WhiteTransition = () => (
  <div style={{
    position: "fixed",
    top: 0,
    left: 0,
    width: "100vw",
    height: "var(--app-height)",
    backgroundColor: "#ffffff",
    zIndex: 10000,
    animation: "quickWhiteFade 0.2s ease-in-out forwards"
  }}>
    <style jsx>{`
      @keyframes quickWhiteFade {
        0% {
          opacity: 0;
        }
        30% {
          opacity: 0.7;
        }
        70% {
          opacity: 1;
        }
        100% {
          opacity: 0;
        }
      }
    `}</style>
  </div>
);
