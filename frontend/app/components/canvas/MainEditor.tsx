'use client';

import nextDynamic from 'next/dynamic';
import {
    Bold,
    CheckSquare,
    Code,
    Copy,
    Download,
    FileText,
    Folder,
    GitBranch,
    Image,
    Italic,
    Link,
    List, ListOrdered,
    Maximize2,
    Minimize2,
    Moon,
    Palette,
    Redo,
    Strikethrough,
    Sun,
    Type,
    Underline,
    Undo,
    Upload,
    Wand2
} from 'lucide-react';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useDocument } from '../../contexts/DocumentContext';
import { useEditor } from '../../contexts/EditorContext';
import { useAgentSteps } from '../../contexts/AgentStepContext';
import { useIntegrityChain } from '../../contexts/IntegrityChainContext';
import { useTheme } from '../../contexts/ThemeContext';
import IntegrityChainModal from '../IntegrityChainModal';
import styles from '../../styles/canvas/MainEditor.module.css';
import { useProjectState } from '../ProjectStateContext';

const MainEditorPreview = nextDynamic(() => import('./MainEditorPreview'), { ssr: false });
import { useProjectContext } from './services/projectFileService';
import DriveFileBrowser from './DriveFileBrowser';
import QCModal from './QCModal';
import { DEFAULT_MODEL } from '../../lib/modelConfig';
import { filterAIResponseSections } from '../../lib/filterAIStepOutput';

type IconComponent = React.ComponentType<{ className?: string }>;
const MIN_PANE_WIDTH_PERCENT = 20;
const MAX_PANE_WIDTH_PERCENT = 80;

interface MainEditorProps {
    focusMode: 'none' | 'editor' | 'preview';
    onToggleEditorFocusMode: () => void;
    onTogglePreviewFocusMode: () => void;
}

export default function MainEditor({ focusMode, onToggleEditorFocusMode, onTogglePreviewFocusMode }: MainEditorProps) {
    const {
        mode,
        activeSection,
        getCurrentSectionContent,
        updateSectionContent,
        getMergedDocument,
        template,
        setActiveSection,
        resetDocument
    } = useDocument();

    const getDisplayContent = () => {
        if (mode === 'previewing') {
            return getMergedDocument();
        } else if (activeSection) {
            return getCurrentSectionContent();
        }
        return `# Your Document

Start typing here... This editor works like Google Docs but with **markdown** and math support!

## Math Examples

### Inline Formulas
The quadratic formula $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$ is used to solve quadratic equations. Einstein's mass-energy equivalence $E = mc^2$ revolutionized physics, while the golden ratio $\\phi = \\frac{1 + \\sqrt{5}}{2} \\approx 1.618$ appears in nature and art.

### Block Formulas
The Gaussian integral:
$$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$

Matrix multiplication:
$$\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix} \\begin{bmatrix} x \\\\ y \\end{bmatrix} = \\begin{bmatrix} ax + by \\\\ cx + dy \\end{bmatrix}$$

### Multi-line Equations
System of linear equations:
$$
\\begin{cases}
2x + 3y = 7 \\\\
x - y = 1
\\end{cases}
$$

Taylor series expansion:
$$f(x) = f(a) + f'(a)(x-a) + \\frac{f''(a)}{2!}(x-a)^2 + \\frac{f'''(a)}{3!}(x-a)^3 + \\cdots$$

## Formatting
- **Bold text** for emphasis
- *Italic text* for style
- \`inline code\` for technical terms
- [Links](https://example.com) for references
- ~~strikethrough~~ for deleted content

## Complex Tables

### Scientific Data
| Element | Symbol | Atomic # | Mass (u) | Electron Config |
|---------|:------:|:--------:|---------:|:----------------|
| Hydrogen | H | 1 | 1.008 | 1s¹ |
| Helium | He | 2 | 4.003 | 1s² |
| Lithium | Li | 3 | 6.941 | [He] 2s¹ |
| Carbon | C | 6 | 12.011 | [He] 2s² 2p² |

### Mathematical Functions
| Function | Formula | Domain | Range |
|----------|:-------:|:------:|:-----:|
| Sine | $\\sin(x)$ | $(-\\infty, \\infty)$ | $[-1, 1]$ |
| Exponential | $e^x$ | $(-\\infty, \\infty)$ | $(0, \\infty)$ |
| Logarithm | $\\ln(x)$ | $(0, \\infty)$ | $(-\\infty, \\infty)$ |

Just type markdown and see it render instantly with advanced math and table support!`;
    };

    const { projectFolder } = useProjectState();
    const [content, setContent] = useState(getDisplayContent());
    const [showColorPicker, setShowColorPicker] = useState(false);
    const [showFontSize, setShowFontSize] = useState(false);
    const [showLinkDialog, setShowLinkDialog] = useState(false);
    const [linkUrl, setLinkUrl] = useState('');
    const [linkText, setLinkText] = useState('');
    const [showImageDialog, setShowImageDialog] = useState(false);
    const [imageUrl, setImageUrl] = useState('');
    const [imageAlt, setImageAlt] = useState('');
    const [isUploadingImage, setIsUploadingImage] = useState(false);
    const [isGeneratingDiagram, setIsGeneratingDiagram] = useState(false);

    const [showSelectionMenu, setShowSelectionMenu] = useState(false);
    const [selectionMenuPosition, setSelectionMenuPosition] = useState({ x: 0, y: 0 });
    const [selectedText, setSelectedText] = useState('');
    const [selectionMenuMode, setSelectionMenuMode] = useState<'ai' | 'format'>('ai');
    const [showPromptDialog, setShowPromptDialog] = useState(false);
    const [promptText, setPromptText] = useState('');
    const [currentAction, setCurrentAction] = useState<'grammar' | 'alternatives' | 'custom' | null>(null);
    const [systemPrompt, setSystemPrompt] = useState('');

    const [customPromptFiles, setCustomPromptFiles] = useState<FileData[]>([]);
    const [isProcessingCustomPrompt, setIsProcessingCustomPrompt] = useState(false);

    interface FileData {
        id: string;
        name: string;
        type: string;
        size: number;
        content: string | ArrayBuffer;
        preview?: string;
        uploadDate: Date;
        originalFile: File;
    }

    const SUPPORTED_FILE_TYPES = {
        'image/jpeg': '.jpg,.jpeg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'application/pdf': '.pdf',
        'text/plain': '.txt',
        'text/markdown': '.md',
        'text/csv': '.csv',
        'audio/mpeg': '.mp3',
        'audio/wav': '.wav',
        'audio/ogg': '.ogg',
        'video/mp4': '.mp4',
        'video/quicktime': '.mov',
        'video/x-msvideo': '.avi',
        'text/javascript': '.js',
        'text/typescript': '.ts',
        'application/json': '.json',
        'text/html': '.html',
        'text/css': '.css'
    };

    const MAX_FILE_SIZE = 30 * 1024 * 1024;

    const [showAIDialog, setShowAIDialog] = useState(false);
    const [aiPromptText, setAIPromptText] = useState('');
    const [aiContentType, setAIContentType] = useState('general');

    const [showDiagramDialog, setShowDiagramDialog] = useState(false);
    const [diagramPromptText, setDiagramPromptText] = useState('');
    const [diagramType, setDiagramType] = useState('flowchart');

    const [isMergedStepsView, setIsMergedStepsView] = useState(false);

    const [showExportModal, setShowExportModal] = useState(false);

    const [showQCModal, setShowQCModal] = useState(false);
    const router = useRouter();
    const [showIntegrityModal, setShowIntegrityModal] = useState(false);
    const [exportFormat, setExportFormat] = useState<'pdf' | 'tex'>('tex');
    const [exportDestination, setExportDestination] = useState<'computer' | 'drive' | 'gdoc'>('computer');
    const [exportStep, setExportStep] = useState<1 | 2 | 3>(1);

    const [contentHistory, setContentHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [leftPaneWidthPercent, setLeftPaneWidthPercent] = useState(99);
    const [isPaneResizing, setIsPaneResizing] = useState(false);
    const [isWideEditorLayout, setIsWideEditorLayout] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const splitPaneRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isMounted = useRef<boolean>(true);
    const abortController = useRef<AbortController | null>(null);
    const { theme, isDarkMode, toggleTheme } = useTheme();
    const { setInsertTextRef, setSaveToHistoryRef, setGetContentRef, setClearContentRef } = useEditor();
    const { initializeProjectContext, hasProjectContext } = useProjectContext();
    const { agentSteps, activeStepId, stepContents, stepCorpusIds, setActiveStepId, setStepContent, setAgentSteps } = useAgentSteps();
    const { chainLength, getChain, saveChain, listChains, loadChain } = useIntegrityChain();

    const handleQCClick = useCallback(() => {
        const stepId   = activeStepId;
        const text     = stepId !== null ? (stepContents[stepId] ?? '') : content;
        const stepName = stepId !== null
            ? agentSteps.find((s) => s.id === stepId)?.name
            : undefined;
        sessionStorage.setItem('canvas-qc-input', JSON.stringify({ text, stepName: stepName ?? 'Canvas Output' }));
        router.push('/claim-validation');
    }, [activeStepId, stepContents, content, agentSteps, router]);

    const activeStepIdRef = useRef<string | null>(null);
    activeStepIdRef.current = activeStepId;
    const stepContentsRef = useRef<Record<string, string>>({});
    stepContentsRef.current = stepContents;
    const setStepContentRef = useRef(setStepContent);
    setStepContentRef.current = setStepContent;
    const selectionRangeRef = useRef<{ start: number; end: number } | null>(null);

    useEffect(() => {
        if (isMergedStepsView) return;
        const newContent = getDisplayContent();
        setContent(newContent);
    }, [mode, activeSection, template, isMergedStepsView]);

    useEffect(() => {
        const mediaQuery = window.matchMedia('(min-width: 1025px)');
        const updateLayoutMode = () => {
            setIsWideEditorLayout(mediaQuery.matches);
        };

        updateLayoutMode();
        mediaQuery.addEventListener('change', updateLayoutMode);

        return () => {
            mediaQuery.removeEventListener('change', updateLayoutMode);
        };
    }, []);

    useEffect(() => {
        if (mode === 'writing' && activeSection && content !== getCurrentSectionContent()) {
            const timeoutId = setTimeout(() => {
                updateSectionContent(activeSection, content);
            }, 500);

            return () => clearTimeout(timeoutId);
        }
    }, [content, mode, activeSection]);

    const aiContentTypes = [
        { value: 'general', label: 'General Content' },
        { value: 'poem', label: 'Poem' },
        { value: 'quote', label: 'Quote' },
        { value: 'explanation', label: 'Explanation' },
        { value: 'story', label: 'Short Story' },
        { value: 'code', label: 'Code Example' }
    ];

    const diagramTypes = [
        { value: 'flowchart', label: 'Flowchart' },
        { value: 'tree', label: 'Tree Diagram' },
        { value: 'network', label: 'Network Diagram' },
        { value: 'sequence', label: 'Sequence Diagram' },
        { value: 'mindmap', label: 'Mind Map' }
    ];

    const handlePaneResizeStart = (event: { clientX: number; preventDefault: () => void }): void => {
        if (!isWideEditorLayout || !splitPaneRef.current) return;
        event.preventDefault();
        setIsPaneResizing(true);

        const containerRect = splitPaneRef.current.getBoundingClientRect();

        const handleMouseMove = (moveEvent: MouseEvent): void => {
            const relativeX = moveEvent.clientX - containerRect.left;
            const rawPercent = (relativeX / containerRect.width) * 100;
            const boundedPercent = Math.max(MIN_PANE_WIDTH_PERCENT, Math.min(MAX_PANE_WIDTH_PERCENT, rawPercent));
            setLeftPaneWidthPercent(boundedPercent);
        };

        const handleMouseUp = (): void => {
            setIsPaneResizing(false);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const fontSizes = [
        { value: '12px', label: '12' },
        { value: '14px', label: '14' },
        { value: '16px', label: '16' },
        { value: '18px', label: '18' },
        { value: '20px', label: '20' },
        { value: '24px', label: '24' },
        { value: '32px', label: '32' }
    ];

    const colors = [
        { name: 'Black', value: 'black' },
        { name: 'Red', value: '#EF4444' },
        { name: 'Green', value: '#10B981' },
        { name: 'Blue', value: '#3B82F6' },
        { name: 'Yellow', value: '#F59E0B' },
        { name: 'Purple', value: '#8B5CF6' },
        { name: 'Pink', value: '#EC4899' },
        { name: 'Accent', value: '#EFC69B' },
        { name: 'Orange', value: '#F97316' },
        { name: 'Indigo', value: '#6366F1' },
        { name: 'Teal', value: '#14B8A6' },
        { name: 'Gray', value: '#6B7280' },
        { name: 'Dark Gray', value: '#4B5563' },
        { name: 'Light Gray', value: '#9CA3AF' },
        { name: 'White', value: 'white' }
    ];

    const sampleTexts = [
        `# AI-Powered Writing Sample

This is a sample document that demonstrates the capabilities of our AI-powered text editor with \\textcolor{blue}{LaTeX formatting support}.

## Features Showcase

### Advanced Mathematics Support
The editor supports complex inline math like Euler's identity $e^{i\\pi} + 1 = 0$, probability distributions $P(X = k) = \\frac{\\lambda^k e^{-\\lambda}}{k!}$, and derivatives $\\frac{d}{dx}[x^n] = nx^{n-1}$.

#### Complex Block Equations
Schrödinger equation:
$$i\\hbar\\frac{\\partial}{\\partial t}\\Psi(\\mathbf{r},t) = \\hat{H}\\Psi(\\mathbf{r},t)$$

Maxwell's equations:
$$\\begin{cases}
\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\epsilon_0} \\\\
\\nabla \\cdot \\mathbf{B} = 0 \\\\
\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\
\\nabla \\times \\mathbf{B} = \\mu_0\\mathbf{J} + \\mu_0\\epsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}
\\end{cases}$$

#### Matrix Operations
Eigenvalue equation:
$$\\mathbf{A}\\mathbf{v} = \\lambda\\mathbf{v}$$

Where $\\mathbf{A}$ is a matrix, $\\mathbf{v}$ is the eigenvector, and $\\lambda$ is the eigenvalue.

### Rich Formatting
- **Bold text** for emphasis
- *Italic text* for style
- \`inline code\` for technical terms
- [Scientific Links](https://arxiv.org) for references
- \\textcolor{red}{Colored text} using LaTeX commands
- {\\large Large text} with LaTeX sizing
- {\\small Small text} example
- {\\Large Extra large text} example

### Advanced Tables and Lists

#### Comprehensive Data Table
| Property | Symbol | Value | Unit | Uncertainty |
|----------|:------:|:-----:|:----:|:-----------:|
| Speed of Light | $c$ | $2.998 \\times 10^8$ | m/s | exact |
| Planck Constant | $h$ | $6.626 \\times 10^{-34}$ | J⋅s | $\\pm 0.000 \\times 10^{-34}$ |
| Electron Mass | $m_e$ | $9.109 \\times 10^{-31}$ | kg | $\\pm 0.000 \\times 10^{-31}$ |
| Avogadro Number | $N_A$ | $6.022 \\times 10^{23}$ | mol⁻¹ | $\\pm 0.000 \\times 10^{23}$ |

#### Statistical Analysis
| Distribution | PDF | Mean | Variance |
|-------------|-----|:----:|:--------:|
| Normal | $\\frac{1}{\\sqrt{2\\pi\\sigma^2}}e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}$ | $\\mu$ | $\\sigma^2$ |
| Exponential | $\\lambda e^{-\\lambda x}$ | $\\frac{1}{\\lambda}$ | $\\frac{1}{\\lambda^2}$ |
| Poisson | $\\frac{\\lambda^k e^{-\\lambda}}{k!}$ | $\\lambda$ | $\\lambda$ |

1. First item in ordered list
2. Second item with **bold** text and $\\alpha = 0.05$
3. Third item with \\textcolor{green}{colored text} and inline math $\\beta = 0.80$

### Code Blocks
\`\`\`python
import numpy as np
import matplotlib.pyplot as plt

def gaussian(x, mu, sigma):
    return (1/np.sqrt(2*np.pi*sigma**2)) * np.exp(-0.5*((x-mu)/sigma)**2)

x = np.linspace(-5, 5, 1000)
y = gaussian(x, 0, 1)
plt.plot(x, y, label='Standard Normal')
plt.legend()
plt.show()
\`\`\`

This editor combines the simplicity of markdown with {\\Large LaTeX formatting} for PDF export!

Test size formatting: {\\tiny tiny}, {\\small small}, {\\large large}, {\\Large Large}`,

        `# Research Paper Draft: Advanced Mathematical Analysis in AI Text Processing

## Abstract
This document explores the integration of artificial intelligence in modern text editing workflows, examining both the technical implementation and user experience considerations through comprehensive mathematical modeling and statistical analysis.

## Introduction
The evolution of text editors has been marked by increasing sophistication in both functionality and user interface design. Recent advances in AI technology present new opportunities for enhancing the writing process using machine learning algorithms with probability distributions $P(\\text{improvement}|\\text{AI}) > 0.85$.

### Key Research Questions
1. How can AI improve writing quality without disrupting workflow?
2. What are the optimal patterns for real-time text analysis with complexity $O(n \\log n)$?
3. How do users respond to AI-powered suggestions with confidence intervals $\\mu \\pm 1.96\\sigma$?

## Methodology
Our approach combines quantitative analysis with qualitative user feedback to evaluate the effectiveness of AI-enhanced editing tools using Bayesian inference:

$$P(\\text{effectiveness}|\\text{data}) = \\frac{P(\\text{data}|\\text{effectiveness}) \\cdot P(\\text{effectiveness})}{P(\\text{data})}$$

### Data Collection & Analysis

#### Experimental Design
| Metric | Baseline | AI-Enhanced | Improvement | p-value |
|--------|:--------:|:-----------:|:-----------:|:-------:|
| WPM | $45.2 \\pm 3.1$ | $62.8 \\pm 4.2$ | $38.9\\%$ | $< 0.001$ |
| Error Rate | $2.3\\%$ | $0.8\\%$ | $65.2\\%$ | $< 0.001$ |
| User Satisfaction | $7.2/10$ | $8.9/10$ | $23.6\\%$ | $< 0.01$ |

#### Statistical Methods
- **Hypothesis Testing**: Using t-tests for mean comparisons
- **Regression Analysis**: $y = \\beta_0 + \\beta_1 x_1 + \\beta_2 x_2 + \\epsilon$
- **ANOVA**: $F = \\frac{\\text{MS}_\\text{between}}{\\text{MS}_\\text{within}}$

### Advanced Mathematical Framework

#### Core Algorithm
The system uses a multi-layered scoring approach:

$$\\text{Score} = \\sum_{i=1}^{n} w_i \\cdot f_i(\\text{input})$$

Where the feature functions include:
- **Grammar Score**: $G(s) = \\frac{1}{1 + e^{-\\alpha(c - \\theta)}}$
- **Style Score**: $S(s) = \\int_0^1 \\text{style}(t) \\, dt$
- **Clarity Score**: $C(s) = -\\sum_{i} p_i \\log p_i$ (entropy measure)

#### Neural Network Architecture
The underlying model uses a transformer architecture with attention weights:

$$\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$

#### Optimization Function
Loss minimization using gradient descent:
$$\\theta_{t+1} = \\theta_t - \\eta \\nabla_\\theta L(\\theta_t)$$

Where $L(\\theta) = \\frac{1}{m} \\sum_{i=1}^{m} \\ell(h_\\theta(x^{(i)}), y^{(i)})$

### Results & Analysis

#### Performance Metrics
| Algorithm | Precision | Recall | F1-Score | AUC-ROC |
|-----------|:---------:|:------:|:--------:|:-------:|
| Baseline | $0.742$ | $0.681$ | $0.710$ | $0.756$ |
| Enhanced | $0.891$ | $0.847$ | $0.868$ | $0.923$ |
| Deep Learning | $0.934$ | $0.912$ | $0.923$ | $0.967$ |

#### Convergence Analysis
The learning curve follows:
$$\\text{Error}(t) = \\epsilon_0 \\cdot e^{-\\lambda t} + \\epsilon_\\infty$$

Where $\\lambda = 0.03$ per epoch and $\\epsilon_\\infty = 0.001$.

## Conclusion
AI-powered text editing represents a significant advancement in writing technology, offering measurable improvements in both efficiency and quality. The mathematical framework demonstrates convergence to optimal solutions with probability $P(\\text{convergence}) \\geq 0.99$ under standard conditions.

### Future Work
- Extension to multi-modal inputs using $\\mathbf{x} = [\\mathbf{x}_\\text{text}, \\mathbf{x}_\\text{image}]^T$
- Real-time adaptation with online learning rates $\\eta_t = \\frac{\\eta_0}{\\sqrt{t}}$
        - Cross-lingual capabilities using shared embedding spaces`,

        `# Mathematical Formulas & Tables Showcase

This document demonstrates comprehensive mathematical notation and advanced table formatting capabilities.

## Inline Mathematical Expressions

Common mathematical expressions in text: The area of a circle with radius $r$ is $A = \\pi r^2$, while the volume of a sphere is $V = \\frac{4}{3}\\pi r^3$. The derivative of $\\sin(x)$ is $\\cos(x)$, and the integral $\\int_0^{\\pi} \\sin(x) dx = 2$. 

Statistical measures include the sample mean $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$ and standard deviation $s = \\sqrt{\\frac{1}{n-1}\\sum_{i=1}^{n}(x_i - \\bar{x})^2}$.

## Block Mathematical Formulas

### Calculus & Analysis

#### Fundamental Theorem of Calculus
$$\\int_a^b f'(x) dx = f(b) - f(a)$$

#### Integration by Parts
$$\\int u \\, dv = uv - \\int v \\, du$$

#### Chain Rule
$$\\frac{d}{dx}[f(g(x))] = f'(g(x)) \\cdot g'(x)$$

#### Taylor Series
$$f(x) = \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!}(x-a)^n$$

### Linear Algebra

#### Matrix Determinant (2×2)
$$\\det\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} = ad - bc$$

#### Matrix Inverse (2×2)
$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}^{-1} = \\frac{1}{ad-bc}\\begin{pmatrix} d & -b \\\\ -c & a \\end{pmatrix}$$

#### Eigenvalue Problem
$$\\det(\\mathbf{A} - \\lambda\\mathbf{I}) = 0$$

### Probability & Statistics

#### Bayes' Theorem
$$P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)}$$

#### Central Limit Theorem
$$\\frac{\\bar{X} - \\mu}{\\sigma/\\sqrt{n}} \\xrightarrow{d} N(0,1)$$

#### Confidence Interval
$$\\bar{x} \\pm t_{\\alpha/2, n-1} \\cdot \\frac{s}{\\sqrt{n}}$$

## Multi-line Equation Systems

### System of Linear Equations
$$\\begin{cases}
a_{11}x_1 + a_{12}x_2 + \\cdots + a_{1n}x_n = b_1 \\\\
a_{21}x_1 + a_{22}x_2 + \\cdots + a_{2n}x_n = b_2 \\\\
\\vdots \\\\
a_{m1}x_1 + a_{m2}x_2 + \\cdots + a_{mn}x_n = b_m
\\end{cases}$$

### Piecewise Functions
$$f(x) = \\begin{cases}
x^2 & \\text{if } x \\geq 0 \\\\
-x^2 & \\text{if } x < 0
\\end{cases}$$

### Aligned Equations
$$\\begin{align}
\\frac{d}{dx}[x^n] &= nx^{n-1} \\\\
\\frac{d}{dx}[e^x] &= e^x \\\\
\\frac{d}{dx}[\\ln(x)] &= \\frac{1}{x} \\\\
\\frac{d}{dx}[\\sin(x)] &= \\cos(x)
\\end{align}$$

## Advanced Table Examples

### Mathematical Constants
| Constant | Symbol | Value | Decimal Approximation |
|----------|:------:|:-----:|:---------------------:|
| Pi | $\\pi$ | $\\frac{22}{7}$ (approx) | $3.141592653589793...$ |
| Euler's Number | $e$ | $\\lim_{n \\to \\infty}(1 + \\frac{1}{n})^n$ | $2.718281828459045...$ |
| Golden Ratio | $\\phi$ | $\\frac{1+\\sqrt{5}}{2}$ | $1.618033988749895...$ |
| Euler-Mascheroni | $\\gamma$ | $\\lim_{n \\to \\infty}(\\sum_{k=1}^{n} \\frac{1}{k} - \\ln(n))$ | $0.577215664901532...$ |

### Trigonometric Functions
| Function | Domain | Range | Period | Derivative |
|----------|:------:|:-----:|:------:|:----------:|
| $\\sin(x)$ | $\\mathbb{R}$ | $[-1, 1]$ | $2\\pi$ | $\\cos(x)$ |
| $\\cos(x)$ | $\\mathbb{R}$ | $[-1, 1]$ | $2\\pi$ | $-\\sin(x)$ |
| $\\tan(x)$ | $\\mathbb{R} \\setminus \\{\\frac{\\pi}{2} + k\\pi\\}$ | $\\mathbb{R}$ | $\\pi$ | $\\sec^2(x)$ |
| $\\cot(x)$ | $\\mathbb{R} \\setminus \\{k\\pi\\}$ | $\\mathbb{R}$ | $\\pi$ | $-\\csc^2(x)$ |

### Statistical Distributions
| Distribution | Parameters | PMF/PDF | Mean | Variance |
|-------------|:----------:|:-------:|:----:|:--------:|
| Binomial | $n, p$ | $\\binom{n}{k}p^k(1-p)^{n-k}$ | $np$ | $np(1-p)$ |
| Poisson | $\\lambda$ | $\\frac{\\lambda^k e^{-\\lambda}}{k!}$ | $\\lambda$ | $\\lambda$ |
| Normal | $\\mu, \\sigma^2$ | $\\frac{1}{\\sqrt{2\\pi\\sigma^2}}e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}$ | $\\mu$ | $\\sigma^2$ |
| Exponential | $\\lambda$ | $\\lambda e^{-\\lambda x}$ | $\\frac{1}{\\lambda}$ | $\\frac{1}{\\lambda^2}$ |

### Complex Numbers Operations
| Operation | Formula | Example |
|-----------|:-------:|:-------:|
| Addition | $(a + bi) + (c + di) = (a + c) + (b + d)i$ | $(3 + 2i) + (1 + 4i) = 4 + 6i$ |
| Multiplication | $(a + bi)(c + di) = (ac - bd) + (ad + bc)i$ | $(3 + 2i)(1 + 4i) = -5 + 14i$ |
| Modulus | $|a + bi| = \\sqrt{a^2 + b^2}$ | $|3 + 4i| = 5$ |
| Argument | $\\arg(a + bi) = \\arctan(\\frac{b}{a})$ | $\\arg(1 + i) = \\frac{\\pi}{4}$ |

### Calculus Rules Summary
| Rule | Function | Derivative |
|------|:--------:|:----------:|
| Power Rule | $x^n$ | $nx^{n-1}$ |
| Product Rule | $f(x)g(x)$ | $f'(x)g(x) + f(x)g'(x)$ |
| Quotient Rule | $\\frac{f(x)}{g(x)}$ | $\\frac{f'(x)g(x) - f(x)g'(x)}{[g(x)]^2}$ |
| Chain Rule | $f(g(x))$ | $f'(g(x)) \\cdot g'(x)$ |

This comprehensive example demonstrates the editor's capability to handle complex mathematical notation and sophisticated table formatting for academic and technical documentation.`
    ];

    useEffect(() => {
        abortController.current = new AbortController();
        isMounted.current = true;

        return () => {
            isMounted.current = false;
            if (abortController.current) {
                abortController.current.abort();
            }
        };
    }, []);

    const safeRemoveEventListener = (element: HTMLElement | Document, event: string, handler: EventListener) => {
        if (!isMounted.current) return;

        try {
            if (element && typeof element.removeEventListener === 'function') {
                element.removeEventListener(event, handler);
            }
        } catch (error) {
            console.warn('Safe cleanup: Event listener removal failed', error);
        }
    };

    useEffect(() => {
        const handleClickOutside = (e: Event) => {
            if (!isMounted.current) return;

            const target = e.target as Element;
            if (!target.closest('[data-dropdown]') && !target.closest('[data-selection-menu]') &&
                !target.closest('[data-ai-dialog]') && !target.closest('[data-diagram-dialog]') &&
                !target.closest('[data-prompt-dialog]')) {
                setShowColorPicker(false);
                setShowFontSize(false);

                setShowSelectionMenu(false);
                setShowAIDialog(false);
                setShowDiagramDialog(false);
            }
        };

        const controller = abortController.current;
        if (controller && !controller.signal.aborted) {
            document.addEventListener('mousedown', handleClickOutside, {
                signal: controller.signal
            });
        }

        return () => {
            if (controller && !controller.signal.aborted) {
                safeRemoveEventListener(document, 'mousedown', handleClickOutside);
            }
        };
    }, []);

    useEffect(() => {
        setInsertTextRef(insertText);
        setSaveToHistoryRef(saveToHistory);
        setGetContentRef(() => {
            const stepId = activeStepIdRef.current;
            return stepId !== null ? (stepContentsRef.current[stepId] ?? '') : content;
        });
        setClearContentRef(() => {
            const stepId = activeStepIdRef.current;
            if (stepId !== null) {
                setStepContentRef.current(stepId, '');
            } else {
                setContent('');
            }
        });
    }, [setInsertTextRef, setSaveToHistoryRef, setGetContentRef, setClearContentRef, content]);

    useEffect(() => {
        const handlePageAction = (e: Event) => {
            const detail = (e as CustomEvent<{ pageAction: string }>).detail;
            if (detail?.pageAction === 'clear_editor') {
                const stepId = activeStepIdRef.current;
                if (stepId !== null) {
                    setStepContentRef.current(stepId, '');
                } else {
                    setContent('');
                }
                resetDocument();
                window.dispatchEvent(
                    new CustomEvent('alma:page-action-result', { detail: { ok: true, message: 'Editor cleared.' } })
                );
            }
        };
        window.addEventListener('alma:page-action', handlePageAction);
        return () => window.removeEventListener('alma:page-action', handlePageAction);
    }, [resetDocument]);

    const openSelectionMenu = (mode: 'ai' | 'format', menuHeight: number) => {
        setSelectionMenuMode(mode);
        try {
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const menuWidth = mode === 'format' ? 160 : 120;
            const x = (viewportWidth / 2) - (menuWidth / 2);
            const y = (viewportHeight / 2) - (menuHeight / 2);
            setSelectionMenuPosition({ x, y });
            setShowSelectionMenu(true);
        } catch (error) {
            console.warn('Menu center positioning failed:', error);
            setShowSelectionMenu(false);
        }
    };

    const handleTextSelection = () => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value.substring(start, end);

        if (text.length > 0) {
            setSelectedText(text);
            selectionRangeRef.current = { start, end };
            openSelectionMenu('ai', 120);
        } else {
            setShowSelectionMenu(false);
            selectionRangeRef.current = null;
        }
    };

    const applyQuickFormat = (type: string) => {
        formatText(type);
        setShowSelectionMenu(false);
    };

    const [draggedStepIndex, setDraggedStepIndex] = useState<number | null>(null);
    const [dragOverStepIndex, setDragOverStepIndex] = useState<number | null>(null);

    const handleStepDragStart = (e: React.DragEvent, index: number) => {
        setDraggedStepIndex(index);
        e.dataTransfer.setData('text/plain', String(index));
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleStepDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverStepIndex(index);
    };

    const handleStepDragLeave = () => {
        setDragOverStepIndex(null);
    };

    const handleStepDrop = (e: React.DragEvent, toIndex: number) => {
        e.preventDefault();
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (fromIndex === toIndex || isNaN(fromIndex)) {
            setDraggedStepIndex(null);
            setDragOverStepIndex(null);
            return;
        }
        const reordered = [...agentSteps];
        const [removed] = reordered.splice(fromIndex, 1);
        reordered.splice(toIndex, 0, removed);
        const withUpdatedIndices = reordered.map((step, i) => ({ ...step, index: i }));
        const preserveActiveId = activeStepId;
        setAgentSteps(withUpdatedIndices);
        if (preserveActiveId) setActiveStepId(preserveActiveId);
        setDraggedStepIndex(null);
        setDragOverStepIndex(null);
    };

    const handleStepDragEnd = () => {
        setDraggedStepIndex(null);
        setDragOverStepIndex(null);
    };

    const computeMergedStepsContent = (): string =>
        agentSteps
            .map((step) => {
                const stepContent = stepContents[step.id] ?? '';
                const header = `## ${step.name}\n\n`;
                return stepContent.trim() ? header + stepContent.trim() : header + '*Empty*\n';
            })
            .join('\n\n');

    const handleOpenExport = () => {
        setExportStep(1);
        setExportFormat('tex');
        setExportDestination('computer');
        setShowExportModal(true);
        initializeProjectContext();
    };

    const handleExportExecute = async (destination?: 'computer' | 'drive' | 'gdoc', folderId?: string) => {
        if (!content.trim()) {
            alert('No content to export.');
            return;
        }
        const dest = destination ?? exportDestination;
        const baseName = `Merged_Document_${new Date().toISOString().split('T')[0]}`;
        const ext = exportFormat === 'pdf' ? '.pdf' : '.tex';
        const fileName = baseName + ext;

        if (dest === 'computer') {
            if (exportFormat === 'tex') {
                const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(url);
                setShowExportModal(false);
                setExportStep(1);
            } else {
                try {
                    const { jsPDF } = await import('jspdf');
                    const plainText = preprocessLatexFormatting(content)
                        .replace(/<[^>]*>/g, '')
                        .replace(/&nbsp;/g, ' ')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&');
                    const doc = new jsPDF();
                    const pageW = doc.internal.pageSize.getWidth() - 40;
                    const lineHeight = 7;
                    const lines = doc.splitTextToSize(plainText, pageW);
                    let y = 20;
                    for (let i = 0; i < lines.length; i++) {
                        if (y > doc.internal.pageSize.getHeight() - 20) {
                            doc.addPage();
                            y = 20;
                        }
                        doc.text(lines[i], 20, y);
                        y += lineHeight;
                    }
                    doc.save(fileName);
                } catch (err) {
                    console.error('PDF export failed:', err);
                    alert(`PDF export failed: ${err instanceof Error ? err.message : 'Unknown error'}. Try exporting as .tex instead.`);
                }
                setShowExportModal(false);
                setExportStep(1);
            }
            return;
        }

        if (dest === 'gdoc') {
            try {
                const response = await fetch('/api/docs/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: baseName, content }),
                    credentials: 'include',
                });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.error || 'Failed to create Google Doc');
                }
                const { document: doc } = await response.json();
                window.open(doc.webViewLink, '_blank');
                setShowExportModal(false);
                setExportStep(1);
            } catch (e) {
                alert(`Failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
            return;
        }

        if (dest === 'drive' && folderId) {
            try {
                const mimeType = exportFormat === 'tex' ? 'text/plain' : 'application/x-tex';
                const response = await fetch('/api/canvas/export-to-drive', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderId, content, fileName, mimeType }),
                    credentials: 'include',
                });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.error || 'Failed to export to Drive');
                }
                alert('File saved to Google Drive successfully.');
                setShowExportModal(false);
                setExportStep(1);
            } catch (e) {
                alert(`Failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
        }
    };

    const handleMergeAllSteps = () => {
        setContent(computeMergedStepsContent());
        setActiveStepId(null);
        setActiveSection(null);
        setIsMergedStepsView(true);
    };

    useEffect(() => {
        if (isMergedStepsView && agentSteps.length > 0) {
            setContent(
                agentSteps
                    .map((step) => {
                        const stepContent = stepContents[step.id] ?? '';
                        const header = `## ${step.name}\n\n`;
                        return stepContent.trim() ? header + stepContent.trim() : header + '*Empty*\n';
                    })
                    .join('\n\n')
            );
        }
    }, [isMergedStepsView, agentSteps, stepContents]);

    const handleGrammarCheck = () => {
        setCurrentAction('grammar');
        setSystemPrompt(`Please correct any grammar, spelling, and punctuation errors in the following text while maintaining its original meaning and tone: "${selectedText}"`);
        setPromptText('');
        setShowPromptDialog(true);
    };

    const handleAlternatives = () => {
        setCurrentAction('alternatives');
        setSystemPrompt(`Please provide 3-5 alternative ways to rephrase the following text while maintaining the same meaning: "${selectedText}"`);
        setPromptText('');
        setShowPromptDialog(true);
    };

    const handleCustomPrompt = () => {
        setCurrentAction('custom');
        setSystemPrompt(`Selected text: "${selectedText}"`);
        setPromptText('');
        setCustomPromptFiles([]);
        setShowPromptDialog(true);
    };

    const processCustomPromptFile = (file: File): Promise<FileData> => {
        return new Promise((resolve, reject) => {
            if (file.size > MAX_FILE_SIZE) {
                reject(new Error(`File ${file.name} is too large. Maximum size is 10MB.`));
                return;
            }

            if (!Object.keys(SUPPORTED_FILE_TYPES).includes(file.type)) {
                reject(new Error(`File type ${file.type} is not supported.`));
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const fileData: FileData = {
                    id: Math.random().toString(36).substr(2, 9),
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    content: e.target?.result || '',
                    uploadDate: new Date(),
                    originalFile: file
                };

                if (file.type.startsWith('image/')) {
                    fileData.preview = e.target?.result as string;
                }

                resolve(fileData);
            };
            reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));

            if (file.type.startsWith('image/') || file.type === 'application/pdf') {
                reader.readAsDataURL(file);
            } else {
                reader.readAsText(file);
            }
        });
    };

    const handleCustomPromptFileUpload = async (files: FileList) => {
        const newFiles: FileData[] = [];

        for (let i = 0; i < files.length; i++) {
            try {
                const processedFile = await processCustomPromptFile(files[i]);
                newFiles.push(processedFile);
            } catch (error) {
                alert(`Error processing file: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }

        setCustomPromptFiles(prev => [...prev, ...newFiles]);
    };

    const removeCustomPromptFile = (fileId: string) => {
        setCustomPromptFiles(prev => prev.filter(f => f.id !== fileId));
    };

    const executeAIPrompt = async () => {
        if (!selectedText.trim()) return;

        setIsProcessingCustomPrompt(true);

        try {
            let finalPrompt = '';

            switch (currentAction) {
                case 'grammar':
                    finalPrompt = systemPrompt;
                    break;
                case 'alternatives':
                    finalPrompt = systemPrompt;
                    break;
                case 'custom':
                    finalPrompt = promptText ? `${promptText}\n\nContext text: "${selectedText}"` : systemPrompt;
                    break;
                default:
                    return;
            }

            const messages = [{ role: 'user' as const, text: finalPrompt }];
            let response;

            if (currentAction === 'custom' && customPromptFiles.length > 0) {
                const formData = new FormData();

                formData.append('messages', JSON.stringify(messages));
                formData.append('model', DEFAULT_MODEL);

                customPromptFiles.forEach((fileData, index) => {
                    formData.append(`file_${index}`, fileData.originalFile);
                });
                
                if (projectFolder?.projectId) {
                    formData.append('projectId', projectFolder.projectId);
                    console.log('📁 [MainEditor] Adding current project ID to request:', projectFolder.projectId);
                } else {
                    console.warn('⚠️ [MainEditor] No current project ID available for RAG processing');
                }

                console.log('🚀 [CustomPrompt] Sending multipart request with', customPromptFiles.length, 'files');

                response = await fetch('/api/gemini', {
                    method: 'POST',
                    body: formData,
                });
            } else {
                response = await fetch('/api/gemini', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        messages,
                        model: DEFAULT_MODEL
                    }),
                });
            }

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to process text');
            }

            const textarea = textareaRef.current;
            if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const newContent = content.substring(0, start) + data.response + content.substring(end);
                setContent(newContent);

                saveToHistory(newContent);

                setTimeout(() => {
                    textarea.focus();
                    textarea.setSelectionRange(start + data.response.length, start + data.response.length);
                }, 0);
            }

        } catch (error) {
            console.error('Error processing text:', error);
            alert(`Error: ${error instanceof Error ? error.message : 'Failed to process text'}`);
        } finally {
            setIsProcessingCustomPrompt(false);
        }
    };

    const saveToHistory = (newContent: string) => {
        setContentHistory(prev => {
            const newHistory = [...prev];
            if (historyIndex < newHistory.length - 1) {
                newHistory.splice(historyIndex + 1);
            }
            newHistory.push(newContent);
            if (newHistory.length > 5) {
                newHistory.shift();
            }
            return newHistory;
        });
        setHistoryIndex(prev => Math.min(prev + 1, 4));
    };

    const handleUndo = () => {
        if (historyIndex > 0) {
            setHistoryIndex(prev => prev - 1);
            setContent(contentHistory[historyIndex - 1]);
        }
    };

    const handleRedo = () => {
        if (historyIndex < contentHistory.length - 1) {
            setHistoryIndex(prev => prev + 1);
            setContent(contentHistory[historyIndex + 1]);
        }
    };

    const handleAIPrompt = async () => {
        try {
            saveToHistory(content);

            const loadingText = `\n[Generating ${aiContentType} content...]\n\n`;
            const textarea = textareaRef.current;
            let start = 0, end = 0;

            if (textarea) {
                start = textarea.selectionStart;
                end = textarea.selectionEnd;
                const newContent = content.substring(0, start) + loadingText + content.substring(end);
                setContent(newContent);
            }

            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', text: aiPromptText }],
                    model: DEFAULT_MODEL
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to generate content');
            }

            const aiResponse = `\n${data.response}\n\n`;

            if (textarea) {
                const newContent = content.substring(0, start) + aiResponse + content.substring(end);
                setContent(newContent);

                setTimeout(() => {
                    textarea.focus();
                    textarea.setSelectionRange(start + aiResponse.length, start + aiResponse.length);
                }, 0);
            }

        } catch (error) {
            console.error('Error generating AI content:', error);

            const errorText = `\n[Error: ${error instanceof Error ? error.message : 'Failed to generate content'}]\n\n`;
            const textarea = textareaRef.current;

            if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const newContent = content.substring(0, start) + errorText + content.substring(end);
                setContent(newContent);
            }
        }
    };

    const handleDiagramPrompt = async () => {
        if (!diagramPromptText.trim()) return;

        setIsGeneratingDiagram(true);
        setShowDiagramDialog(false);

        try {
            const diagramPrompt = `Create a detailed ${diagramType} diagram using ASCII art based on the following description: "${diagramPromptText}".

Please generate ONLY the ASCII art diagram without any explanations or additional text. The diagram should be comprehensive, well-structured, and use simple ASCII characters.

Diagram type: ${diagramType}
Description: ${diagramPromptText}

Rules:
1. Use ASCII characters like ┌─┐│└┘├┤┬┴┼ for boxes and connections
2. Use arrows like → ← ↑ ↓ or simple -> <- for directions
3. Make the diagram clear and readable in monospace font
4. For flowcharts, use boxes and diamond shapes for decisions
5. For tree diagrams, use hierarchical branching with | and +
6. For network diagrams, show nodes as [boxes] connected with lines
7. For sequence diagrams, use vertical lines and horizontal arrows
8. Keep the diagram compact but readable
9. Use simple text labels inside or near diagram elements

Generate the ASCII diagram now:`;

            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', text: diagramPrompt }],
                    model: DEFAULT_MODEL
                }),
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error('Failed to generate diagram');
            }

            const result = await response.json();
            const aiDiagramCode = result.response;

            let cleanedCode = aiDiagramCode.replace(/```/g, '').trim();

            if (!cleanedCode || cleanedCode.length < 10) {
                const fallbackTemplates = {
                    flowchart: `┌─────────────┐
│   ${diagramPromptText}   │
└─────┬───────┘
      │
      ▼
┌─────────────┐
│   Process   │
└─────┬───────┘
      │
      ▼
┌─────────────┐
│   Result    │
└─────────────┘`,
                    tree: `${diagramPromptText}
├── Branch 1
│   ├── Leaf 1
│   └── Leaf 2
└── Branch 2
    ├── Leaf 3
    └── Leaf 4`,
                    network: `[Node A] ──── [Node B]
    │             │
    │             │
[${diagramPromptText}] ──── [Node D]`,
                    sequence: `A          B
│          │
│ Request  │
├─────────→│
│          │
│ Response │
│←─────────┤
│          │`,
                    mindmap: `      ${diagramPromptText}
         ┌─────┴─────┐
         │           │
     Idea 1      Idea 2
         │           │
    ┌────┴────┐ ┌────┴────┐
Sub-idea 1 Sub-idea 2 Sub-idea 3`
                };
                cleanedCode = fallbackTemplates[diagramType as keyof typeof fallbackTemplates] || cleanedCode;
            }

            const diagramBlock = `\n\`\`\`\n${cleanedCode}\n\`\`\`\n\n`;

            saveToHistory(content);

            const textarea = textareaRef.current;
            if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const newContent = content.substring(0, start) + diagramBlock + content.substring(end);
                setContent(newContent);

                setTimeout(() => {
                    textarea.focus();
                    textarea.setSelectionRange(start + diagramBlock.length, start + diagramBlock.length);
                }, 0);
            }

            setDiagramPromptText('');
            setDiagramType('flowchart');

        } catch (error) {
            console.error('Error generating diagram:', error);

            alert('Failed to generate diagram. Please try again.');

            const fallbackTemplates = {
                flowchart: `graph TD\n    A[${diagramPromptText}] --> B[Process]\n    B --> C[Result]`,
                tree: `graph TD\n    Root[${diagramPromptText}]\n    Root --> A[Branch 1]\n    Root --> B[Branch 2]`,
                network: `graph LR\n    A[Node A] --> B[Node B]\n    A --> C[${diagramPromptText}]`,
                sequence: `sequenceDiagram\n    participant A\n    participant B\n    A->>B: ${diagramPromptText}\n    B->>A: Response`,
                mindmap: `graph TD\n    Center[${diagramPromptText}]\n    Center --> A[Idea 1]\n    Center --> B[Idea 2]`
            };

            const fallbackCode = fallbackTemplates[diagramType as keyof typeof fallbackTemplates];
            const fallbackBlock = `\n\`\`\`mermaid\n${fallbackCode}\n\`\`\`\n\n`;

            saveToHistory(content);

            const textarea = textareaRef.current;
            if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const newContent = content.substring(0, start) + fallbackBlock + content.substring(end);
                setContent(newContent);

                setTimeout(() => {
                    textarea.focus();
                    textarea.setSelectionRange(start + fallbackBlock.length, start + fallbackBlock.length);
                }, 0);
            }
        } finally {
            setIsGeneratingDiagram(false);
        }
    };

    const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newContent = e.target.value;
        const currentStepId = activeStepIdRef.current;

        if (currentStepId !== null) {
            setStepContentRef.current(currentStepId, newContent);
        } else {
            setContent(newContent);
            const shouldSave = Math.abs(newContent.length - content.length) >= 10;
            if (shouldSave) {
                saveToHistory(content);
            }
        }
    };

    const insertText = (text: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const filteredText = filterAIResponseSections(text);

        const currentStepId = activeStepIdRef.current;
        const baseContent = currentStepId !== null
            ? (stepContentsRef.current[currentStepId] ?? '')
            : content;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent = baseContent.substring(0, start) + filteredText + baseContent.substring(end);

        if (currentStepId !== null) {
            setStepContentRef.current(currentStepId, newContent);
        } else {
            setContent(newContent);
        }

        setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(start + filteredText.length, start + filteredText.length);
        }, 0);
    };

    const insertMath = () => {
        insertText('$E = mc^2$');
    };

    const insertBlockMath = () => {
        insertText('\n$$\n\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}\n$$\n');
    };

    const insertTable = () => {
        const table = '\n| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n| Cell 1   | Cell 2   | Cell 3   |\n| Cell 4   | Cell 5   | Cell 6   |\n';
        insertText(table);
    };

    const formatText = (format: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const currentStepId = activeStepIdRef.current;
        const baseContent = currentStepId !== null
            ? (stepContentsRef.current[currentStepId] ?? '')
            : content;

        let start = textarea.selectionStart;
        let end = textarea.selectionEnd;
        if (start === end && selectionRangeRef.current) {
            start = selectionRangeRef.current.start;
            end = selectionRangeRef.current.end;
            selectionRangeRef.current = null;
        }
        const selectedText = baseContent.substring(start, end);

        let formattedText = '';

        switch (format) {
            case 'bold':
                formattedText = selectedText ? `**${selectedText}**` : '**bold text**';
                break;
            case 'italic':
                formattedText = selectedText ? `*${selectedText}*` : '*italic text*';
                break;
            case 'underline':
                formattedText = selectedText ? `<u>${selectedText}</u>` : '<u>underlined text</u>';
                break;
            case 'strikethrough':
                formattedText = selectedText ? `~~${selectedText}~~` : '~~strikethrough text~~';
                break;
            case 'code':
                formattedText = selectedText ? `\`${selectedText}\`` : '`code`';
                break;
            case 'blockquote':
                formattedText = selectedText ? `> ${selectedText}` : '> Quote text';
                break;
            case 'bulletList':
                formattedText = selectedText ? `- ${selectedText}` : '- List item';
                break;
            case 'numberedList':
                formattedText = selectedText ? `1. ${selectedText}` : '1. List item';
                break;
            case 'h1':
                formattedText = selectedText ? `# ${selectedText}` : '# Heading 1';
                break;
            case 'h2':
                formattedText = selectedText ? `## ${selectedText}` : '## Heading 2';
                break;
            case 'h3':
                formattedText = selectedText ? `### ${selectedText}` : '### Heading 3';
                break;
            default:
                return;
        }

        const newContent = baseContent.substring(0, start) + formattedText + baseContent.substring(end);

        if (currentStepId !== null) {
            setStepContentRef.current(currentStepId, newContent);
        } else {
            setContent(newContent);
        }

        setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(start + formattedText.length, start + formattedText.length);
        }, 0);
    };

    const insertLink = () => {
        if (!linkUrl) return;

        const text = linkText || linkUrl;
        const linkMarkdown = `[${text}](${linkUrl})`;
        insertText(linkMarkdown);

        setShowLinkDialog(false);
        setLinkUrl('');
        setLinkText('');
    };

    const insertImage = () => {
        if (!imageUrl) return;

        const altText = imageAlt || 'Image';
        const imageMarkdown = `![${altText}](${imageUrl})`;
        insertText(imageMarkdown);

        setShowImageDialog(false);
        setImageUrl('');
        setImageAlt('');
    };

    const handleImageUploadFromDialog = async () => {
        if (!fileInputRef.current) return;

        const file = fileInputRef.current.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            alert('Please select an image file.');
            return;
        }

        if (file.size > MAX_FILE_SIZE) {
            alert(`File size must be less than ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
            return;
        }

        try {
            await uploadImageToDrive(file);

            setShowImageDialog(false);
            setImageUrl('');
            setImageAlt('');

            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } catch (error) {
            console.error('Error uploading image from dialog:', error);
        }
    };

    const triggerFilePicker = () => {
        fileInputRef.current?.click();
    };

    const convertClipboardToFile = async (item: DataTransferItem): Promise<File | null> => {
        try {
            const generateFileName = (mimeType: string): string => {
                const extension = mimeType.split('/')[1] || 'png';
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

                if (mimeType === 'image/png' && item.kind === 'file') {
                    return `screenshot-${timestamp}.${extension}`;
                }
                return `pasted-image-${timestamp}.${extension}`;
            };

            if (item.kind === 'string') {
                return new Promise((resolve) => {
                    item.getAsString((data: string) => {
                        if (data.startsWith('data:image/')) {
                            const [header, base64] = data.split(',');
                            const mimeMatch = header.match(/data:([^;]+)/);
                            const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';

                            try {
                                const byteCharacters = atob(base64);
                                const byteNumbers = new Array(byteCharacters.length);
                                for (let i = 0; i < byteCharacters.length; i++) {
                                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                                }
                                const byteArray = new Uint8Array(byteNumbers);
                                const blob = new Blob([byteArray], { type: mimeType });
                                const fileName = generateFileName(mimeType);
                                const file = new File([blob], fileName, { type: mimeType });
                                console.log(`Converted data URL to file: ${fileName} (${mimeType})`);
                                resolve(file);
                            } catch (error) {
                                console.error('Error converting data URL to file:', error);
                                resolve(null);
                            }
                        } else {
                            resolve(null);
                        }
                    });
                });
            }

            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    return file;
                }

                if (item.type.startsWith('image/')) {
                    console.log(`Attempting to process clipboard image data: ${item.type}`);

                    try {
                        const fileName = generateFileName(item.type);
                        console.log(`Generated filename for clipboard image: ${fileName}`);

                        console.warn('Clipboard contains image data but could not convert to File object');
                        return null;
                    } catch (error) {
                        console.error('Error processing clipboard image data:', error);
                        return null;
                    }
                }
            }

            return null;
        } catch (error) {
            console.error('Error converting clipboard item:', error);
            return null;
        }
    };

    const handlePaste = async (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.indexOf('image') !== -1) {
                e.preventDefault();

                let file = item.getAsFile();

                if (!file) {
                    console.log('getAsFile() returned null, trying alternative conversion...');
                    file = await convertClipboardToFile(item);
                }

                if (file) {
                    console.log(`Processing pasted image: ${file.name} (${file.type}, ${file.size} bytes)`);

                    if (file.name.includes('screenshot')) {
                        console.log('📸 Screenshot detected and being uploaded...');
                    } else if (file.name.includes('pasted-image')) {
                        console.log('🖼️ Web image detected and being uploaded...');
                    }

                    await uploadImageToDrive(file);
                } else {
                    console.warn('Could not convert clipboard item to file');
                    alert('Unable to process the copied image. Supported: screenshots (Win+Shift+S, Print Screen), web images (right-click copy), and file uploads.');
                }
                break;
            }
        }
    };

    const uploadImageToDrive = async (file: File) => {
        setIsUploadingImage(true);

        try {
            if (!projectFolder?.projectId) {
                alert('Please select a project first from the Projects page.');
                return;
            }

            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(
                `/api/projects/${projectFolder.projectId}/folders/Images/files`,
                {
                    method: 'POST',
                    body: formData,
                }
            );

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Upload failed');
            }

            const result = await response.json();
            const fileId = result.file_id;

            const driveUrl = `https://drive.google.com/file/d/${fileId}/view`;

            const imageMarkdown = `![${file.name}](${driveUrl})`;
            insertText(imageMarkdown);

            console.log(`✅ Image uploaded successfully: ${file.name} (ID: ${fileId})`);

        } catch (error) {
            console.error('Error uploading image:', error);
            const errorMessage = error instanceof Error ? error.message : 'Failed to upload image';
            alert(`Upload failed: ${errorMessage}`);
        } finally {
            setIsUploadingImage(false);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const files = e.dataTransfer.files;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.type.startsWith('image/')) {
                await uploadImageToDrive(file);
                break;
            }
        }
    };

    const formatTextWithColor = (color: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = content.substring(start, end);

        const coloredText = selectedText
            ? `\\textcolor{${color}}{${selectedText}}`
            : `\\textcolor{${color}}{colored text}`;

        const newContent = content.substring(0, start) + coloredText + content.substring(end);
        setContent(newContent);

        setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(start + coloredText.length, start + coloredText.length);
        }, 0);
    };

    const formatTextWithSize = (size: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = content.substring(start, end);

        const sizeMap: { [key: string]: string } = {
            '12px': 'tiny',
            '14px': 'small',
            '16px': 'normalsize',
            '18px': 'large',
            '20px': 'Large',
            '24px': 'LARGE',
            '32px': 'huge'
        };

        const latexSize = sizeMap[size] || 'normalsize';
        const sizedText = selectedText
            ? `{\\${latexSize} ${selectedText}}`
            : `{\\${latexSize} sized text}`;

        const newContent = content.substring(0, start) + sizedText + content.substring(end);
        setContent(newContent);

        setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(start + sizedText.length, start + sizedText.length);
        }, 0);
    };

    const loadSampleText = () => {
        const randomSample = sampleTexts[Math.floor(Math.random() * sampleTexts.length)];
        setContent(randomSample);
    };

    const copyText = () => {
        navigator.clipboard.writeText(content);
    };

    const preprocessLatexFormatting = (text: string) => {
        return text
            .replace(/\\textcolor\{([^}]+)\}\{([^}]+)\}/g, '<span style="color: $1">$2</span>')
            .replace(/\{\\(tiny|small|normalsize|large|Large|LARGE|huge)\s+([^}]+)\}/g, (match, size, content) => {
                const sizeMap: { [key: string]: string } = {
                    tiny: '0.6em',
                    small: '0.8em',
                    normalsize: '1em',
                    large: '1.2em',
                    Large: '1.4em',
                    LARGE: '1.8em',
                    huge: '2em'
                };
                return `<span style="font-size: ${sizeMap[size] || '1em'}">${content}</span>`;
            });
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if ((e.key === 'Meta' || e.key === 'Control') && textareaRef.current) {
            const start = textareaRef.current.selectionStart;
            const end = textareaRef.current.selectionEnd;
            const text = textareaRef.current.value.substring(start, end);
            if (text.length > 0) {
                setSelectedText(text);
                selectionRangeRef.current = { start, end };
                openSelectionMenu('format', 300);
            }
            return;
        }

        if (e.ctrlKey || e.metaKey) {
            switch (e.key) {
                case 'z':
                    if (e.shiftKey) {
                        e.preventDefault();
                        handleRedo();
                    } else {
                        e.preventDefault();
                        handleUndo();
                    }
                    break;
                case 'y':
                    e.preventDefault();
                    handleRedo();
                    break;
                case 'k':
                    e.preventDefault();
                    setShowLinkDialog(true);
                    break;
                case 'b':
                    e.preventDefault();
                    formatText('bold');
                    break;
                case 'i':
                    e.preventDefault();
                    formatText('italic');
                    break;
                case 'u':
                    e.preventDefault();
                    formatText('underline');
                    break;
            }
        }

        if (e.key === 'Escape' && focusMode !== 'none') {
            e.preventDefault();
            if (focusMode === 'editor') {
                onToggleEditorFocusMode();
            } else {
                onTogglePreviewFocusMode();
            }
        }
    };

    const ToolbarButton = ({ icon: Icon, onClick, title, active = false, children }: {
        icon?: IconComponent;
        onClick: () => void;
        title: string;
        active?: boolean;
        children?: React.ReactNode;
    }) => (
        <button
            onClick={onClick}
            title={title}
            className={`${styles.toolbarButton} ${active
                ? `${styles.toolbarButtonActive} ${theme.accentBg} text-white`
                : `${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`
                }`}
        >
            {Icon ? <Icon className="w-4 h-4" /> : children}
        </button>
    );

    const DropdownButton = ({ icon: Icon, title, isOpen, onClick, children }: {
        icon: IconComponent;
        title: string;
        isOpen: boolean;
        onClick: () => void;
        children: React.ReactNode;
    }) => (
        <div className={styles.dropdownButton} data-dropdown={title.toLowerCase()}>
            <button
                onClick={onClick}
                title={title}
                className={`${styles.toolbarButton} ${isOpen
                    ? `${styles.toolbarButtonActive} ${theme.accentBg} text-white`
                    : `${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`
                    }`}
            >
                <Icon className="w-4 h-4" />
            </button>
            {isOpen && (
                <div className={`${styles.dropdownContent} ${theme.cardBg} ${theme.borderColor}`}>
                    {children}
                </div>
            )}
        </div>
    );

    return (
        <div className={`${styles.mainContainer} ${theme.bg}`}>
            {}
            {focusMode === 'none' && (
                <div className={`${styles.topToolbar} ${theme.cardBg} ${theme.borderColor}`}>
                    <div className={styles.topToolbarContent}>
                        <div className={styles.topToolbarTitle}>
                            <h1 className={`${styles.editorTitle} ${theme.textPrimary}`}>AI Editor</h1>

                            {}
                            {agentSteps.length > 0 && (
                                <div className="flex items-center gap-1 ml-3 min-w-0 flex-1">
                                    <div className="flex items-center gap-1 overflow-x-auto min-w-0">
                                        {agentSteps.map((step, index) => (
                                            <button
                                                key={step.id}
                                                draggable
                                                onDragStart={(e) => handleStepDragStart(e, index)}
                                                onDragOver={(e) => handleStepDragOver(e, index)}
                                                onDragLeave={handleStepDragLeave}
                                                onDrop={(e) => handleStepDrop(e, index)}
                                                onDragEnd={handleStepDragEnd}
                                                onClick={() => {
                                                    setActiveStepId(step.id);
                                                    setIsMergedStepsView(false);
                                                }}
                                                title={`${step.name} (drag to reorder)`}
                                                className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors cursor-grab active:cursor-grabbing shrink-0 ${
                                                    draggedStepIndex === index ? 'opacity-50' : ''
                                                } ${dragOverStepIndex === index ? 'ring-2 ring-white/50 ring-inset' : ''} ${
                                                    !isMergedStepsView && activeStepId === step.id
                                                        ? `${theme.accentBg} text-white font-semibold`
                                                        : `${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`
                                                }`}
                                            >
                                                S{step.index + 1}
                                                {stepContents[step.id] ? ' ✓' : ''}
                                            </button>
                                        ))}
                                        <button
                                            onClick={handleMergeAllSteps}
                                            title="Merge all steps into one document"
                                            className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors shrink-0 ${
                                                isMergedStepsView ? `${theme.accentBg} text-white font-semibold` : `${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`
                                            }`}
                                        >
                                            Merge All
                                        </button>
                                    </div>
                                    {}
                                    {isMergedStepsView && (
                                        <div className={`flex items-center gap-1 shrink-0 ml-1 pl-1 border-l ${theme.borderColor}`}>
                                            <button
                                                onClick={handleOpenExport}
                                                title="Export merged document (PDF or TEX)"
                                                className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                            >
                                                <Download className="w-3 h-3 inline mr-0.5" />
                                                Export
                                            </button>
                                        </div>
                                    )}
                                    {!isMergedStepsView && activeStepId && (
                                        <div className={`flex items-center gap-1 shrink-0 ml-1 pl-1 border-l ${theme.borderColor}`}>
                                            {chainLength > 0 && (
                                                <button
                                                    onClick={() => setShowIntegrityModal(true)}
                                                    title="View cryptographic integrity chain for steps run in this session"
                                                    className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                                >
                                                    Cryptographic Chain ({chainLength})
                                                </button>
                                            )}
                                            <button
                                                onClick={handleQCClick}
                                                title="QC: Validate claims in this step against your RAG corpus"
                                                className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                            >
                                                <CheckSquare className="w-3 h-3 inline mr-0.5" />
                                                QC
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <button
                            onClick={toggleTheme}
                            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                            className={`${styles.themeToggle} p-2 rounded-lg ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover} shrink-0`}
                        >
                            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                        </button>
                    </div>
                </div>
            )}

            {}
            <div className={styles.editorContainer} ref={splitPaneRef}>
                {}
                {focusMode !== 'preview' && (
                    <div
                        className={`${styles.leftPane} ${theme.borderColor}`}
                        style={focusMode === 'editor'
                            ? { flexBasis: '100%', maxWidth: '100%' }
                            : isWideEditorLayout
                                ? { flexBasis: `${leftPaneWidthPercent}%`, maxWidth: `${leftPaneWidthPercent}%` }
                                : undefined}
                    >
                    {}
                    <div className={`${styles.paneHeader} ${theme.cardBg} ${theme.borderColor}`}>
                        <span className={`${styles.paneHeaderTitle} ${theme.textSecondary}`}>Markdown Editor</span>
                        <div className={styles.paneHeaderActions}>
                            <button
                                onClick={loadSampleText}
                                className={`${styles.paneHeaderButton} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                title="Load sample text"
                            >
                                <FileText className="w-3 h-3" />
                                Sample
                            </button>
                            <button
                                onClick={copyText}
                                className={`${styles.paneHeaderButton} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                title="Copy text"
                            >
                                <Copy className="w-3 h-3" />
                                Copy
                            </button>
                            <button
                                onClick={onToggleEditorFocusMode}
                                className={`${styles.paneHeaderButton} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                title={focusMode === 'editor' ? 'Exit focus mode' : 'Focus editor'}
                            >
                                {focusMode === 'editor' ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                            </button>
                        </div>
                    </div>

                    {}
                    <div className={`${styles.toolbar} ${theme.cardBg} ${theme.borderColor}`}>
                        <div className={styles.toolbarContent}>
                            {}
                            <DropdownButton
                                icon={Type}
                                title="Font Size"
                                isOpen={showFontSize}
                                onClick={() => setShowFontSize(!showFontSize)}
                            >
                                <div className={styles.fontSizeDropdown}>
                                    {fontSizes.map(size => (
                                        <button
                                            key={size.value}
                                            onClick={() => {
                                                formatTextWithSize(size.value);
                                                setShowFontSize(false);
                                            }}
                                            className={`${styles.fontSizeButton} ${theme.buttonHover} ${theme.textSecondary}`}
                                        >
                                            {size.label}px
                                        </button>
                                    ))}
                                </div>
                            </DropdownButton>

                            {}
                            <DropdownButton
                                icon={Palette}
                                title="Text Color"
                                isOpen={showColorPicker}
                                onClick={() => setShowColorPicker(!showColorPicker)}
                            >
                                <div className={styles.colorPickerGrid}>
                                    {colors.map(color => (
                                        <button
                                            key={color.value}
                                            onClick={() => {
                                                formatTextWithColor(color.value);
                                                setShowColorPicker(false);
                                            }}
                                            className={`${styles.colorPickerSwatch} ${color.value === 'white' ? 'border-gray-300' : 'border-gray-400'
                                                }`}
                                            style={{ backgroundColor: color.value }}
                                            title={color.name}
                                        />
                                    ))}
                                </div>
                                <div className={`${styles.colorPickerFooter} ${theme.borderColor}`}>
                                    <div className={`${styles.colorPickerHint} ${theme.textSecondary}`}>
                                        Select text first, then choose a color
                                    </div>
                                    <div className={`${styles.colorPickerPreview} ${theme.textSecondary}`}>
                                        Preview: <span>\\textcolor{'{color}'}{'{text}'}</span>
                                    </div>
                                </div>
                            </DropdownButton>

                            {}
                            <ToolbarButton icon={Bold} onClick={() => formatText('bold')} title="Bold (Ctrl+B)" />
                            <ToolbarButton icon={Italic} onClick={() => formatText('italic')} title="Italic (Ctrl+I)" />
                            <ToolbarButton icon={Underline} onClick={() => formatText('underline')} title="Underline (Ctrl+U)" />
                            <ToolbarButton icon={Strikethrough} onClick={() => formatText('strikethrough')} title="Strikethrough" />
                            <ToolbarButton icon={Code} onClick={() => formatText('code')} title="Code" />

                            {}
                            <ToolbarButton onClick={() => formatText('h1')} title="Header 1">
                                <span className="text-xs font-bold">H1</span>
                            </ToolbarButton>
                            <ToolbarButton onClick={() => formatText('h2')} title="Header 2">
                                <span className="text-xs font-bold">H2</span>
                            </ToolbarButton>
                            <ToolbarButton onClick={() => formatText('h3')} title="Header 3">
                                <span className="text-xs font-bold">H3</span>
                            </ToolbarButton>

                            {}
                            <ToolbarButton icon={List} onClick={() => formatText('bulletList')} title="Bullet List" />
                            <ToolbarButton icon={ListOrdered} onClick={() => formatText('numberedList')} title="Numbered List" />
                            <ToolbarButton onClick={() => formatText('blockquote')} title="Quote">
                                <span className="text-xs font-bold">&quot;</span>
                            </ToolbarButton>

                            {}
                            <ToolbarButton icon={Link} onClick={() => setShowLinkDialog(true)} title="Insert Link (Ctrl+K)" />

                            {}
                            <ToolbarButton icon={Image} onClick={() => setShowImageDialog(true)} title="Insert Image" />

                            {}
                            <ToolbarButton icon={Wand2} onClick={() => setShowAIDialog(true)} title="AI Content Generation" />

                            {}
                            <ToolbarButton icon={GitBranch} onClick={() => setShowDiagramDialog(true)} title="Create Diagram" />

                            {}
                            <ToolbarButton
                                onClick={insertMath}
                                title="Insert Math Formula"
                            >
                                <span className="text-xs font-bold">𝑒</span>
                            </ToolbarButton>
                            <ToolbarButton
                                onClick={insertBlockMath}
                                title="Insert Block Math"
                            >
                                <span className="text-xs font-bold">∫</span>
                            </ToolbarButton>
                            <ToolbarButton
                                onClick={insertTable}
                                title="Insert Table"
                            >
                                <span className="text-xs font-bold">⊞</span>
                            </ToolbarButton>

                            {}
                            <ToolbarButton
                                icon={Undo}
                                onClick={handleUndo}
                                title="Undo (Ctrl+Z)"
                                active={historyIndex > 0}
                            />
                            <ToolbarButton
                                icon={Redo}
                                onClick={handleRedo}
                                title="Redo (Ctrl+Y)"
                                active={historyIndex < contentHistory.length - 1}
                            />

                        </div>
                    </div>

                    {}
                    {showLinkDialog && (
                        <div className={styles.dialogOverlay}>
                            <div className={`${styles.dialogContent} ${theme.cardBg} ${theme.borderColor}`}>
                                <h3 className={`${styles.dialogTitle} ${theme.textPrimary}`}>
                                    Insert Link
                                </h3>
                                <div className={styles.dialogInputs}>
                                    <input
                                        type="text"
                                        value={linkText}
                                        onChange={(e) => setLinkText(e.target.value)}
                                        placeholder="Link text (optional)"
                                        className={`${styles.dialogInput} ${theme.bg} ${theme.borderColor} ${theme.textPrimary}`}
                                    />
                                    <input
                                        type="url"
                                        value={linkUrl}
                                        onChange={(e) => setLinkUrl(e.target.value)}
                                        placeholder="https://example.com"
                                        className={`${styles.dialogInput} ${theme.bg} ${theme.borderColor} ${theme.textPrimary}`}
                                    />
                                </div>
                                <div className={styles.dialogButtons}>
                                    <button
                                        onClick={insertLink}
                                        disabled={!linkUrl}
                                        className={`${styles.dialogButton} ${styles.dialogButtonPrimary} ${theme.accentBg} text-white ${theme.accentHover}`}
                                    >
                                        Insert
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowLinkDialog(false);
                                            setLinkUrl('');
                                            setLinkText('');
                                        }}
                                        className={`${styles.dialogButton} ${styles.dialogButtonSecondary} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {}
                    {showExportModal && createPortal(
                        <div className={styles.dialogOverlayExport}>
                            <div className={`${styles.dialogContentExport} ${theme.cardBg} ${theme.borderColor}`}>
                                <h3 className={`${styles.dialogTitle} ${theme.textPrimary}`}>
                                    {exportStep === 3 ? 'Save to Google Drive' : 'Export Merged Document'}
                                </h3>
                                {exportStep === 1 ? (
                                    <>
                                        <div className={`${styles.dialogSection} ${theme.bg} ${theme.borderColor}`}>
                                            <p className={`${styles.dialogSectionTitle} ${theme.textSecondary}`}>1. Choose format</p>
                                            <div className="flex gap-2 mt-2">
                                                <button
                                                    onClick={() => setExportFormat('tex')}
                                                    className={`flex-1 py-3 px-4 rounded-lg border-2 transition-colors ${
                                                        exportFormat === 'tex' ? theme.accentBg + ' text-white border-transparent' : theme.borderColor + ' ' + theme.buttonHover
                                                    } ${theme.textPrimary}`}
                                                >
                                                    .tex (LaTeX)
                                                </button>
                                                <button
                                                    onClick={() => setExportFormat('pdf')}
                                                    className={`flex-1 py-3 px-4 rounded-lg border-2 transition-colors ${
                                                        exportFormat === 'pdf' ? theme.accentBg + ' text-white border-transparent' : theme.borderColor + ' ' + theme.buttonHover
                                                    } ${theme.textPrimary}`}
                                                >
                                                    .pdf
                                                </button>
                                            </div>
                                        </div>
                                        <div className={`${styles.dialogButtons} mt-4`}>
                                            <button
                                                onClick={() => setExportStep(2)}
                                                className={`${styles.dialogButton} ${styles.dialogButtonPrimary} ${theme.accentBg} text-white ${theme.accentHover}`}
                                            >
                                                Next
                                            </button>
                                            <button
                                                onClick={() => { setShowExportModal(false); setExportStep(1); }}
                                                className={`${styles.dialogButton} ${styles.dialogButtonSecondary} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </>
                                ) : exportStep === 2 ? (
                                    <>
                                        <div className={`${styles.dialogSection} ${theme.bg} ${theme.borderColor}`}>
                                            <p className={`${styles.dialogSectionTitle} ${theme.textSecondary}`}>2. Choose destination</p>
                                            <div className="flex flex-col gap-2 mt-2">
                                                <button
                                                    onClick={() => handleExportExecute('computer')}
                                                    className={`w-full py-3 px-4 rounded-lg border text-left transition-colors ${theme.borderColor} ${theme.buttonHover} ${theme.textPrimary}`}
                                                >
                                                    <Download className="w-4 h-4 inline mr-2" />
                                                    Save to computer (download)
                                                </button>
                                                <button
                                                    onClick={() => handleExportExecute('gdoc')}
                                                    className={`w-full py-3 px-4 rounded-lg border text-left transition-colors ${theme.borderColor} ${theme.buttonHover} ${theme.textPrimary}`}
                                                >
                                                    <FileText className="w-4 h-4 inline mr-2" />
                                                    Send to Google Doc
                                                </button>
                                                <button
                                                    onClick={() => hasProjectContext() ? setExportStep(3) : undefined}
                                                    disabled={!hasProjectContext()}
                                                    className={`w-full py-3 px-4 rounded-lg border text-left transition-colors ${
                                                        hasProjectContext() ? theme.borderColor + ' ' + theme.buttonHover : 'opacity-50 cursor-not-allowed'
                                                    } ${theme.textPrimary}`}
                                                >
                                                    <Folder className="w-4 h-4 inline mr-2" />
                                                    Save to Google Drive
                                                </button>
                                                {!hasProjectContext() && (
                                                    <p className={`text-sm ${theme.textSecondary} mt-1`}>
                                                        Select a project from the main application to save to Google Drive.
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        <div className={`${styles.dialogButtons} mt-4`}>
                                            <button
                                                onClick={() => setExportStep(1)}
                                                className={`${styles.dialogButton} ${styles.dialogButtonSecondary} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                            >
                                                Back
                                            </button>
                                            <button
                                                onClick={() => { setShowExportModal(false); setExportStep(1); }}
                                                className={`${styles.dialogButton} ${styles.dialogButtonSecondary} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                            >
                                                Close
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className={`${styles.dialogSection} ${theme.bg} ${theme.borderColor} flex-1 min-h-0 flex flex-col`}>
                                            <div className="flex-1 min-h-[300px] flex flex-col rounded border overflow-hidden">
                                                <DriveFileBrowser
                                                    showFiles={true}
                                                    showFolders={true}
                                                    selectionMode
                                                    onFolderSelect={(folderId) => handleExportExecute('drive', folderId)}
                                                />
                                            </div>
                                        </div>
                                        <div className={`${styles.dialogButtons} mt-4`}>
                                            <button
                                                onClick={() => setExportStep(2)}
                                                className={`${styles.dialogButton} ${styles.dialogButtonSecondary} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                            >
                                                Back
                                            </button>
                                            <button
                                                onClick={() => { setShowExportModal(false); setExportStep(1); }}
                                                className={`${styles.dialogButton} ${styles.dialogButtonSecondary} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                            >
                                                Close
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>,
                        document.body
                    )}

                    {}
                    {showQCModal && (
                        <QCModal
                            isOpen={showQCModal}
                            onClose={() => setShowQCModal(false)}
                            corpusId={activeStepId ? stepCorpusIds[activeStepId] ?? null : null}
                            stepName={activeStepId ? agentSteps.find(s => s.id === activeStepId)?.name : undefined}
                            generatedText={activeStepId ? (stepContents[activeStepId] ?? '') : undefined}
                        />
                    )}

                    {}
                    {showIntegrityModal && (
                        <IntegrityChainModal
                            chain={getChain()}
                            operationId="canvas"
                            operationName="Canvas agent steps"
                            onClose={() => setShowIntegrityModal(false)}
                            onSave={(opts) => saveChain({ ...opts, operationType: 'canvas-agent', projectId: projectFolder?.projectId })}
                            onList={listChains}
                            onLoad={loadChain}
                        />
                    )}

                    {}
                    {isProcessingCustomPrompt && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center">
                            {}
                            <div className="absolute inset-0 bg-black/40 backdrop-blur-xl"></div>

                            {}
                            <div className={`relative ${theme.cardBg} ${theme.borderColor} border rounded-lg p-8 shadow-2xl max-w-sm mx-4`}>
                                <div className="text-center">
                                    {}
                                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>

                                    {}
                                    <h3 className={`text-lg font-medium ${theme.textPrimary} mb-2`}>
                                        Working in Progress
                                    </h3>
                                    <p className={`text-sm ${theme.textSecondary}`}>
                                        {customPromptFiles.length > 0
                                            ? `Processing your prompt with ${customPromptFiles.length} attachment${customPromptFiles.length > 1 ? 's' : ''}...`
                                            : 'Processing your custom prompt...'}
                                    </p>

                                    {}
                                </div>
                            </div>
                        </div>
                    )}

                    {}
                    {showAIDialog && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                            <div
                                data-ai-dialog
                                className={`p-4 rounded-lg ${theme.cardBg} ${theme.borderColor} border shadow-xl max-w-md w-full mx-4`}
                            >
                                <h3 className={`text-lg font-semibold mb-3 ${theme.textPrimary}`}>
                                    AI Content Generation
                                </h3>

                                <div className="space-y-3">
                                    {}
                                    <div>
                                        <label className={`block text-sm font-medium mb-2 ${theme.textSecondary}`}>
                                            Content Type
                                        </label>
                                        <select
                                            value={aiContentType}
                                            onChange={(e) => setAIContentType(e.target.value)}
                                            className={`w-full px-3 py-2 rounded border ${theme.bg} ${theme.borderColor} ${theme.textPrimary}`}
                                        >
                                            {aiContentTypes.map(type => (
                                                <option key={type.value} value={type.value}>
                                                    {type.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    {}
                                    <div>
                                        <label className={`block text-sm font-medium mb-2 ${theme.textSecondary}`}>
                                            Prompt
                                        </label>
                                        <textarea
                                            value={aiPromptText}
                                            onChange={(e) => setAIPromptText(e.target.value)}
                                            placeholder="Describe what you want to generate..."
                                            className={`w-full h-20 px-3 py-2 rounded border ${theme.bg} ${theme.borderColor} ${theme.textPrimary} placeholder-${theme.textSecondary.replace('text-', '')} resize-none`}
                                        />
                                    </div>
                                </div>

                                <div className="flex gap-2 mt-4">
                                    <button
                                        onClick={() => {
                                            handleAIPrompt();
                                            setShowAIDialog(false);
                                            setAIPromptText('');
                                        }}
                                        disabled={!aiPromptText.trim()}
                                        className={`px-4 py-2 ${theme.accentBg} text-white rounded ${theme.accentHover} disabled:opacity-50 transition-colors`}
                                    >
                                        Generate
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowAIDialog(false);
                                            setAIPromptText('');
                                        }}
                                        className={`px-4 py-2 ${theme.buttonBg} ${theme.textSecondary} rounded ${theme.buttonHover} transition-colors`}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {}
                    {showDiagramDialog && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                            <div
                                data-diagram-dialog
                                className={`p-4 rounded-lg ${theme.cardBg} ${theme.borderColor} border shadow-xl max-w-md w-full mx-4`}
                            >
                                <h3 className={`text-lg font-semibold mb-3 ${theme.textPrimary}`}>
                                    Create Diagram
                                </h3>

                                <div className="space-y-3">
                                    {}
                                    <div>
                                        <label className={`block text-sm font-medium mb-2 ${theme.textSecondary}`}>
                                            Diagram Type
                                        </label>
                                        <select
                                            value={diagramType}
                                            onChange={(e) => setDiagramType(e.target.value)}
                                            className={`w-full px-3 py-2 rounded border ${theme.bg} ${theme.borderColor} ${theme.textPrimary}`}
                                        >
                                            {diagramTypes.map(type => (
                                                <option key={type.value} value={type.value}>
                                                    {type.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    {}
                                    <div>
                                        <label className={`block text-sm font-medium mb-2 ${theme.textSecondary}`}>
                                            Description
                                        </label>
                                        <textarea
                                            value={diagramPromptText}
                                            onChange={(e) => setDiagramPromptText(e.target.value)}
                                            placeholder="Describe what you want to visualize..."
                                            className={`w-full h-20 px-3 py-2 rounded border ${theme.bg} ${theme.borderColor} ${theme.textPrimary} placeholder-${theme.textSecondary.replace('text-', '')} resize-none`}
                                        />
                                    </div>

                                    <div className={`text-xs ${theme.textSecondary} p-2 rounded ${theme.bg}`}>
                                        <p>This will generate a Mermaid diagram based on your description.</p>
                                    </div>
                                </div>

                                <div className="flex gap-2 mt-4">
                                    <button
                                        onClick={() => handleDiagramPrompt()}
                                        disabled={!diagramPromptText.trim() || isGeneratingDiagram}
                                        className={`px-4 py-2 ${theme.accentBg} text-white rounded ${theme.accentHover} disabled:opacity-50 transition-colors flex items-center gap-2`}
                                    >
                                        {isGeneratingDiagram && (
                                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                        )}
                                        {isGeneratingDiagram ? 'Generating...' : 'Create Diagram'}
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowDiagramDialog(false);
                                            setDiagramPromptText('');
                                        }}
                                        className={`px-4 py-2 ${theme.buttonBg} ${theme.textSecondary} rounded ${theme.buttonHover} transition-colors`}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {}
                    {showSelectionMenu && (
                        <div
                            data-selection-menu
                            className={`${styles.selectionMenu} ${theme.cardBg} ${theme.borderColor}`}
                            style={{
                                left: selectionMenuPosition.x,
                                top: selectionMenuPosition.y,
                            }}
                        >
                            {selectionMenuMode === 'format' ? (
                                <>
                                    <button
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyQuickFormat('bold')}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        Bold
                                    </button>
                                    <button
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyQuickFormat('italic')}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        Italic
                                    </button>
                                    <button
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyQuickFormat('underline')}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        Underline
                                    </button>
                                    <button
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyQuickFormat('h1')}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        H1
                                    </button>
                                    <button
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyQuickFormat('h2')}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        H2
                                    </button>
                                    <button
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyQuickFormat('h3')}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        H3
                                    </button>
                                    <button
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyQuickFormat('blockquote')}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        Quote
                                    </button>
                                    <button
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyQuickFormat('code')}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        Code
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        onClick={() => {
                                            handleGrammarCheck();
                                            setShowSelectionMenu(false);
                                        }}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        Grammar
                                    </button>
                                    <button
                                        onClick={() => {
                                            handleAlternatives();
                                            setShowSelectionMenu(false);
                                        }}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        Alternatives
                                    </button>
                                    <button
                                        onClick={() => {
                                            handleCustomPrompt();
                                            setShowSelectionMenu(false);
                                        }}
                                        className={`${styles.selectionMenuButton} ${theme.textPrimary} ${theme.buttonHover}`}
                                    >
                                        Custom Prompt
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                    {}
                    {showPromptDialog && (
                        <div className={styles.dialogOverlay}>
                            <div className={`${styles.dialogContent} ${theme.cardBg} ${theme.borderColor}`}>
                                <h3 className={`${styles.dialogTitle} ${theme.textPrimary}`}>
                                    {currentAction === 'grammar' ? 'Grammar Check' :
                                        currentAction === 'alternatives' ? 'Generate Alternatives' :
                                            'Custom AI Prompt'}
                                </h3>

                                {}
                                <div className={`${styles.dialogSection} ${theme.bg} ${theme.borderColor}`}>
                                    <p className={`${styles.dialogSectionTitle} ${theme.textSecondary}`}>Selected text:</p>
                                    <p className={`${styles.selectedTextDisplay} ${theme.textPrimary}`}>&quot;{selectedText}&quot;</p>
                                </div>

                                {}
                                {currentAction !== 'custom' && (
                                    <div className={`${styles.dialogSection} ${theme.bg} ${theme.borderColor}`}>
                                        <p className={`${styles.dialogSectionTitle} ${theme.textSecondary}`}>AI will:</p>
                                        <p className={`${styles.dialogSectionContent} ${theme.textPrimary}`}>
                                            {currentAction === 'grammar' ? 'Correct grammar, spelling, and punctuation errors while maintaining meaning and tone' :
                                                currentAction === 'alternatives' ? 'Provide 3-5 alternative ways to rephrase the text with the same meaning' : ''}
                                        </p>
                                    </div>
                                )}

                                {}
                                {currentAction === 'custom' && (
                                    <div className={styles.dialogInputs}>
                                        <textarea
                                            value={promptText}
                                            onChange={(e) => setPromptText(e.target.value)}
                                            placeholder="Enter your custom prompt about the selected text..."
                                            className={`${styles.dialogTextarea} ${theme.bg} ${theme.borderColor} ${theme.textPrimary}`}
                                        />

                                        {}
                                        <div className={`mt-4 ${theme.bg} ${theme.borderColor}`}>
                                            <label className={`block text-sm font-medium mb-2 ${theme.textSecondary}`}>
                                                Attachments (Gemini 2.5 Pro)
                                            </label>

                                            {}
                                            <div
                                                className={`border-2 border-dashed ${theme.borderColor} rounded-lg p-4 text-center cursor-pointer hover:${theme.buttonHover} transition-colors`}
                                                onClick={() => {
                                                    const input = document.createElement('input');
                                                    input.type = 'file';
                                                    input.multiple = true;
                                                    input.accept = Object.values(SUPPORTED_FILE_TYPES).join(',');
                                                    input.onchange = (e) => {
                                                        const files = (e.target as HTMLInputElement).files;
                                                        if (files) handleCustomPromptFileUpload(files);
                                                    };
                                                    input.click();
                                                }}
                                                onDrop={(e) => {
                                                    e.preventDefault();
                                                    const files = e.dataTransfer.files;
                                                    if (files) handleCustomPromptFileUpload(files);
                                                }}
                                                onDragOver={(e) => e.preventDefault()}
                                            >
                                                <div className={`${theme.textSecondary} text-sm`}>
                                                    <p>📎 Click to browse or drag & drop files here</p>
                                                    <p className="text-xs mt-1">Supports: Images, PDFs, Audio, Video, Code, Documents</p>
                                                    <p className="text-xs">Max size: 10MB per file</p>
                                                </div>
                                            </div>

                                            {}
                                            {customPromptFiles.length > 0 && (
                                                <div className="mt-3 space-y-2">
                                                    {customPromptFiles.map((file) => (
                                                        <div key={file.id} className={`flex items-center justify-between p-2 ${theme.cardBg} ${theme.borderColor} border rounded`}>
                                                            <div className="flex items-center space-x-2">
                                                                {file.type.startsWith('image/') && file.preview && (
                                                                    <img src={file.preview} alt={file.name} className="w-8 h-8 object-cover rounded" />
                                                                )}
                                                                <span className={`text-sm ${theme.textPrimary}`}>
                                                                    {file.name} ({(file.size / 1024).toFixed(1)}KB)
                                                                </span>
                                                            </div>
                                                            <button
                                                                onClick={() => removeCustomPromptFile(file.id)}
                                                                className={`text-red-500 hover:text-red-700 text-sm px-2 py-1 rounded`}
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <p className={`text-xs ${theme.textSecondary} mt-2`}>
                                                        Files will be processed with Gemini 2.5 Pro for multimodal understanding
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                <div className={styles.dialogButtons}>
                                    <button
                                        onClick={() => {
                                            executeAIPrompt();
                                            setShowPromptDialog(false);
                                            setPromptText('');
                                            setCustomPromptFiles([]);
                                            setCurrentAction(null);
                                        }}
                                        disabled={(currentAction === 'custom' && !promptText.trim() && customPromptFiles.length === 0) || isProcessingCustomPrompt}
                                        className={`${styles.dialogButton} ${styles.dialogButtonPrimary} ${theme.accentBg} text-white ${theme.accentHover}`}
                                    >
                                        {currentAction === 'grammar' ? 'Fix Grammar' :
                                            currentAction === 'alternatives' ? 'Generate Alternatives' :
                                                'Submit Prompt'}
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowPromptDialog(false);
                                            setPromptText('');
                                            setCustomPromptFiles([]);
                                            setCurrentAction(null);
                                        }}
                                        className={`${styles.dialogButton} ${styles.dialogButtonSecondary} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {}
                    {showImageDialog && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                            <div className={`p-4 rounded-lg ${theme.cardBg} ${theme.borderColor} border shadow-xl max-w-md w-full mx-4`}>
                                <h3 className={`text-lg font-semibold mb-3 ${theme.textPrimary}`}>
                                    Insert Image
                                </h3>
                                <div className="space-y-3">
                                    <div>
                                        <label className={`block text-sm font-medium mb-2 ${theme.textSecondary}`}>
                                            Image URL
                                        </label>
                                        <input
                                            type="url"
                                            value={imageUrl}
                                            onChange={(e) => setImageUrl(e.target.value)}
                                            placeholder="https://example.com/image.jpg"
                                            className={`w-full px-3 py-2 rounded border ${theme.bg} ${theme.borderColor} ${theme.textPrimary} placeholder-${theme.textSecondary.replace('text-', '')}`}
                                        />
                                    </div>
                                    <div>
                                        <label className={`block text-sm font-medium mb-2 ${theme.textSecondary}`}>
                                            Alt Text (Optional)
                                        </label>
                                        <input
                                            type="text"
                                            value={imageAlt}
                                            onChange={(e) => setImageAlt(e.target.value)}
                                            placeholder="Describe the image"
                                            className={`w-full px-3 py-2 rounded border ${theme.bg} ${theme.borderColor} ${theme.textPrimary} placeholder-${theme.textSecondary.replace('text-', '')}`}
                                        />
                                    </div>
                                    <div className="mb-3">
                                        <button
                                            onClick={triggerFilePicker}
                                            disabled={isUploadingImage}
                                            className={`w-full px-4 py-2 ${theme.buttonBg} ${theme.textPrimary} rounded ${theme.buttonHover} transition-colors flex items-center justify-center gap-2 disabled:opacity-50`}
                                        >
                                            <Upload className="w-4 h-4" />
                                            {isUploadingImage ? 'Uploading...' : 'Upload from Computer'}
                                        </button>
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept="image/*"
                                            onChange={handleImageUploadFromDialog}
                                            className="hidden"
                                        />
                                    </div>

                                    <div className={`text-center text-sm ${theme.textSecondary} mb-3`}>
                                        — or —
                                    </div>

                                    <div className={`text-xs ${theme.textSecondary} p-2 rounded ${theme.bg} border ${theme.borderColor}`}>
                                        <p className="mb-1">💡 <strong>Pro Tips:</strong></p>
                                        <ul className="list-disc ml-4 space-y-1">
                                            <li>📸 Take screenshots (Win+Shift+S) and paste directly</li>
                                            <li>🖼️ Copy images from web pages and paste</li>
                                            <li>📁 Drag & drop images from your computer</li>
                                            <li>☁️ All images uploaded to Google Drive automatically</li>
                                        </ul>
                                    </div>
                                </div>
                                <div className="flex gap-2 mt-4">
                                    <button
                                        onClick={insertImage}
                                        disabled={!imageUrl}
                                        className={`px-4 py-2 ${theme.accentBg} text-white rounded ${theme.accentHover} disabled:opacity-50 transition-colors`}
                                    >
                                        Insert
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowImageDialog(false);
                                            setImageUrl('');
                                            setImageAlt('');
                                        }}
                                        className={`px-4 py-2 ${theme.buttonBg} ${theme.textSecondary} rounded ${theme.buttonHover} transition-colors`}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {}
                    {isUploadingImage && (
                        <div className="fixed bottom-4 right-4 z-50">
                            <div className={`${styles.notification} ${theme.cardBg} ${theme.borderColor}`}>
                                <Upload className={`${styles.notificationIcon} ${theme.textPrimary}`} />
                                <span className={`${styles.notificationText} ${theme.textPrimary}`}>Uploading image...</span>
                            </div>
                        </div>
                    )}

                    {}
                    {isGeneratingDiagram && (
                        <div className="fixed bottom-4 right-4 z-50">
                            <div className={`${styles.notification} ${theme.cardBg} ${theme.borderColor}`}>
                                <GitBranch className={`${styles.notificationIcon} ${theme.textPrimary}`} />
                                <span className={`${styles.notificationText} ${theme.textPrimary}`}>Generating diagram...</span>
                            </div>
                        </div>
                    )}

                    {}
                    <div className="flex-1 relative overflow-hidden w-full max-w-full">
                        <textarea
                            ref={textareaRef}
                            value={activeStepId !== null ? (stepContents[activeStepId] ?? '') : content}
                            onChange={handleContentChange}
                            onKeyDown={handleKeyDown}
                            onMouseUp={handleTextSelection}
                            onSelect={handleTextSelection}
                            onPaste={handlePaste}
                            onDragOver={handleDragOver}
                            onDrop={handleDrop}
                            className={`${styles.markdownTextarea} ${theme.bg} ${theme.textSecondary}`}
                            placeholder={
                                activeStepId !== null
                                    ? `Step ${(agentSteps.find(s => s.id === activeStepId)?.index ?? 0) + 1}: ${agentSteps.find(s => s.id === activeStepId)?.name ?? ''} — output will appear here after running...`
                                    : mode === 'previewing' ? 'Document assembled for preview...'
                                    : activeSection ? `Writing ${activeSection} section...`
                                    : 'Start typing your markdown here...'
                            }
                            spellCheck={false}
                            readOnly={mode === 'previewing'}
                        />
                        {mode === 'previewing' && (
                            <div className="absolute inset-0 bg-black bg-opacity-10 flex items-center justify-center pointer-events-none">
                                <div className={`${styles.previewModeContainer} ${theme.cardBg} ${theme.borderColor}`}>
                                    <div className={`${styles.previewModeTitle} ${theme.textPrimary}`}>
                                        📋 Preview Mode
                                    </div>
                                    <div className={`${styles.previewModeSubtitle} ${theme.textSecondary}`}>
                                        Document assembled for review
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                    </div>
                )}

                {}
                {isWideEditorLayout && focusMode === 'none' && (
                    <div
                        className={`w-2 shrink-0 cursor-col-resize border-r ${theme.borderColor} ${isPaneResizing ? theme.accentBg : theme.cardBg}`}
                        onMouseDown={handlePaneResizeStart}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize editor and preview panes"
                    />
                )}

                {}
                {focusMode !== 'editor' && (
                    <div
                        className={styles.rightPane}
                        style={focusMode === 'preview'
                            ? { flexBasis: '100%', maxWidth: '100%' }
                            : isWideEditorLayout
                                ? { flexBasis: `${100 - leftPaneWidthPercent}%`, maxWidth: `${100 - leftPaneWidthPercent}%` }
                                : undefined}
                    >
                    <div className={`${styles.paneHeader} ${theme.cardBg} ${theme.borderColor}`}>
                        <span className={`${styles.paneHeaderTitle} ${theme.textSecondary}`}>Live Preview</span>
                        <div className={styles.paneHeaderActions}>
                            <span className={`${styles.previewHeaderCount} ${theme.textSecondary}`}>
                                {(() => {
                                    const displayText = activeStepId !== null ? (stepContents[activeStepId] ?? '') : content;
                                    return `${displayText.split('\n').length} lines • ${displayText.split(/\s+/).filter(w => w.length > 0).length} words • ${displayText.length} chars`;
                                })()}
                            </span>
                            <button
                                onClick={onTogglePreviewFocusMode}
                                className={`${styles.paneHeaderButton} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                                title={focusMode === 'preview' ? 'Exit focus mode' : 'Focus preview'}
                            >
                                {focusMode === 'preview' ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                            </button>
                        </div>
                    </div>
                    <div
                        ref={previewRef}
                        className={`${styles.previewContent} ${theme.bg}`}
                    >
                        <div className="max-w-none prose prose-invert prose-slate break-words">
                            <MainEditorPreview
                                markdown={preprocessLatexFormatting(activeStepId !== null ? (stepContents[activeStepId] ?? '') : content)}
                            />
                        </div>
                    </div>
                    </div>
                )}
            </div>
        </div>
    );
}