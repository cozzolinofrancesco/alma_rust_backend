"use client";

import { LogIn, LogOut, User, X, Eye, Settings, RefreshCw } from "lucide-react";
import { signIn, signOut, useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { useTheme, ColorBlindMode } from "../../contexts/ThemeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useMagnifier } from "../../contexts/MagnifierContext";

interface SettingsPopupProps {
    isVisible: boolean;
    onClose: () => void;
    buttonRef: React.RefObject<HTMLButtonElement | null>;
}

export default function SettingsPopup({ isVisible, onClose, buttonRef }: SettingsPopupProps) {
    const { data: session, status } = useSession();
    const { theme, isDarkMode, toggleTheme, colorBlindMode, setColorBlindMode } = useTheme();
    const { t } = useLanguage();
    const {
        isMagnifierEnabled,
        setIsMagnifierEnabled,
        zoomLevel,
        setZoomLevel,
        lensSize,
        setLensSize
    } = useMagnifier();

    const [activeTab, setActiveTab] = useState<'general' | 'accessibility'>('general');
    const popupRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                popupRef.current &&
                !popupRef.current.contains(event.target as Node) &&
                buttonRef.current &&
                !buttonRef.current.contains(event.target as Node)
            ) {
                onClose();
            }
        };

        if (isVisible) {
            document.addEventListener("mousedown", handleClickOutside);
            return () => document.removeEventListener("mousedown", handleClickOutside);
        }
    }, [isVisible, onClose, buttonRef]);

    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        if (isVisible) {
            document.addEventListener("keydown", handleEscape);
            return () => document.removeEventListener("keydown", handleEscape);
        }
    }, [isVisible, onClose]);

    if (!isVisible) return null;

    const getPopupPosition = () => {
        if (!buttonRef.current) return { bottom: "100%", left: "0" };

        return {
            bottom: "100%",
            left: "0",
            marginBottom: "8px"
        };
    };

    const popupStyle = getPopupPosition();

    return (
        <div
            id="settings-popup-el"
            ref={popupRef}
            className={`absolute z-50 w-72 ${theme.cardBg} border ${theme.borderColor} rounded-lg shadow-xl p-3`}
            style={popupStyle}
        >
            {}
            <div className="flex items-center justify-between mb-2">
                <h3 className={`text-sm font-semibold ${theme.textPrimary} flex items-center gap-1.5`}>
                    <Settings className="w-4 h-4" />
                    {t('settings.title') || 'Settings'}
                </h3>
                <button
                    onClick={onClose}
                    className={`p-1 ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover} rounded transition-colors`}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {}
            <div className={`flex border-b ${theme.borderColor} mb-3`}>
                <button
                    onClick={() => setActiveTab('general')}
                    className={`flex-1 pb-1.5 text-xs font-semibold border-b-2 transition-colors ${
                        activeTab === 'general'
                            ? `border-b-current ${theme.textPrimary}`
                            : `border-transparent ${theme.textMuted} hover:${theme.textSecondary}`
                    }`}
                >
                    {t('settings.general') || 'General'}
                </button>
                <button
                    onClick={() => setActiveTab('accessibility')}
                    className={`flex-1 pb-1.5 text-xs font-semibold border-b-2 transition-colors ${
                        activeTab === 'accessibility'
                            ? `border-b-current ${theme.textPrimary}`
                            : `border-transparent ${theme.textMuted} hover:${theme.textSecondary}`
                    }`}
                >
                    {t('settings.accessibility') || 'Accessibility'}
                </button>
            </div>

            {}
            {activeTab === 'general' ? (
                <div className="space-y-3">
                    {}
                    <div className="space-y-2">
                        {status === "loading" ? (
                            <div className={`flex items-center gap-2 text-sm ${theme.textSecondary}`}>
                                <div className={`w-4 h-4 border-2 ${theme.borderColor} border-t-2 border-t-current rounded-full animate-spin`}></div>
                                Loading...
                            </div>
                        ) : session ? (
                            <>
                                {}
                                <div className={`flex items-center gap-2 p-2 ${theme.buttonBg} rounded text-xs`}>
                                    <User className={`w-3.5 h-3.5 ${theme.textPrimary}`} />
                                    <div className="min-w-0 flex-1">
                                        <div className={`font-semibold ${theme.textPrimary} truncate`}>
                                            {session.user?.name || "User"}
                                        </div>
                                        <div className={`text-[10px] ${theme.textSecondary} truncate`}>
                                            {session.user?.email}
                                        </div>
                                    </div>
                                </div>

                                {}
                                <button
                                    onClick={() => signOut()}
                                    className={`w-full flex items-center gap-2 p-1.5 text-xs ${theme.buttonBg} ${theme.textSecondary} rounded ${theme.buttonHover} transition-colors font-medium`}
                                >
                                    <LogOut className="w-3.5 h-3.5" />
                                    {t('settings.logout') || 'Sign out'}
                                </button>
                            </>
                        ) : (
                            <>
                                {}
                                <button
                                    onClick={() => signIn("google")}
                                    className={`w-full flex items-center gap-2 p-2 text-xs ${theme.accentBg} text-white rounded ${theme.accentHover} transition-colors font-semibold justify-center`}
                                >
                                    <LogIn className="w-3.5 h-3.5" />
                                    Sign in with Google
                                </button>
                            </>
                        )}
                    </div>

                    {}
                    <div className={`pt-2 border-t ${theme.borderColor} space-y-1.5`}>
                        <label className={`text-[10px] font-semibold uppercase tracking-wider ${theme.textSecondary}`}>
                            {t('settings.appearance') || 'Appearance'}
                        </label>
                        <button
                            onClick={toggleTheme}
                            className={`w-full flex items-center justify-between p-2 text-xs ${theme.buttonBg} ${theme.textSecondary} rounded ${theme.buttonHover} transition-colors`}
                        >
                            <span className="font-medium">{isDarkMode ? 'Dark Mode' : 'Light Mode'}</span>
                            <span className="text-[10px] opacity-75">Toggle</span>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    {}
                    <div className="space-y-1">
                        <label className={`text-[10px] font-semibold uppercase tracking-wider ${theme.textSecondary}`}>
                            {t('settings.colorBlindMode') || 'Color Blind Mode'}
                        </label>
                        <select
                          value={colorBlindMode}
                          onChange={(e) => setColorBlindMode(e.target.value as ColorBlindMode)}
                          className={`w-full p-2 text-xs ${theme.buttonBg} ${theme.textPrimary} border ${theme.borderColor} rounded outline-none cursor-pointer font-medium`}
                        >
                          <option value="none">{t('settings.colorBlindNone') || 'Normal Color'}</option>
                          <option value="deuteranopia">{t('settings.colorBlindDeuteranopia') || 'Deuteranopia (Green-Weak)'}</option>
                          <option value="protanopia">{t('settings.colorBlindProtanopia') || 'Protanopia (Red-Weak)'}</option>
                          <option value="tritanopia">{t('settings.colorBlindTritanopia') || 'Tritanopia (Blue-Weak)'}</option>
                        </select>
                    </div>

                    {}
                    <div className={`pt-2 border-t ${theme.borderColor} space-y-2`}>
                        <div className="flex items-center justify-between">
                            <label className={`text-[10px] font-semibold uppercase tracking-wider ${theme.textSecondary} flex items-center gap-1`}>
                                <Eye className="w-3 h-3" />
                                {t('settings.magnifierEnable') || 'Screen Magnifier'}
                            </label>
                            
                            {}
                            <button
                              type="button"
                              onClick={() => setIsMagnifierEnabled(!isMagnifierEnabled)}
                              disabled={false}
                              className={`w-9 h-5 rounded-full relative transition-colors duration-200 outline-none ${
                                isMagnifierEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'
                              } cursor-pointer`}
                            >
                              <div
                                className={`w-3.5 h-3.5 rounded-full bg-white absolute top-0.75 shadow-sm transition-all duration-200 ${
                                  isMagnifierEnabled ? 'left-4.5' : 'left-0.75'
                                }`}
                                style={{ top: '3px' }}
                              />
                            </button>
                        </div>

                        {}
                        {isMagnifierEnabled && (
                            <div className="space-y-2 mt-1.5 p-2 bg-black/5 dark:bg-white/5 rounded-md text-xs">
                                {}
                                <div className="space-y-1">
                                    <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400 font-medium">
                                        <span>{t('settings.magnifierZoom') || 'Zoom Level'}</span>
                                        <span className="font-semibold text-blue-600 dark:text-blue-400">{zoomLevel.toFixed(1)}x</span>
                                    </div>
                                    <input
                                      type="range"
                                      min="1.5"
                                      max="3.0"
                                      step="0.1"
                                      value={zoomLevel}
                                      onChange={(e) => setZoomLevel(parseFloat(e.target.value))}
                                      className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                    />
                                </div>

                                {}
                                <div className="space-y-1">
                                    <div className="text-[10px] text-gray-500 dark:text-gray-400 font-medium">
                                        {t('settings.magnifierSize') || 'Lens Size'}
                                    </div>
                                    <div className="flex gap-1">
                                        {(['small', 'medium', 'large'] as const).map((size) => (
                                            <button
                                              key={size}
                                              type="button"
                                              onClick={() => setLensSize(size)}
                                              className={`flex-1 py-1 text-[10px] rounded border transition-colors font-semibold uppercase ${
                                                lensSize === size
                                                  ? 'border-blue-600 bg-blue-500/15 text-blue-600 dark:text-blue-400'
                                                  : `border-transparent ${theme.buttonBg} ${theme.textSecondary} hover:${theme.buttonHover}`
                                              }`}
                                            >
                                              {t(`settings.lens${size.charAt(0).toUpperCase() + size.slice(1)}`) || size}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {}
                                <button
                                  type="button"
                                  onClick={() => {}}
                                  disabled={false}
                                  className={`w-full flex items-center justify-center gap-1.5 py-1 px-2 rounded border text-[10px] font-semibold transition-colors mt-1 border-transparent ${theme.buttonBg} ${theme.textSecondary} hover:${theme.buttonHover}`}
                                >
                                  <RefreshCw className="w-3 h-3" />
                                  {t('settings.magnifierRefresh') || 'Refresh Screenshot'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
