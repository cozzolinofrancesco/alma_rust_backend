"use client";

import { useTheme } from "../../contexts/ThemeContext";
import { LogIn, LogOut, User } from "lucide-react";
import { signIn, signOut, useSession } from "next-auth/react";

export default function LoginWithGoogle() {
    const { data: session, status } = useSession();
    const { theme } = useTheme();

    if (status === "loading") {
        return (
            <div className={`flex items-center gap-2 px-3 py-1.5 text-sm ${theme.textSecondary}`}>
                <div className={`w-4 h-4 border-2 ${theme.borderColor} border-t-2 border-t-current rounded-full animate-spin`}></div>
                Loading...
            </div>
        );
    }

    if (session) {
        return (
            <div className="flex items-center gap-2">
                <div className={`flex items-center gap-2 px-3 py-1.5 text-sm ${theme.textPrimary}`}>
                    <User className="w-4 h-4" />
                    <span className="hidden sm:inline">
                        {session.user?.name || session.user?.email}
                    </span>
                </div>
                <button
                    onClick={() => signOut()}
                    className={`flex items-center gap-2 px-3 py-1.5 text-sm ${theme.buttonBg} ${theme.textSecondary} rounded-lg ${theme.buttonHover} transition-colors`}
                >
                    <LogOut className="w-4 h-4" />
                    <span className="hidden sm:inline">Sign out</span>
                </button>
            </div>
        );
    }

    return (
        <button
            onClick={() => signIn("google")}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm ${theme.accentBg} text-white rounded-lg ${theme.accentHover} transition-colors`}
        >
            <LogIn className="w-4 h-4" />
            <span className="hidden sm:inline">Sign in with Google</span>
        </button>
    );
} 