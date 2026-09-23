'use client';

import React, { createContext, ReactNode, useContext, useState, useEffect } from 'react';

export type ColorBlindMode = 'none' | 'deuteranopia' | 'protanopia' | 'tritanopia';

export interface ThemeConfig {
    bg: string;
    cardBg: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    borderColor: string;
    buttonBg: string;
    buttonHover: string;
    accentBg: string;
    accentHover: string;
    accentText: string;
    scrollbar: string;
}

const lightTheme: ThemeConfig = {
    bg: 'bg-[#F8F8F8]',
    cardBg: 'bg-white',
    textPrimary: 'text-[#1A2B5B]',
    textSecondary: 'text-[#555555]',
    textMuted: 'text-[#666666]',
    borderColor: 'border-gray-200',
    buttonBg: 'bg-[#E6E6FA]',
    buttonHover: 'hover:bg-[#C0BBEB]',
    accentBg: 'bg-[#1A2B5B]',
    accentHover: 'hover:bg-[#8A2BE2]',
    accentText: 'text-white',
    scrollbar: 'scrollbar-thin scrollbar-thumb-[#C0BBEB] scrollbar-track-[#F8F8F8]'
};

const darkTheme: ThemeConfig = {
    bg: 'bg-[#0D1A3B]',
    cardBg: 'bg-[#1A2B5B]',
    textPrimary: 'text-[#E6E6FA]',
    textSecondary: 'text-[#C0BBEB]',
    textMuted: 'text-[#9966CC]',
    borderColor: 'border-[#2A3B6B]',
    buttonBg: 'bg-[#1A2B5B]',
    buttonHover: 'hover:bg-[#2A3B6B]',
    accentBg: 'bg-[#8A2BE2]',
    accentHover: 'hover:bg-[#9966CC]',
    accentText: 'text-white',
    scrollbar: 'scrollbar-thin scrollbar-thumb-[#9966CC] scrollbar-track-[#0D1A3B]'
};

interface ThemeContextType {
    isDarkMode: boolean;
    toggleTheme: () => void;
    theme: ThemeConfig;
    colorBlindMode: ColorBlindMode;
    setColorBlindMode: (mode: ColorBlindMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getThemeWithColorBlindOverrides(baseTheme: ThemeConfig, mode: ColorBlindMode, isDark: boolean): ThemeConfig {
    if (mode === 'none') return baseTheme;

    const overrides: Partial<ThemeConfig> = {};

    if (mode === 'deuteranopia') {
        if (isDark) {
            overrides.accentBg = 'bg-[#0072B2]';
            overrides.accentHover = 'hover:bg-[#D55E00]';
            overrides.buttonBg = 'bg-[#1E3A5F]';
            overrides.buttonHover = 'hover:bg-[#2E5B8F]';
            overrides.textSecondary = 'text-[#56B4E9]';
            overrides.textMuted = 'text-[#E69F00]';
        } else {
            overrides.accentBg = 'bg-[#0072B2]';
            overrides.accentHover = 'hover:bg-[#D55E00]';
            overrides.buttonBg = 'bg-[#E5F1FA]';
            overrides.buttonHover = 'hover:bg-[#B3D7F0]';
            overrides.textSecondary = 'text-[#005AB5]';
            overrides.textMuted = 'text-[#D55E00]';
        }
    } else if (mode === 'protanopia') {
        if (isDark) {
            overrides.accentBg = 'bg-[#005AB5]';
            overrides.accentHover = 'hover:bg-[#E69F00]';
            overrides.buttonBg = 'bg-[#1E3A5F]';
            overrides.buttonHover = 'hover:bg-[#2E5B8F]';
            overrides.textSecondary = 'text-[#56B4E9]';
            overrides.textMuted = 'text-[#E69F00]';
        } else {
            overrides.accentBg = 'bg-[#005AB5]';
            overrides.accentHover = 'hover:bg-[#E69F00]';
            overrides.buttonBg = 'bg-[#E5F1FA]';
            overrides.buttonHover = 'hover:bg-[#B3D7F0]';
            overrides.textSecondary = 'text-[#005AB5]';
            overrides.textMuted = 'text-[#E69F00]';
        }
    } else if (mode === 'tritanopia') {
        if (isDark) {
            overrides.accentBg = 'bg-[#D55E00]';
            overrides.accentHover = 'hover:bg-[#009E73]';
            overrides.buttonBg = 'bg-[#4A1E1E]';
            overrides.buttonHover = 'hover:bg-[#6E2C2C]';
            overrides.textSecondary = 'text-[#CC79A7]';
            overrides.textMuted = 'text-[#FFC2C2]';
        } else {
            overrides.accentBg = 'bg-[#D55E00]';
            overrides.accentHover = 'hover:bg-[#009E73]';
            overrides.buttonBg = 'bg-[#FADBD8]';
            overrides.buttonHover = 'hover:bg-[#F5B7B1]';
            overrides.textSecondary = 'text-[#009E73]';
            overrides.textMuted = 'text-[#CC79A7]';
        }
    }

    return {
        ...baseTheme,
        ...overrides
    };
}

export const ThemeProvider: React.FC<{ children: ReactNode; initialDark?: boolean }> = ({ children, initialDark = false }) => {
    const parentContext = useContext(ThemeContext);

    const [isDarkMode, setIsDarkMode] = useState(initialDark);
    const [colorBlindMode, setColorBlindModeState] = useState<ColorBlindMode>('none');

    useEffect(() => {
        try {
            const savedTheme = localStorage.getItem('theme-dark-mode');
            if (savedTheme !== null) {
                setIsDarkMode(savedTheme === 'true');
            } else if (typeof window !== 'undefined' && window.matchMedia) {
                setIsDarkMode(window.matchMedia('(prefers-color-scheme: dark)').matches);
            }
        } catch (e) {
            console.error('Failed to load theme preference', e);
        }

        try {
            const savedColorBlind = localStorage.getItem('theme-color-blind-mode') as ColorBlindMode | null;
            if (savedColorBlind === 'none' || savedColorBlind === 'deuteranopia' || savedColorBlind === 'protanopia' || savedColorBlind === 'tritanopia') {
                setColorBlindModeState(savedColorBlind);
            }
        } catch (e) {
            console.error('Failed to load color blind preference', e);
        }
    }, []);

    // Reflect the active theme on <html data-theme> so the token overrides
    // ([data-theme="dark"] in globals.css) take effect across reskinned surfaces.
    useEffect(() => {
        if (typeof document === 'undefined') return;
        document.documentElement.dataset.theme = isDarkMode ? 'dark' : 'light';
    }, [isDarkMode]);

    const toggleTheme = () => {
        setIsDarkMode(prev => {
            const next = !prev;
            try {
                localStorage.setItem('theme-dark-mode', String(next));
            } catch (e) {
                console.error(e);
            }
            return next;
        });
    };

    const setColorBlindMode = (mode: ColorBlindMode) => {
        setColorBlindModeState(mode);
        try {
            localStorage.setItem('theme-color-blind-mode', mode);
        } catch (e) {
            console.error(e);
        }
    };

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const existingStyle = document.getElementById('colorblind-overrides-style');
        if (existingStyle) {
            existingStyle.remove();
        }

        if (colorBlindMode === 'none') {
            document.documentElement.style.removeProperty('--color-brand-primary');
            document.documentElement.style.removeProperty('--color-brand-secondary');
            document.documentElement.style.removeProperty('--color-brand-accent');
            document.documentElement.style.removeProperty('--color-brand-accent-secondary');
            document.documentElement.style.removeProperty('--color-brand-accent-soft');
            return;
        }

        let brandPrimary = '#11074A';
        let brandSecondary = '#1A2B5B';
        let brandAccent = '#8A2BE2';
        let brandAccentSecondary = '#9966CC';
        let brandAccentSoft = '#C0BBEB';

        if (colorBlindMode === 'deuteranopia') {
            brandPrimary = '#002B49';
            brandSecondary = '#004D80';
            brandAccent = '#0072B2';
            brandAccentSecondary = '#56B4E9';
            brandAccentSoft = '#E69F00';
        } else if (colorBlindMode === 'protanopia') {
            brandPrimary = '#001F3F';
            brandSecondary = '#005AB5';
            brandAccent = '#0072B2';
            brandAccentSecondary = '#56B4E9';
            brandAccentSoft = '#E69F00';
        } else if (colorBlindMode === 'tritanopia') {
            brandPrimary = '#2B1A1A';
            brandSecondary = '#802000';
            brandAccent = '#D55E00';
            brandAccentSecondary = '#009E73';
            brandAccentSoft = '#CC79A7';
        }

        document.documentElement.style.setProperty('--color-brand-primary', brandPrimary);
        document.documentElement.style.setProperty('--color-brand-secondary', brandSecondary);
        document.documentElement.style.setProperty('--color-brand-accent', brandAccent);
        document.documentElement.style.setProperty('--color-brand-accent-secondary', brandAccentSecondary);
        document.documentElement.style.setProperty('--color-brand-accent-soft', brandAccentSoft);

        const style = document.createElement('style');
        style.id = 'colorblind-overrides-style';
        style.innerHTML = `
            /* Custom variables mappings */
            :root {
                --color-brand-primary: ${brandPrimary};
                --color-brand-secondary: ${brandSecondary};
                --color-brand-accent: ${brandAccent};
                --color-brand-accent-secondary: ${brandAccentSecondary};
                --color-brand-accent-soft: ${brandAccentSoft};
            }

            /* 1. Dynamic Inline Style Attributes Overrides using case-insensitive partial matching */
            
            /* Primary Navy (#11074A) inline style overrides */
            [style*="color: #11074a" i], [style*="color:#11074a" i] { color: var(--color-brand-primary) !important; }
            [style*="background: #11074a" i], [style*="background:#11074a" i],
            [style*="background-color: #11074a" i], [style*="background-color:#11074a" i] { background: var(--color-brand-primary) !important; background-color: var(--color-brand-primary) !important; }
            [style*="border-color: #11074a" i], [style*="border-color:#11074a" i],
            [style*="border: 1px solid #11074a" i], [style*="border: 2px solid #11074a" i] { border-color: var(--color-brand-primary) !important; }

            /* Secondary Navy (#1A2B5B) inline style overrides */
            [style*="color: #1a2b5b" i], [style*="color:#1a2b5b" i] { color: var(--color-brand-secondary) !important; }
            [style*="background: #1a2b5b" i], [style*="background:#1a2b5b" i],
            [style*="background-color: #1a2b5b" i], [style*="background-color:#1a2b5b" i] { background: var(--color-brand-secondary) !important; background-color: var(--color-brand-secondary) !important; }
            [style*="border-color: #1a2b5b" i], [style*="border-color:#1a2b5b" i],
            [style*="border: 1px solid #1a2b5b" i], [style*="border: 2px solid #1a2b5b" i] { border-color: var(--color-brand-secondary) !important; }

            /* Accent Purple (#8A2BE2) inline style overrides */
            [style*="color: #8a2be2" i], [style*="color:#8a2be2" i] { color: var(--color-brand-accent) !important; }
            [style*="background: #8a2be2" i], [style*="background:#8a2be2" i],
            [style*="background-color: #8a2be2" i], [style*="background-color:#8a2be2" i] { background: var(--color-brand-accent) !important; background-color: var(--color-brand-accent) !important; }
            [style*="border-color: #8a2be2" i], [style*="border-color:#8a2be2" i],
            [style*="border: 1px solid #8a2be2" i], [style*="border: 2px solid #8a2be2" i] { border-color: var(--color-brand-accent) !important; }

            /* Accent Lavender-Purple (#9966CC) inline style overrides */
            [style*="color: #9966cc" i], [style*="color:#9966cc" i] { color: var(--color-brand-accent-secondary) !important; }
            [style*="background: #9966cc" i], [style*="background:#9966cc" i],
            [style*="background-color: #9966cc" i], [style*="background-color:#9966cc" i] { background: var(--color-brand-accent-secondary) !important; background-color: var(--color-brand-accent-secondary) !important; }
            [style*="border-color: #9966cc" i], [style*="border-color:#9966cc" i] { border-color: var(--color-brand-accent-secondary) !important; }

            /* Soft Lavender (#C0BBEB) inline style overrides */
            [style*="color: #c0bbeb" i], [style*="color:#c0bbeb" i] { color: var(--color-brand-accent-soft) !important; }
            [style*="background: #c0bbeb" i], [style*="background:#c0bbeb" i],
            [style*="background-color: #c0bbeb" i], [style*="background-color:#c0bbeb" i] { background: var(--color-brand-accent-soft) !important; background-color: var(--color-brand-accent-soft) !important; }
            [style*="border-color: #c0bbeb" i], [style*="border-color:#c0bbeb" i] { border-color: var(--color-brand-accent-soft) !important; }

            /* 2. Tailwind Class Overrides (escaped brackets for hex values) */

            /* Primary Navy (#11074A) */
            .text-\\[\\#11074A\\], .text-\\[\\#11074a\\], [class*="text-[#11074a]"], [class*="text-[#11074A]"] { color: var(--color-brand-primary) !important; }
            .bg-\\[\\#11074A\\], .bg-\\[\\#11074a\\], [class*="bg-[#11074a]"], [class*="bg-[#11074A]"] { background-color: var(--color-brand-primary) !important; }
            .border-\\[\\#11074A\\], .border-\\[\\#11074a\\], [class*="border-[#11074a]"], [class*="border-[#11074A]"] { border-color: var(--color-brand-primary) !important; }
            .hover\\:bg-\\[\\#11074A\\]:hover, .hover\\:bg-\\[\\#11074a\\]:hover { background-color: var(--color-brand-primary) !important; }
            .hover\\:text-\\[\\#11074A\\]:hover, .hover\\:text-\\[\\#11074a\\]:hover { color: var(--color-brand-primary) !important; }

            /* Secondary Navy (#1A2B5B) */
            .text-\\[\\#1A2B5B\\], .text-\\[\\#1a2b5b\\], [class*="text-[#1a2b5b]"], [class*="text-[#1A2B5B]"] { color: var(--color-brand-secondary) !important; }
            .bg-\\[\\#1A2B5B\\], .bg-\\[\\#1a2b5b\\], [class*="bg-[#1a2b5b]"], [class*="bg-[#1A2B5B]"] { background-color: var(--color-brand-secondary) !important; }
            .border-\\[\\#1A2B5B\\], .border-\\[\\#1a2b5b\\], [class*="border-[#1a2b5b]"], [class*="border-[#1A2B5B]"] { border-color: var(--color-brand-secondary) !important; }
            .hover\\:bg-\\[\\#1A2B5B\\]:hover, .hover\\:bg-\\[\\#1a2b5b\\]:hover { background-color: var(--color-brand-secondary) !important; }
            .hover\\:text-\\[\\#1A2B5B\\]:hover, .hover\\:text-\\[\\#1a2b5b\\]:hover { color: var(--color-brand-secondary) !important; }

            /* Accent Purple (#8A2BE2) */
            .text-\\[\\#8A2BE2\\], .text-\\[\\#8a2be2\\], [class*="text-[#8a2be2]"], [class*="text-[#8A2BE2]"] { color: var(--color-brand-accent) !important; }
            .bg-\\[\\#8A2BE2\\], .bg-\\[\\#8a2be2\\], [class*="bg-[#8a2be2]"], [class*="bg-[#8A2BE2]"] { background-color: var(--color-brand-accent) !important; }
            .border-\\[\\#8A2BE2\\], .border-\\[\\#8a2be2\\], [class*="border-[#8a2be2]"], [class*="border-[#8A2BE2]"] { border-color: var(--color-brand-accent) !important; }
            .hover\\:bg-\\[\\#8A2BE2\\]:hover, .hover\\:bg-\\[\\#8a2be2\\]:hover { background-color: var(--color-brand-accent) !important; }
            .hover\\:text-\\[\\#8A2BE2\\]:hover, .hover\\:text-\\[\\#8a2be2\\]:hover { color: var(--color-brand-accent) !important; }

            /* Accent Lavender-Purple (#9966CC) */
            .text-\\[\\#9966CC\\], .text-\\[\\#9966cc\\], [class*="text-[#9966cc]"], [class*="text-[#9966CC]"] { color: var(--color-brand-accent-secondary) !important; }
            .bg-\\[\\#9966CC\\], .bg-\\[\\#9966cc\\], [class*="bg-[#9966cc]"], [class*="bg-[#9966CC]"] { background-color: var(--color-brand-accent-secondary) !important; }
            .border-\\[\\#9966CC\\], .border-\\[\\#9966cc\\], [class*="border-[#9966cc]"], [class*="border-[#9966CC]"] { border-color: var(--color-brand-accent-secondary) !important; }
            .hover\\:bg-\\[\\#9966CC\\]:hover, .hover\\:bg-\\[\\#9966cc\\]:hover { background-color: var(--color-brand-accent-secondary) !important; }

            /* Soft Lavender (#C0BBEB) */
            .text-\\[\\#C0BBEB\\], .text-\\[\\#c0bbeb\\], [class*="text-[#c0bbeb]"], [class*="text-[#C0BBEB]"] { color: var(--color-brand-accent-soft) !important; }
            .bg-\\[\\#C0BBEB\\], .bg-\\[\\#c0bbeb\\], [class*="bg-[#c0bbeb]"], [class*="bg-[#C0BBEB]"] { background-color: var(--color-brand-accent-soft) !important; }
            .border-\\[\\#C0BBEB\\], .border-\\[\\#c0bbeb\\], [class*="border-[#c0bbeb]"], [class*="border-[#C0BBEB]"] { border-color: var(--color-brand-accent-soft) !important; }
        `;
        document.head.appendChild(style);

        return () => {
            style.remove();
        };
    }, [colorBlindMode]);

    if (parentContext !== undefined) {
        return <>{children}</>;
    }

    const baseTheme = isDarkMode ? darkTheme : lightTheme;
    const theme = getThemeWithColorBlindOverrides(baseTheme, colorBlindMode, isDarkMode);

    return (
        <ThemeContext.Provider value={{ isDarkMode, toggleTheme, theme, colorBlindMode, setColorBlindMode }}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}; 