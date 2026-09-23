'use client';
import React from 'react';
import { usePathname } from 'next/navigation';
import { useSplashState } from './SplashScreenWrapper';
import Navbar from './Navbar';

// Immersive, full-bleed surfaces that render their own chrome and hide the global nav.
const NAVLESS_PREFIXES = ['/agent-workspace'];

const ConditionalNavbar: React.FC = () => {
  const { isInitialLoad } = useSplashState();
  const pathname = usePathname() ?? '';

  if (isInitialLoad) {
    return null;
  }

  if (NAVLESS_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  return <Navbar />;
};

export default ConditionalNavbar;
