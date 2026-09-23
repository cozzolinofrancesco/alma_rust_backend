'use client';

import { useDarkModeExtensionCompatibility, useDarkModeExtensionDetector } from './DarkModeDetector';

export function ExampleDarkModeAwareComponent() {
    const extensionInfo = useDarkModeExtensionDetector();

    useDarkModeExtensionCompatibility();

    return (
        <div style={{
            padding: '20px',
            backgroundColor: extensionInfo.isDarkReaderActive ? 'var(--bg-color, #f0f0f0)' : '#f0f0f0',
            color: extensionInfo.isDarkReaderActive ? 'var(--text-color, #333)' : '#333',
            border: '1px solid #ccc',
            borderRadius: '8px',
            margin: '10px 0'
        }}>
            <h3>Dark Mode Extension Aware Component</h3>

            {extensionInfo.extensionType !== 'none' && (
                <div style={{
                    padding: '10px',
                    backgroundColor: 'rgba(255, 165, 0, 0.1)',
                    border: '1px solid orange',
                    borderRadius: '4px',
                    marginBottom: '10px'
                }}>
                    <strong>⚠️ Dark Mode Extension Detected:</strong> {extensionInfo.extensionType}
                    <br />
                    <small>This component is adapting its styles accordingly.</small>
                </div>
            )}

            <p>
                This component automatically detects and adapts to dark mode extensions like Dark Reader.
            </p>

            <div style={{ fontSize: '14px', color: '#666' }}>
                <strong>Detection Results:</strong>
                <ul>
                    <li>Extension Type: {extensionInfo.extensionType}</li>
                    <li>Dark Reader: {extensionInfo.isDarkReaderActive ? '✅ Active' : '❌ Not detected'}</li>
                    <li>Custom Dark Mode: {extensionInfo.hasCustomDarkMode ? '✅ Active' : '❌ Not detected'}</li>
                    {extensionInfo.htmlAttributes.length > 0 && (
                        <li>HTML Attributes: {extensionInfo.htmlAttributes.join(', ')}</li>
                    )}
                </ul>
            </div>
        </div>
    );
}

export function ConditionalDarkModeContent() {
    const { isDarkReaderActive } = useDarkModeExtensionDetector();

    if (isDarkReaderActive) {
        return (
            <div style={{
                padding: '15px',
                backgroundColor: 'transparent',
                color: 'inherit',
                border: '2px solid currentColor',
                borderRadius: '8px'
            }}>
                <h4>🌙 Dark Reader Optimized Content</h4>
                <p>This content is optimized for Dark Reader extension.</p>
            </div>
        );
    }

    return (
        <div style={{
            padding: '15px',
            backgroundColor: '#ffffff',
            color: '#333333',
            border: '2px solid #e0e0e0',
            borderRadius: '8px',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}>
            <h4>☀️ Standard Light Mode Content</h4>
            <p>This content uses standard light mode styling.</p>
        </div>
    );
} 