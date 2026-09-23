'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';

export type LensSize = 'small' | 'medium' | 'large';

export interface LensDimension {
  width: number;
  height: number;
}

export const LENS_SIZES: Record<LensSize, LensDimension> = {
  small: { width: 220, height: 140 },
  medium: { width: 340, height: 210 },
  large: { width: 480, height: 300 }
};

interface MagnifierContextType {
  isMagnifierEnabled: boolean;
  setIsMagnifierEnabled: (enabled: boolean) => void;
  zoomLevel: number;
  setZoomLevel: (zoom: number) => void;
  lensSize: LensSize;
  setLensSize: (size: LensSize) => void;
}

const MagnifierContext = createContext<MagnifierContextType | undefined>(undefined);

export function useMagnifier() {
  const context = useContext(MagnifierContext);
  if (!context) {
    throw new Error('useMagnifier must be used within a MagnifierProvider');
  }
  return context;
}

export function MagnifierProvider({ children }: { children: React.ReactNode }) {
  const [isMagnifierEnabled, setIsMagnifierEnabled] = useState<boolean>(false);
  const [zoomLevel, setZoomLevel] = useState<number>(2.0);
  const [lensSize, setLensSize] = useState<LensSize>('medium');

  const pathname = usePathname();

  const lastClientX = useRef<number>(0);
  const lastClientY = useRef<number>(0);
  const lastPageX = useRef<number>(0);
  const lastPageY = useRef<number>(0);

  const updateClone = useCallback(() => {
    if (typeof window === 'undefined') return;
    const lensEl = document.getElementById('magnifier-lens-el');
    const mainApp = document.querySelector('.app-shell');
    if (!lensEl || !mainApp) return;

    const oldWrapper = document.getElementById('magnifier-clone-wrapper');
    if (oldWrapper) {
      oldWrapper.remove();
    }

    const wrapper = document.createElement('div');
    wrapper.id = 'magnifier-clone-wrapper';
    wrapper.style.position = 'absolute';
    wrapper.style.left = '0';
    wrapper.style.top = '0';
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.overflow = 'hidden';

    const clone = mainApp.cloneNode(true) as HTMLElement;

    const rect = mainApp.getBoundingClientRect();
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.pointerEvents = 'none';
    clone.style.userSelect = 'none';

    clone.querySelectorAll('[id]').forEach((el) => {
      if (el.id !== 'magnifier-lens-el') {
        el.removeAttribute('id');
      }
    });

    const originalInputs = mainApp.querySelectorAll('input, textarea, select');
    const clonedInputs = clone.querySelectorAll('input, textarea, select');
    originalInputs.forEach((original, idx) => {
      const cloned = clonedInputs[idx] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (cloned) {
        cloned.value = (original as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
        if ((original as HTMLInputElement).checked !== undefined) {
          (cloned as HTMLInputElement).checked = (original as HTMLInputElement).checked;
        }
      }
    });

    wrapper.appendChild(clone);
    lensEl.appendChild(wrapper);

    const currentLens = LENS_SIZES[lensSize];
    const tx = (currentLens.width / (2 * zoomLevel)) - lastPageX.current;
    const ty = (currentLens.height / (2 * zoomLevel)) - lastPageY.current;
    clone.style.transform = `scale(${zoomLevel}) translate(${tx}px, ${ty}px)`;
    clone.style.transformOrigin = '0 0';
  }, [lensSize, zoomLevel]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    lastClientX.current = e.clientX;
    lastClientY.current = e.clientY;
    lastPageX.current = e.pageX;
    lastPageY.current = e.pageY;

    const lensEl = document.getElementById('magnifier-lens-el');
    if (!lensEl) return;

    const currentLens = LENS_SIZES[lensSize];

    lensEl.style.left = `${e.clientX - currentLens.width / 2}px`;
    lensEl.style.top = `${e.clientY - currentLens.height / 2}px`;
    lensEl.style.display = 'block';

    const wrapper = document.getElementById('magnifier-clone-wrapper');
    if (wrapper && wrapper.firstChild) {
      const clone = wrapper.firstChild as HTMLElement;
      const tx = (currentLens.width / (2 * zoomLevel)) - e.pageX;
      const ty = (currentLens.height / (2 * zoomLevel)) - e.pageY;
      clone.style.transform = `scale(${zoomLevel}) translate(${tx}px, ${ty}px)`;
      clone.style.transformOrigin = '0 0';
    }
  }, [lensSize, zoomLevel]);

  useEffect(() => {
    if (!isMagnifierEnabled) return;
    const id = setTimeout(updateClone, 50);
    return () => clearTimeout(id);
  }, [isMagnifierEnabled, pathname, updateClone]);

  useEffect(() => {
    if (!isMagnifierEnabled) return;

    const handleInput = () => {
      updateClone();
    };

    window.addEventListener('input', handleInput, { passive: true });
    window.addEventListener('change', handleInput, { passive: true });

    const targetNode = document.querySelector('.app-shell');
    if (!targetNode) return;

    let debounceTimeout: NodeJS.Timeout;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        updateClone();
      }, 100);
    });

    observer.observe(targetNode, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });

    return () => {
      window.removeEventListener('input', handleInput);
      window.removeEventListener('change', handleInput);
      observer.disconnect();
      clearTimeout(debounceTimeout);
    };
  }, [isMagnifierEnabled, updateClone]);

  useEffect(() => {
    if (!isMagnifierEnabled) {
      document.documentElement.style.removeProperty('--magnifier-visible');
      return;
    }

    const handleMouseLeave = () => {
      const lensEl = document.getElementById('magnifier-lens-el');
      if (lensEl) lensEl.style.display = 'none';
    };

    const handleMouseEnter = () => {
      const lensEl = document.getElementById('magnifier-lens-el');
      if (lensEl) lensEl.style.display = 'block';
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    document.addEventListener('mouseleave', handleMouseLeave, { passive: true });
    document.addEventListener('mouseenter', handleMouseEnter, { passive: true });

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
    };
  }, [isMagnifierEnabled, handleMouseMove]);

  return (
    <MagnifierContext.Provider
      value={{
        isMagnifierEnabled,
        setIsMagnifierEnabled,
        zoomLevel,
        setZoomLevel,
        lensSize,
        setLensSize
      }}
    >
      {children}

      {}
      {isMagnifierEnabled && (
        <div
          id="magnifier-lens-el"
          style={{
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: 2147483647,
            border: '3px solid #1A2B5B',
            borderRadius: '12px',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.4)',
            width: `${LENS_SIZES[lensSize].width}px`,
            height: `${LENS_SIZES[lensSize].height}px`,
            display: 'none',
            overflow: 'hidden',
            backgroundColor: '#ffffff'
          }}
        />
      )}
    </MagnifierContext.Provider>
  );
}
