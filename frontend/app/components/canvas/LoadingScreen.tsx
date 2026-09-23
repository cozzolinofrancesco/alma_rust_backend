'use client'

import { useEffect, useState } from 'react';
import styles from '../../styles/canvas/LoadingScreen.module.css';

const FULL_TEXT = '... from so simple a beginning endless forms most beautiful and most wonderful have been, and are being, evolved.';

export default function LoadingScreen({ onFinish }: { onFinish?: () => void }) {
    const [displayedText, setDisplayedText] = useState('');
    const [showButton, setShowButton] = useState(false);

    useEffect(() => {
        console.log('LoadingScreen mounted, starting typing animation');

        let index = 0;
        let currentDisplayedText = '';
        let timeoutId: NodeJS.Timeout;

        const typeNextCharacter = () => {
            if (index < FULL_TEXT.length) {
                const nextChar = FULL_TEXT[index];
                console.log(`Typing character ${index}: "${nextChar}"`);

                currentDisplayedText += nextChar;
                setDisplayedText(currentDisplayedText);

                index++;

                if (currentDisplayedText.endsWith('being, ')) {
                    console.log('Pausing for 1 second after "being,"');
                    timeoutId = setTimeout(typeNextCharacter, 1000);
                    return;
                }

                let delay = 50;
                if (nextChar === '.' || nextChar === ',' || nextChar === ';') {
                    delay = 300;
                } else if (nextChar === ' ') {
                    delay = 80;
                }

                timeoutId = setTimeout(typeNextCharacter, delay);
            } else {
                console.log('Typing complete, showing button');
                timeoutId = setTimeout(() => {
                    setShowButton(true);
                }, 1000);
            }
        };

        timeoutId = setTimeout(typeNextCharacter, 500);

        return () => {
            console.log('LoadingScreen unmounting');
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        };
    }, []);

    const handleSkip = () => {
        console.log('Skip button clicked - going to next page');
        if (onFinish) {
            onFinish();
        }
    };

    const handleContinue = () => {
        console.log('Continue button clicked');

        if (onFinish) {
            onFinish();
        }
    };

    console.log('LoadingScreen render, displayedText length:', displayedText.length);

    return (
        <div className={styles.loadingContainer}>
            <div className={styles.contentContainer}>
                {}
                <div className={styles.quoteContainer}>
                    <p className={styles.quoteText}>
                        {displayedText}
                        {!showButton && (
                            <span className={styles.cursor}>|</span>
                        )}
                    </p>
                </div>

                {}
                <div className={styles.buttonContainer}>
                    {}
                    {!showButton && (
                        <button
                            onClick={handleSkip}
                            className={styles.skipButton}
                        >
                            Skip
                        </button>
                    )}

                    {}
                    {showButton && (
                        <div className={styles.fadeInAnimation}>
                            <button
                                onClick={handleContinue}
                                className={styles.continueButton}
                            >
                                Time to write the next chapter
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
} 