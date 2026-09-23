'use client';
import { useEffect } from 'react';
import { usePageReady } from './SplashScreenWrapper';

interface PageReadyProviderProps {
  children: React.ReactNode;
  delay?: number;
}

export default function PageReadyProvider({ children, delay = 0 }: PageReadyProviderProps) {
  const { signalPageReady } = usePageReady();

  useEffect(() => {
    if (delay === 0) {
      console.log('📄 Simple page ready - signaling aurora to end immediately');
      signalPageReady();
    } else {
      const timer = setTimeout(() => {
        console.log('📄 Simple page ready - signaling aurora to end');
        signalPageReady();
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [signalPageReady, delay]);

  return <>{children}</>;
} 