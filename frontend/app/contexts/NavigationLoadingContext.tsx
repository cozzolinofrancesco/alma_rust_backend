'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const NAVIGATION_LOADING_TIMEOUT_MS = 20000;

interface NavigationLoadingContextType {
  isNavigating: boolean;
  message: string;
  startNavigation: (message?: string) => void;
  endNavigation: () => void;
}

const defaultState: NavigationLoadingContextType = {
  isNavigating: false,
  message: 'Loading...',
  startNavigation: () => {},
  endNavigation: () => {},
};

const NavigationLoadingContext = createContext<NavigationLoadingContextType>(defaultState);

export function useNavigationLoading(): NavigationLoadingContextType {
  const ctx = useContext(NavigationLoadingContext);
  return ctx ?? defaultState;
}

interface NavigationLoadingProviderProps {
  children: React.ReactNode;
}

export function NavigationLoadingProvider({ children }: NavigationLoadingProviderProps) {
  const [isNavigating, setIsNavigating] = useState(false);
  const [message, setMessage] = useState('Loading...');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startNavigation = useCallback((customMessage?: string) => {
    clearTimeoutRef();
    setMessage(customMessage ?? 'Loading...');
    setIsNavigating(true);
    timeoutRef.current = setTimeout(() => {
      setIsNavigating(false);
      timeoutRef.current = null;
    }, NAVIGATION_LOADING_TIMEOUT_MS);
  }, [clearTimeoutRef]);

  const endNavigation = useCallback(() => {
    clearTimeoutRef();
    setIsNavigating(false);
  }, [clearTimeoutRef]);

  useEffect(() => {
    return () => clearTimeoutRef();
  }, [clearTimeoutRef]);

  const value: NavigationLoadingContextType = {
    isNavigating,
    message,
    startNavigation,
    endNavigation,
  };

  return (
    <NavigationLoadingContext.Provider value={value}>
      {children}
    </NavigationLoadingContext.Provider>
  );
}
