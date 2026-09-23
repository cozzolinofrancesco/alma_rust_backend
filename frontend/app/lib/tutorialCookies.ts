import Cookies from 'js-cookie';

interface TutorialCookieData {
    lastShown: number;
    context: string;
    completed: boolean;
}

const TUTORIAL_COOKIE_NAME = 'alma_tutorial_shown';
const COOKIE_DURATION_DAYS = 30;

const BYPASS_COOKIES_FOR_TESTING = process.env.NODE_ENV === 'development';

export const getTutorialCookie = (): TutorialCookieData | null => {
    if (BYPASS_COOKIES_FOR_TESTING) {
        console.log('🧪 Development mode: Bypassing tutorial cookie check');
        return null;
    }

    try {
        const cookieValue = Cookies.get(TUTORIAL_COOKIE_NAME);
        if (!cookieValue) return null;

        return JSON.parse(cookieValue) as TutorialCookieData;
    } catch (error) {
        console.error('Error parsing tutorial cookie:', error);
        return null;
    }
};

export const setTutorialCookie = (data: TutorialCookieData): void => {
    try {
        const cookieValue = JSON.stringify(data);
        Cookies.set(TUTORIAL_COOKIE_NAME, cookieValue, {
            expires: COOKIE_DURATION_DAYS,
            sameSite: 'lax'
        });

        if (BYPASS_COOKIES_FOR_TESTING) {
            console.log('🧪 Development mode: Tutorial cookie set but will be bypassed on next check');
        }
    } catch (error) {
        console.error('Error setting tutorial cookie:', error);
    }
};

export const shouldShowTutorial = (): boolean => {
    if (BYPASS_COOKIES_FOR_TESTING) {
        console.log('🧪 Development mode: Always showing tutorial for testing');
        return true;
    }

    const cookieData = getTutorialCookie();

    if (!cookieData) return true;

    const oneMonthAgo = Date.now() - (COOKIE_DURATION_DAYS * 24 * 60 * 60 * 1000);
    return cookieData.lastShown < oneMonthAgo;
};

export const markTutorialCompleted = (context: string): void => {
    setTutorialCookie({
        lastShown: Date.now(),
        context,
        completed: true
    });
};

export const clearTutorialCookie = (): void => {
    Cookies.remove(TUTORIAL_COOKIE_NAME);
}; 