'use client';

import React, { useEffect, useMemo, useState } from "react";
import { FaCode, FaFlask, FaGavel, FaTimesCircle, FaUserTie } from "react-icons/fa";
import styles from '../styles/SystemInstructionsSelector.module.css';


type Personality = 'coder' | 'scientist' | 'lawyer' | 'manager' | null;
type CodingLanguage = 'python' | 'rust' | 'nextjs' | 'r' | null;

const personalityPrompts: Record<Exclude<Personality, null>, string> = {
    coder: "Act as a highly skilled software engineer. Prioritize writing clean, efficient, well-documented, and maintainable code. Always consider security implications and error handling.",
    scientist: "Act as a meticulous scientist. Focus on designing experiments, analyzing data rigorously, interpreting results objectively, and ensuring reproducibility. Always cite sources and consider potential biases.",
    lawyer: "Act as a diligent lawyer. Focus on legal research, applying relevant laws and precedents, drafting clear and persuasive arguments, and adhering to ethical guidelines. Ensure all advice is legally sound and contextually appropriate.",
    manager: "Act as an effective manager. Focus on organizing tasks, delegating appropriately, communicating clearly with your team, resolving conflicts, and ensuring project goals are met efficiently and effectively."
};

const codingLanguagePrompts: Record<Exclude<CodingLanguage, null>, string> = {
    python: "Adhere to PEP 8 style guidelines. Utilize type hints for clarity. Prefer standard library solutions where appropriate. Write idiomatic Python code. Use virtual environments.",
    rust: "Prioritize memory safety using ownership, borrowing, and lifetimes. Handle errors explicitly using `Result` and `Option`. Follow Rust's idiomatic practices. Leverage Cargo for dependency management and builds.",
    nextjs: "Follow React best practices. Use TypeScript extensively, avoiding `any`. Declare variables with appropriate types and ensure all declared variables are used. Use `const` and `let` appropriately. Utilize Next.js data fetching methods (`getStaticProps`, `getServerSideProps`, API routes) effectively. Structure components logically. Avoid direct DOM manipulation where possible.",
    r: "Focus on data manipulation using packages like `dplyr` or `data.table`. Create visualizations with `ggplot2`. Ensure statistical rigor in analysis. Promote reproducibility using tools like `renv`. Prefer vectorized operations over loops."
};

interface SystemInstructionsSelectorProps {
    onInstructionsChange: (prompt: string) => void;
    initialPersonality?: Personality;
    initialLanguage?: CodingLanguage;
    clearTrigger?: number;
    currentInstruction: string;
}

const SystemInstructionsSelector: React.FC<SystemInstructionsSelectorProps> = ({
    onInstructionsChange,
    initialPersonality = null,
    initialLanguage = null,
    clearTrigger = 0,
    currentInstruction,
}) => {
    const [selectedPersonality, setSelectedPersonality] = useState<Personality>(initialPersonality);
    const [selectedLanguage, setSelectedLanguage] = useState<CodingLanguage>(initialLanguage);

    useEffect(() => {
        let matchedPersonality: Personality = null;
        let matchedLanguage: CodingLanguage = null;
        let foundMatch = false;

        const coderPrompt = personalityPrompts.coder;
        const combinedPrefix = coderPrompt + "\n\n";
        if (
            currentInstruction.length > combinedPrefix.length &&
            currentInstruction.startsWith(combinedPrefix)
        ) {
            const languagePart = currentInstruction.substring(combinedPrefix.length);
            for (const langKey in codingLanguagePrompts) {
                const language = langKey as Exclude<CodingLanguage, null>;
                if (codingLanguagePrompts[language] === languagePart) {
                    matchedPersonality = "coder";
                    matchedLanguage = language;
                    foundMatch = true;
                    break;
                }
            }
        }

        if (!foundMatch) {
            for (const persKey in personalityPrompts) {
                const personality = persKey as Exclude<Personality, null>;
                if (personalityPrompts[personality] === currentInstruction) {
                    matchedPersonality = personality;
                    matchedLanguage = null;
                    foundMatch = true;
                    break;
                }
            }
        }

        if (foundMatch) {
            if (
                selectedPersonality !== matchedPersonality ||
                selectedLanguage !== matchedLanguage
            ) {
                setSelectedPersonality(matchedPersonality);
                setSelectedLanguage(matchedLanguage);
            }
        }
    }, [currentInstruction]);

    const generatedPrompt = useMemo(() => {
        let result = "";
        if (selectedPersonality) {
            result += personalityPrompts[selectedPersonality];
            if (selectedPersonality === "coder" && selectedLanguage) {
                result += "\n\n" + codingLanguagePrompts[selectedLanguage];
            }
        }
        return result;
    }, [selectedPersonality, selectedLanguage]);

    useEffect(() => {
        if (
            selectedPersonality &&
            generatedPrompt !== currentInstruction
        ) {
            onInstructionsChange(generatedPrompt);
        }
    }, [generatedPrompt, currentInstruction, onInstructionsChange, selectedPersonality]);

    useEffect(() => {
        setSelectedPersonality(null);
        setSelectedLanguage(null);
    }, [clearTrigger]);

    const handlePersonalitySelect = (p: Personality) => {
        if (selectedPersonality === p) {
            setSelectedPersonality(null);
            setSelectedLanguage(null);
        } else {
            setSelectedPersonality(p);
            if (p !== "coder") {
                setSelectedLanguage(null);
            }
        }
    };

    const handleLanguageSelect = (lang: CodingLanguage) => {
        if (selectedLanguage === lang) {
            setSelectedLanguage(null);
        } else {
            setSelectedLanguage(lang);
        }
    };

    return (
        <div className={styles["system-instructions-section"]}>
            <div className={styles.personalities}>
                <button
                    className={`${styles["personality-icon"]} ${selectedPersonality === "coder" ? styles.selected : ""
                        }`}
                    onClick={() => handlePersonalitySelect("coder")}
                    title="Coder Personality"
                    aria-label="Select Coder Personality"
                >
                    <FaCode size={24} />
                    <span>Coder</span>
                </button>
                <button
                    className={`${styles["personality-icon"]} ${selectedPersonality === "scientist" ? styles.selected : ""
                        }`}
                    onClick={() => handlePersonalitySelect("scientist")}
                    title="Scientist Personality"
                    aria-label="Select Scientist Personality"
                >
                    <FaFlask size={24} />
                    <span>Scientist</span>
                </button>
                <button
                    className={`${styles["personality-icon"]} ${selectedPersonality === "lawyer" ? styles.selected : ""
                        }`}
                    onClick={() => handlePersonalitySelect("lawyer")}
                    title="Lawyer Personality"
                    aria-label="Select Lawyer Personality"
                >
                    <FaGavel size={24} />
                    <span>Lawyer</span>
                </button>
                <button
                    className={`${styles["personality-icon"]} ${selectedPersonality === "manager" ? styles.selected : ""
                        }`}
                    onClick={() => handlePersonalitySelect("manager")}
                    title="Manager Personality"
                    aria-label="Select Manager Personality"
                >
                    <FaUserTie size={24} />
                    <span>Manager</span>
                </button>
                {selectedPersonality && (
                    <button
                        className={`${styles["personality-icon"]} ${styles["clear-selection"]}`}
                        onClick={() => handlePersonalitySelect(null)}
                        title="Clear Personality Selection"
                        aria-label="Clear Personality Selection"
                    >
                        <FaTimesCircle size={24} />
                        <span>Clear</span>
                    </button>
                )}
            </div>

            {selectedPersonality === "coder" && (
                <div className={styles["coding-languages"]}>
                    <h5>Coding Language:</h5>
                    <button
                        className={`${styles["language-option"]} ${selectedLanguage === "python" ? styles.selected : ""
                            }`}
                        onClick={() => handleLanguageSelect("python")}
                        aria-label="Select Python"
                    >
                        Python
                    </button>
                    <button
                        className={`${styles["language-option"]} ${selectedLanguage === "rust" ? styles.selected : ""
                            }`}
                        onClick={() => handleLanguageSelect("rust")}
                        aria-label="Select Rust"
                    >
                        Rust
                    </button>
                    <button
                        className={`${styles["language-option"]} ${selectedLanguage === "nextjs" ? styles.selected : ""
                            }`}
                        onClick={() => handleLanguageSelect("nextjs")}
                        aria-label="Select Next.js"
                    >
                        Next.js
                    </button>
                    <button
                        className={`${styles["language-option"]} ${selectedLanguage === "r" ? styles.selected : ""
                            }`}
                        onClick={() => handleLanguageSelect("r")}
                        aria-label="Select R"
                    >
                        R
                    </button>
                    {selectedLanguage && (
                        <button
                            className={`${styles["language-option"]} ${styles["clear-selection"]}`}
                            onClick={() => handleLanguageSelect(null)}
                            aria-label="Clear Language Selection"
                        >
                            Clear
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default SystemInstructionsSelector;
