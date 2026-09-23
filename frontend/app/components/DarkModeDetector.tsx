'use client';

import { useEffect, useState } from 'react';

interface DarkModeExtensionInfo {
    isDarkReaderActive: boolean;
    hasCustomDarkMode: boolean;
    extensionType: 'darkreader' | 'custom' | 'none';
    htmlAttributes: string[];
}

export function useDarkModeExtensionDetector(): DarkModeExtensionInfo {
    const [extensionInfo, setExtensionInfo] = useState<DarkModeExtensionInfo>({
        isDarkReaderActive: false,
        hasCustomDarkMode: false,
        extensionType: 'none',
        htmlAttributes: []
    });

    useEffect(() => {
        const detectDarkModeExtension = () => {
            const html = document.documentElement;
            const attributes: string[] = [];

            const isDarkReaderActive =
                html.hasAttribute('data-darkreader-mode') ||
                html.hasAttribute('data-darkreader-scheme') ||
                document.querySelector('meta[name="darkreader"]') !== null ||
                document.querySelector('style[data-darkreader]') !== null;

            const hasCustomDarkMode =
                html.classList.contains('dark') ||
                html.classList.contains('dark-mode') ||
                html.hasAttribute('data-theme') ||
                html.hasAttribute('data-dark-mode') ||
                document.body.classList.contains('dark') ||
                document.body.classList.contains('dark-mode');

            Array.from(html.attributes).forEach(attr => {
                if (attr.name.includes('dark') || attr.name.includes('theme')) {
                    attributes.push(`${attr.name}="${attr.value}"`);
                }
            });

            let extensionType: 'darkreader' | 'custom' | 'none' = 'none';
            if (isDarkReaderActive) {
                extensionType = 'darkreader';
            } else if (hasCustomDarkMode) {
                extensionType = 'custom';
            }

            setExtensionInfo({
                isDarkReaderActive,
                hasCustomDarkMode,
                extensionType,
                htmlAttributes: attributes
            });
        };

        detectDarkModeExtension();

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' &&
                    (mutation.attributeName?.includes('dark') ||
                        mutation.attributeName?.includes('theme'))) {
                    detectDarkModeExtension();
                }
            });
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-darkreader-mode', 'data-darkreader-scheme', 'class', 'data-theme', 'data-dark-mode']
        });

        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'data-theme', 'data-dark-mode']
        });

        return () => observer.disconnect();
    }, []);

    return extensionInfo;
}

export function useDarkModeExtensionCompatibility() {
    useEffect(() => {
        const html = document.documentElement;

        html.classList.add('dark-mode-extension-aware');

        const isDarkReaderActive = html.hasAttribute('data-darkreader-mode');

        if (isDarkReaderActive) {
            html.style.setProperty('--dark-mode-extension', 'darkreader');

            const style = document.createElement('style');
            style.textContent = `
        /* Styles to work better with Dark Reader */
        [data-darkreader-mode="dynamic"] {
          /* Your custom styles here */
        }
      `;
            document.head.appendChild(style);

            return () => {
                document.head.removeChild(style);
            };
        }
    }, []);
}

export function withDarkModeExtensionAwareness<P extends object>(
    Component: React.ComponentType<P>
) {
    return function DarkModeExtensionAwareComponent(props: P) {
        const extensionInfo = useDarkModeExtensionDetector();

        return (
            <div data-dark-mode-extension={extensionInfo.extensionType}>
                <Component {...props} extensionInfo={extensionInfo} />
            </div>
        );
    };
} 