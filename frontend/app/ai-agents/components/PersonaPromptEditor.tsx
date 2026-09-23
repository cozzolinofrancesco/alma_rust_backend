'use client';

import DOMPurify from 'dompurify';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaPaperPlane, FaTimes } from 'react-icons/fa';

const renderMarkdown = (text: string): string => {
  const htmlContent = text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/^[•-] (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>(?:\s*<li>.*<\/li>)*)/g, '<ul>$1</ul>');

  return DOMPurify.sanitize(htmlContent, {
    ALLOWED_TAGS: [
      'strong', 'em', 'br', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'p', 'blockquote', 'pre'
    ],
    ALLOWED_ATTR: ['class'],
    FORBID_TAGS: ['script', 'object', 'embed', 'form', 'input', 'iframe'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style'],
    KEEP_CONTENT: true,
    FORBID_CONTENTS: ['script']
  });
};

interface PersonaPromptEditorProps {
  isOpen: boolean;
  onClose: () => void;
  initialContent: string;
  onSave: (content: string, personaId?: string, personaIcon?: string) => void;
}

interface Persona {
  id: string;
  name: string;
  icon: string;
  description: string;
  frameworks: {
    level0: string[];
    level1: {
      context: string[];
      length: string[];
      examples: string[];
      audience: string[];
      role: string[];
    };
    level2: string[];
    level3: string[];
    level4: string[];
  };
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface SuggestionCard {
  id: string;
  icon: string;
  title: string;
  description: string;
  content: string;
  applied: boolean;
  enhancement?: string;
  inDialog?: boolean;
}

interface DialogState {
  activeSuggestion: SuggestionCard | null;
  currentStep: number;
  collectedAnswers: string[];
  questions: string[];
  isComplete: boolean;
}

interface PromptAnalysis {
  covered: string[];
  missing: string[];
  gaps: {
    purpose: 'complete' | 'partial' | 'missing';
    context: 'complete' | 'partial' | 'missing';
    length: 'complete' | 'partial' | 'missing';
    examples: 'complete' | 'partial' | 'missing';
    audience: 'complete' | 'partial' | 'missing';
    role: 'complete' | 'partial' | 'missing';
  };
  confidence: number;
  recommendedPersona?: string;
}

const personas: Persona[] = [
  {
    id: 'scientist',
    name: 'Scientist/Researcher',
    icon: 'SCI',
    description: 'Laboratory research, experimental design, protocol development',
    frameworks: {
      level0: [
        'Define research hypothesis and primary objectives',
        'Specify experimental model and study design',
        'Identify key variables and measurement endpoints'
      ],
      level1: {
        context: [
          'Add study population and inclusion criteria',
          'Include laboratory environment details',
          'Specify regulatory compliance requirements'
        ],
        length: [
          'Set protocol section detail level',
          'Define statistical analysis depth',
          'Specify methodology documentation scope'
        ],
        examples: [
          'Include similar published studies',
          'Add validation protocol templates',
          'Reference standard operating procedures'
        ],
        audience: [
          'Research team members',
          'Ethics committee reviewers',
          'Regulatory authorities',
          'Scientific publication reviewers'
        ],
        role: [
          'Principal investigator',
          'Laboratory scientist',
          'Research coordinator',
          'Biostatistician'
        ]
      },
      level2: [
        'Add statistical power calculations',
        'Include quality control measures',
        'Specify data management procedures',
        'Add safety monitoring protocols'
      ],
      level3: [
        'Integrate multi-site coordination',
        'Add interim analysis plans',
        'Include publication strategy',
        'Specify intellectual property considerations'
      ],
      level4: [
        'Optimize resource allocation',
        'Add timeline contingencies',
        'Include technology transfer plans',
        'Specify collaboration frameworks'
      ]
    }
  },
  {
    id: 'regulatory',
    name: 'Regulatory Affairs',
    icon: 'REG',
    description: 'Submission strategy, compliance, agency interactions',
    frameworks: {
      level0: [
        'Define regulatory pathway and submission type',
        'Specify target markets and authorities',
        'Identify key regulatory milestones'
      ],
      level1: {
        context: [
          'Add regulatory precedent analysis',
          'Include agency guidance compliance',
          'Specify submission timeline context'
        ],
        length: [
          'Set document section detail per ICH format',
          'Define regulatory summary scope',
          'Specify technical appendix depth'
        ],
        examples: [
          'Include successful submission examples',
          'Add regulatory template formats',
          'Reference agency guidance documents'
        ],
        audience: [
          'FDA/EMA reviewers',
          'Regulatory consultants',
          'Cross-functional team members',
          'Senior management'
        ],
        role: [
          'Regulatory affairs specialist',
          'Submission manager',
          'Regulatory consultant',
          'CMC expert'
        ]
      },
      level2: [
        'Add risk assessment matrices',
        'Include agency interaction strategy',
        'Specify quality system compliance',
        'Add post-approval commitments'
      ],
      level3: [
        'Integrate global harmonization requirements',
        'Add lifecycle management strategy',
        'Include competitive landscape analysis',
        'Specify regulatory intelligence integration'
      ],
      level4: [
        'Optimize submission sequencing',
        'Add resource optimization strategies',
        'Include contingency planning',
        'Specify success metrics and KPIs'
      ]
    }
  },
  {
    id: 'academic',
    name: 'Academic Researcher',
    icon: 'EDU',
    description: 'Publications, grants, peer review, institutional requirements',
    frameworks: {
      level0: [
        'Define research question and academic contribution',
        'Specify target journal or funding agency',
        'Identify key academic impact metrics'
      ],
      level1: {
        context: [
          'Add institutional affiliation context',
          'Include funding source requirements',
          'Specify ethical approval status'
        ],
        length: [
          'Set manuscript word count limits',
          'Define grant proposal section lengths',
          'Specify supplementary material scope'
        ],
        examples: [
          'Include high-impact publication examples',
          'Add successful grant proposal templates',
          'Reference methodological precedents'
        ],
        audience: [
          'Peer reviewers',
          'Journal editors',
          'Grant review panels',
          'Academic colleagues'
        ],
        role: [
          'Lead researcher',
          'Collaborating scientist',
          'Grant writer',
          'Manuscript author'
        ]
      },
      level2: [
        'Add citation strategy and impact analysis',
        'Include collaboration network integration',
        'Specify data sharing protocols',
        'Add reproducibility frameworks'
      ],
      level3: [
        'Integrate interdisciplinary perspectives',
        'Add career development strategy',
        'Include policy impact considerations',
        'Specify knowledge transfer plans'
      ],
      level4: [
        'Optimize publication timing and strategy',
        'Add media outreach considerations',
        'Include industry partnership potential',
        'Specify long-term research trajectory'
      ]
    }
  },
  {
    id: 'pharmacokinetic',
    name: 'Pharmacokinetic User',
    icon: 'PK',
    description: 'ADME modeling, PK parameters, population PK/PD, bioequivalence',
    frameworks: {
      level0: [
        'Define PK study objectives and endpoints',
        'Specify ADME characteristics of interest',
        'Identify target population and dosing regimen'
      ],
      level1: {
        context: [
          'Add study design and sampling scheme',
          'Include bioanalytical method validation',
          'Specify population characteristics'
        ],
        length: [
          'Set PK parameter calculation depth',
          'Define modeling report scope',
          'Specify statistical analysis detail'
        ],
        examples: [
          'Include similar compound PK profiles',
          'Add NONMEM/Phoenix model examples',
          'Reference regulatory PK guidance'
        ],
        audience: [
          'Clinical pharmacologists',
          'Biostatisticians',
          'Regulatory reviewers',
          'Pharmaceutical scientists'
        ],
        role: [
          'PK scientist',
          'Population PK modeler',
          'Clinical pharmacologist',
          'Bioanalytical scientist'
        ]
      },
      level2: [
        'Add population PK/PD modeling approach',
        'Include covariate analysis strategy',
        'Specify dose optimization methods',
        'Add drug-drug interaction assessment'
      ],
      level3: [
        'Integrate physiologically-based PK modeling',
        'Add model-informed drug development',
        'Include allometric scaling considerations',
        'Specify regulatory submission strategy'
      ],
      level4: [
        'Optimize modeling efficiency and validation',
        'Add real-world evidence integration',
        'Include precision dosing applications',
        'Specify technology platform optimization'
      ]
    }
  },
  {
    id: 'pk-reports',
    name: 'PK Reports',
    icon: 'RPT',
    description: 'CDISC standards, NCA reporting, bioanalytical validation, regulatory submissions',
    frameworks: {
      level0: [
        'Define report type and regulatory requirements',
        'Specify CDISC compliance standards',
        'Identify target submission pathway'
      ],
      level1: {
        context: [
          'Add study design and population context',
          'Include bioanalytical validation summary',
          'Specify regulatory guideline compliance'
        ],
        length: [
          'Set report section detail per ICH E3',
          'Define statistical table complexity',
          'Specify executive summary scope'
        ],
        examples: [
          'Include FDA/EMA compliant report formats',
          'Add CDISC implementation examples',
          'Reference successful submission templates'
        ],
        audience: [
          'Regulatory reviewers',
          'Biostatisticians',
          'Clinical data managers',
          'QA reviewers'
        ],
        role: [
          'PK report writer',
          'Regulatory specialist',
          'CDISC programmer',
          'Biostatistical reviewer'
        ]
      },
      level2: [
        'Add CDISC SDTM/ADaM mapping details',
        'Include statistical validation procedures',
        'Specify quality control frameworks',
        'Add submission timeline optimization'
      ],
      level3: [
        'Integrate cross-study comparison frameworks',
        'Add regulatory precedent analysis',
        'Include automated reporting solutions',
        'Specify global harmonization requirements'
      ],
      level4: [
        'Optimize report generation efficiency',
        'Add template reusability frameworks',
        'Include reviewer preference integration',
        'Specify submission success optimization'
      ]
    }
  },
  {
    id: 'generic',
    name: 'Generic User',
    icon: 'GEN',
    description: 'Topic-aware prompt enhancement with personalized questions',
    frameworks: {
      level0: [
        'What topic or subject is this prompt for?'
      ],
      level1: {
        context: ['context_placeholder'],
        length: ['length_placeholder'],
        examples: ['examples_placeholder'],
        audience: ['audience_placeholder'],
        role: ['role_placeholder']
      },
      level2: [
        'Any specific format or structure needed?',
        'Any constraints or limitations to consider?'
      ],
      level3: [],
      level4: []
    }
  }
];

const PersonaPromptEditor: React.FC<PersonaPromptEditorProps> = ({
  isOpen,
  onClose,
  initialContent,
  onSave
}) => {
  const [currentStep, setCurrentStep] = useState<'selection' | 'editor'>('selection');
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [currentLevel, setCurrentLevel] = useState(0);
  const [currentSubLevel, setCurrentSubLevel] = useState(0);
  const [detectedTopic, setDetectedTopic] = useState<string>('');
  const [conversationState, setConversationState] = useState<{
    step: 'initial' | 'questioning' | 'enhancement';
    currentQuestion: number;
    totalQuestions: number;
    questions: string[];
    answers: string[];
    buildingPrompt: string;
    targetComponent?: string;
  }>({
    step: 'initial',
    currentQuestion: 0,
    totalQuestions: 0,
    questions: [],
    answers: [],
    buildingPrompt: '',
    targetComponent: undefined
  });
  const [content, setContent] = useState(initialContent);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionCard[]>([]);
  const [promptAnalysis, setPromptAnalysis] = useState<PromptAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [enhancementPreview, setEnhancementPreview] = useState<string>('');
  const [dialogState, setDialogState] = useState<DialogState>({
    activeSuggestion: null,
    currentStep: 0,
    collectedAnswers: [],
    questions: [],
    isComplete: false
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);

  const [showComparisonPopup, setShowComparisonPopup] = useState(false);
  const [originalVersion, setOriginalVersion] = useState('');
  const [optimizedVersion, setOptimizedVersion] = useState('');
  const [showCompletionPopup, setShowCompletionPopup] = useState(false);

  const [showFinalPolishingPopup, setShowFinalPolishingPopup] = useState(false);
  const [isPolishing, setIsPolishing] = useState(false);

  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const analyzePromptContent = (promptText: string): PromptAnalysis => {
    const text = promptText.toLowerCase();

    let recommendedPersona = 'generic';
    if (text.includes('bioequivalence') || text.includes('pharmacokinetic') || text.includes('pk')) {
      recommendedPersona = text.includes('report') ? 'pk-reports' : 'pharmacokinetic';
    } else if (text.includes('regulatory') || text.includes('fda') || text.includes('submission')) {
      recommendedPersona = 'regulatory';
    } else if (text.includes('research') || text.includes('study') || text.includes('protocol')) {
      recommendedPersona = 'scientist';
    } else if (text.includes('publication') || text.includes('paper') || text.includes('manuscript')) {
      recommendedPersona = 'academic';
    }

    const gaps = {
      purpose: (text.includes('**objective:**') || text.includes('objective') || text.includes('criteria') ||
        text.includes('benchmark') || text.includes('analyze') || text.includes('create') ||
        text.includes('develop')) ? 'complete' :
        (text.includes('test') || text.includes('protocol')) ? 'partial' : 'missing',

      context: (text.includes('**context:**') || text.includes('audience') || text.includes('use case') ||
        text.includes('scenario')) ? 'complete' :
        (text.includes('study') || text.includes('data') || text.includes('from')) ? 'partial' : 'missing',

      length: (text.includes('**length/scope:**') || text.includes('summary') || text.includes('report') ||
        text.includes('brief') || text.includes('detailed') || text.includes('comprehensive')) ?
        (text.includes('**length/scope:**') ? 'complete' : 'partial') : 'missing',

      examples: (text.includes('**examples/references:**') || text.includes('example') ||
        text.includes('template') || text.includes('format')) ?
        (text.includes('**examples/references:**') ? 'complete' : 'partial') : 'missing',

      audience: (text.includes('**target audience:**') || text.includes('target audience') ||
        text.includes('target users')) ? 'complete' :
        (text.includes('reviewer') || text.includes('team') || text.includes('client')) ? 'partial' : 'missing',

      role: (text.includes('**your role:**') || text.includes('as a') || text.includes('specialist') ||
        text.includes('expert')) ?
        (text.includes('**your role:**') ? 'complete' : 'partial') : 'missing'
    } as const;

    const covered: string[] = [];
    const missing: string[] = [];

    Object.entries(gaps).forEach(([key, status]) => {
      if (status === 'complete') covered.push(key);
      else if (status === 'missing') missing.push(key);
    });

    return {
      covered,
      missing,
      gaps,
      confidence: covered.length / Object.keys(gaps).length,
      recommendedPersona
    };
  };

  const analyzePrompt = useCallback(async () => {
    if (!content.trim() || !selectedPersona) return;

    const analysis = analyzePromptContent(content);
    setPromptAnalysis(analysis);
  }, [content, selectedPersona]);

  const generateEnhancementSuggestion = (prompt: string, persona: string, index: number): string => {
    const suggestions = [
      (() => {
        if (prompt.includes('research') || prompt.includes('study')) {
          return "Add statistical power analysis and multi-center validation requirements";
        } else if (prompt.includes('analysis') || prompt.includes('report')) {
          return "Include sensitivity analysis and uncertainty quantification methods";
        } else if (prompt.includes('protocol') || prompt.includes('procedure')) {
          return "Add quality control checkpoints and validation criteria";
        }
        return "Incorporate advanced validation and quality assurance measures";
      })(),
      (() => {
        if (prompt.includes('data') || prompt.includes('results')) {
          return "Implement comprehensive error handling and data integrity checks";
        } else if (prompt.includes('regulatory') || prompt.includes('compliance')) {
          return "Add risk assessment framework and mitigation strategies";
        } else if (prompt.includes('model') || prompt.includes('algorithm')) {
          return "Include model validation and performance benchmarking criteria";
        }
        return "Enhance with advanced error handling and performance metrics";
      })()
    ];
    return suggestions[index] || suggestions[0];
  };

  const generateMasterySuggestion = (prompt: string, persona: string, index: number): string => {
    const suggestions = [
      (() => {
        if (persona.includes('Scientist') || persona.includes('Academic')) {
          return "Integrate cutting-edge methodologies and peer-review quality standards";
        } else if (persona.includes('Regulatory')) {
          return "Apply advanced regulatory science principles and global harmonization";
        } else if (persona.includes('Pharmacokinetic')) {
          return "Implement population PK modeling and physiologically-based approaches";
        }
        return "Apply expert-level domain knowledge and advanced methodologies";
      })(),
      (() => {
        if (prompt.includes('innovation') || prompt.includes('novel')) {
          return "Add breakthrough technology integration and future-proofing considerations";
        } else if (prompt.includes('complex') || prompt.includes('challenging')) {
          return "Implement multi-disciplinary expertise and collaborative frameworks";
        }
        return "Incorporate strategic thinking and long-term impact considerations";
      })()
    ];
    return suggestions[index] || suggestions[0];
  };

  const generateOptimizationSuggestion = (prompt: string, persona: string, index: number): string => {
    const suggestions = [
      (() => {
        if (prompt.includes('efficiency') || prompt.includes('performance')) {
          return "Optimize for maximum efficiency while maintaining scientific rigor";
        } else if (prompt.includes('scale') || prompt.includes('implementation')) {
          return "Design for scalability and enterprise-level deployment";
        }
        return "Achieve peak performance optimization and scalability";
      })(),
      (() => {
        if (prompt.includes('cost') || prompt.includes('resource')) {
          return "Implement cost-effectiveness analysis and resource optimization";
        } else if (prompt.includes('time') || prompt.includes('deadline')) {
          return "Add timeline optimization and critical path management";
        }
        return "Optimize for resource efficiency and strategic value delivery";
      })()
    ];
    return suggestions[index] || suggestions[0];
  };

  const generateAISuggestion = useCallback((category: string, currentPrompt: string, persona: string): string => {
    const prompt = currentPrompt.toLowerCase();

    if (category.startsWith('level')) {
      const level = parseInt(category.match(/\d+/)?.[0] || '0');
      const index = parseInt(category.split('-')[1] || '0');

      if (level === 2) {
        const enhancementSuggestions = [
          generateEnhancementSuggestion(prompt, persona, 0),
          generateEnhancementSuggestion(prompt, persona, 1)
        ];
        return enhancementSuggestions[index] || "Add advanced enhancement techniques";
      } else if (level === 3) {
        const masterySuggestions = [
          generateMasterySuggestion(prompt, persona, 0),
          generateMasterySuggestion(prompt, persona, 1)
        ];
        return masterySuggestions[index] || "Apply expert-level optimizations";
      } else if (level === 4) {
        const optimizationSuggestions = [
          generateOptimizationSuggestion(prompt, persona, 0),
          generateOptimizationSuggestion(prompt, persona, 1)
        ];
        return optimizationSuggestions[index] || "Implement peak performance optimizations";
      }
    }

    if (category === 'context') {
      if (prompt.includes('test')) {
        return "Add testing environment details (hardware, software versions, data sources)";
      } else if (prompt.includes('analysis') || prompt.includes('research')) {
        return "Include study population characteristics and data collection timeframe";
      } else if (prompt.includes('report') || prompt.includes('document')) {
        return "Specify regulatory context and compliance requirements";
      }
      return "Add relevant background information and situational context";
    }

    if (category === 'length') {
      if (prompt.includes('summary') || prompt.includes('brief')) {
        return "Aim for 1-2 pages with key findings and recommendations";
      } else if (prompt.includes('comprehensive') || prompt.includes('detailed')) {
        return "Target 5-10 pages with methodology, results, and appendices";
      } else if (prompt.includes('protocol') || prompt.includes('procedure')) {
        return "Include step-by-step instructions with timing and checkpoints";
      }
      return "Specify desired output length and level of detail";
    }

    if (category === 'examples') {
      if (prompt.includes('bioequivalence') || prompt.includes('pk')) {
        return "Reference FDA guidance documents and successful submission examples";
      } else if (prompt.includes('analysis') || prompt.includes('statistical')) {
        return "Include sample data formats and expected output examples";
      } else if (prompt.includes('report') || prompt.includes('document')) {
        return "Provide template sections and formatting requirements";
      }
      return "Add specific examples or templates to guide the output";
    }

    if (category === 'audience') {
      if (prompt.includes('regulatory') || prompt.includes('submission')) {
        return "Target regulatory reviewers with appropriate technical depth";
      } else if (prompt.includes('clinical') || prompt.includes('medical')) {
        return "Address clinical professionals with relevant medical context";
      } else if (prompt.includes('technical') || prompt.includes('scientific')) {
        return "Focus on technical experts with detailed methodology";
      }
      return "Specify the target audience and their expertise level";
    }

    if (category === 'role') {
      if (prompt.includes('bioequivalence') || prompt.includes('pk')) {
        return "Act as a senior pharmacokineticist with regulatory experience";
      } else if (prompt.includes('statistical') || prompt.includes('analysis')) {
        return "Take the role of a biostatistician with clinical trial expertise";
      } else if (prompt.includes('regulatory') || prompt.includes('submission')) {
        return "Assume the perspective of a regulatory affairs specialist";
      }
      return "Define your role and expertise for this task";
    }

    return "Enhance this aspect of your prompt for better results";
  }, []);

  const generateSuggestions = useCallback(() => {
    if (!selectedPersona) return;

    let newSuggestions: SuggestionCard[] = [];

    if (selectedPersona.id === 'generic') {
      newSuggestions = [];
    } else {
      if (currentLevel === 0) {
        const topSuggestions = selectedPersona.frameworks.level0.slice(0, 2);
        newSuggestions = topSuggestions.map((suggestion, index) => ({
          id: `level0-${index}`,
          icon: '●',
          title: 'Purpose Foundation',
          description: suggestion,
          content: suggestion,
          applied: false
        }));
      } else if (currentLevel === 1) {
        const icons = {
          context: '●',
          length: '●',
          examples: '●',
          audience: '●',
          role: '●'
        };

        const clearBatches = [
          ['context', 'length'],
          ['examples', 'audience'],
          ['role']
        ];

        const currentBatch = clearBatches[currentSubLevel] || clearBatches[0];

        currentBatch.forEach(category => {
          const gapStatus = promptAnalysis?.gaps[category as keyof typeof promptAnalysis.gaps];
          if (gapStatus === 'missing' || gapStatus === 'partial') {
            const aiSuggestion = generateAISuggestion(category, content, selectedPersona.name);
            newSuggestions.push({
              id: `level1-${category}`,
              icon: icons[category as keyof typeof icons],
              title: category.charAt(0).toUpperCase() + category.slice(1),
              description: aiSuggestion,
              content: aiSuggestion,
              applied: false
            });
          }
        });
      } else if (currentLevel >= 2) {
        const levelSuggestions = currentLevel === 2 ? selectedPersona.frameworks.level2 :
          currentLevel === 3 ? selectedPersona.frameworks.level3 :
            selectedPersona.frameworks.level4;

        const levelNames = {
          2: 'Enhancement',
          3: 'Mastery',
          4: 'Optimization'
        };

        const icons = ['⚡', '🔥', '✨'];
        const topAdvanced = levelSuggestions.slice(0, 2);

        newSuggestions = topAdvanced.map((suggestion, index) => {
          const aiEnhancedSuggestion = generateAISuggestion(
            `level${currentLevel}-${index}`,
            content,
            selectedPersona.name
          );

          return {
            id: `level${currentLevel}-${index}`,
            icon: icons[currentLevel - 2] || '⚡',
            title: `${levelNames[currentLevel as keyof typeof levelNames]} Phase`,
            description: aiEnhancedSuggestion || suggestion,
            content: aiEnhancedSuggestion || suggestion,
            applied: false
          };
        });
      }
    }

    setSuggestions(newSuggestions);
  }, [selectedPersona, currentLevel, currentSubLevel, promptAnalysis, content, generateAISuggestion]);

  const addWelcomeMessage = useCallback(() => {
    if (chatMessages.length === 0 && selectedPersona) {
      let welcomeContent = '';

      if (selectedPersona.id === 'generic') {
        welcomeContent = `Hello! I'm your conversational prompt builder. I'll help you create the perfect prompt through a simple conversation. 

To get started, just describe what you want to create. For example:
• "I need an email campaign for my product launch"
• "Help me write a summary of a research paper"  
• "I want to analyze customer feedback data"
• "Create a script for a presentation"

What would you like to create today?`;
      } else {
        welcomeContent = `Hello! I'm your ${selectedPersona.name} specialist. Choose a suggestion card above to start enhancing your prompt. I'll guide you through targeted questions to improve your prompt step by step.`;
      }

      const welcomeMessage: ChatMessage = {
        id: 'welcome',
        role: 'assistant',
        content: welcomeContent
      };
      setChatMessages([welcomeMessage]);
    }
  }, [chatMessages.length, selectedPersona]);

  useEffect(() => {
    if (selectedPersona && currentLevel >= 0) {
      analyzePrompt();
      generateSuggestions();
      addWelcomeMessage();
    }
  }, [selectedPersona, currentLevel, analyzePrompt, generateSuggestions, addWelcomeMessage]);

  const performInitialAnalysis = useCallback(async () => {
    if (!initialContent.trim()) return;

    setIsAnalyzing(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const analysis = analyzePromptContent(initialContent);
      setPromptAnalysis(analysis);
    } catch (error) {
      console.error('Initial analysis failed:', error);
    } finally {
      setIsAnalyzing(false);
    }
  }, [initialContent]);

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  useEffect(() => {
    if (initialContent && currentStep === 'selection') {
      performInitialAnalysis();
    }
  }, [initialContent, currentStep, performInitialAnalysis]);

  useEffect(() => {
    if (content && selectedPersona) {
      const timeoutId = setTimeout(() => {
        analyzePrompt();
      }, 1000);

      return () => clearTimeout(timeoutId);
    }
  }, [content, selectedPersona, analyzePrompt]);

  useEffect(() => {
    if (promptAnalysis && promptAnalysis.confidence === 1 && selectedPersona?.id === 'generic') {
      const timeoutId = setTimeout(() => {
        if (!showFinalPolishingPopup && !showComparisonPopup && !showCompletionPopup) {
          setShowFinalPolishingPopup(true);
        }
      }, 1000);

      return () => clearTimeout(timeoutId);
    }
  }, [promptAnalysis, selectedPersona?.id, showFinalPolishingPopup, showComparisonPopup, showCompletionPopup]);

  const detectTopicAndGenerateQuestions = (userDescription: string): { topic: string; questions: string[] } => {
    const analysis = analyzePromptContent(userDescription);
    const missingOrPartial = Object.entries(analysis.gaps)

      .filter(([_, status]) => status === 'missing' || status === 'partial')
      .map(([key]) => key);

    const frameworkQuestions: string[] = [];
    let detectedTopic = 'general task';

    const desc = userDescription.toLowerCase();
    if (desc.includes('email') || desc.includes('campaign')) {
      detectedTopic = 'email marketing';
    } else if (desc.includes('summary') || desc.includes('summarize')) {
      detectedTopic = 'summary';
    } else if (desc.includes('write') || desc.includes('article') || desc.includes('content')) {
      detectedTopic = 'writing';
    } else if (desc.includes('analysis') || desc.includes('data')) {
      detectedTopic = 'data analysis';
    } else if (desc.includes('script') || desc.includes('presentation')) {
      detectedTopic = 'script/presentation';
    }

    missingOrPartial.forEach(component => {
      switch (component) {
        case 'purpose':
          frameworkQuestions.push(getFrameworkQuestion('purpose', detectedTopic));
          break;
        case 'context':
          frameworkQuestions.push(getFrameworkQuestion('context', detectedTopic));
          break;
        case 'length':
          frameworkQuestions.push(getFrameworkQuestion('length', detectedTopic));
          break;
        case 'examples':
          frameworkQuestions.push(getFrameworkQuestion('examples', detectedTopic));
          break;
        case 'audience':
          frameworkQuestions.push(getFrameworkQuestion('audience', detectedTopic));
          break;
        case 'role':
          frameworkQuestions.push(getFrameworkQuestion('role', detectedTopic));
          break;
      }
    });

    if (frameworkQuestions.length === 0) {
      frameworkQuestions.push("What specific aspects would you like me to enhance in your prompt?");
    }

    return { topic: detectedTopic, questions: frameworkQuestions };
  };

  const getFrameworkQuestion = (component: string, topic: string): string => {
    const componentQuestions: { [key: string]: { [topic: string]: string } } = {
      purpose: {
        'email marketing': 'What specific goal or outcome do you want this email campaign to achieve?',
        'summary': 'What is the main purpose of this summary - to inform, decide, or brief?',
        'writing': 'What is the primary purpose or message of this content?',
        'data analysis': 'What specific insights or decisions should this analysis support?',
        'script/presentation': 'What is the main message or call-to-action you want to convey?',
        'general task': 'What specific outcome or result do you want to achieve?'
      },
      context: {
        'email marketing': 'What is the background situation or campaign context for these emails?',
        'summary': 'What is the source material and context for this summary?',
        'writing': 'What is the background context or situation for this content?',
        'data analysis': 'What is the business context or situation driving this analysis?',
        'script/presentation': 'What is the setting, event, or context for this presentation?',
        'general task': 'What is the background context or situation for this task?'
      },
      length: {
        'email marketing': 'How long should each email be? (Brief bullets, detailed paragraphs, etc.)',
        'summary': 'What length do you need? (One page, bullet points, executive brief, etc.)',
        'writing': 'What is the target length? (Word count, pages, brief vs detailed)',
        'data analysis': 'How comprehensive should this analysis be? (High-level summary vs detailed deep-dive)',
        'script/presentation': 'How long should this be? (5 minutes, 30 minutes, specific duration)',
        'general task': 'What is the desired length or scope? (Brief, detailed, comprehensive)'
      },
      examples: {
        'email marketing': 'What specific examples, case studies, or templates should I reference?',
        'summary': 'Should I include specific examples, quotes, or key data points from the source?',
        'writing': 'What examples, case studies, or references should be included?',
        'data analysis': 'What specific examples, benchmarks, or comparative data should be included?',
        'script/presentation': 'What examples, stories, or case studies should be woven in?',
        'general task': 'What specific examples, references, or illustrations should be included?'
      },
      audience: {
        'email marketing': 'Who is your target audience? (Demographics, role, expertise level)',
        'summary': 'Who will read this summary? (Executives, team members, stakeholders)',
        'writing': 'Who is your target audience? (Expertise level, role, interests)',
        'data analysis': 'Who will use this analysis? (Decision makers, analysts, broader team)',
        'script/presentation': 'Who is your audience? (Size, expertise, expectations)',
        'general task': 'Who is this for? (Target audience, expertise level, role)'
      },
      role: {
        'email marketing': 'What role should I take? (Marketing expert, copywriter, strategist)',
        'summary': 'What role should I adopt? (Executive assistant, analyst, subject matter expert)',
        'writing': 'What role should I take? (Expert writer, journalist, subject matter expert)',
        'data analysis': 'What role should I adopt? (Data analyst, business consultant, researcher)',
        'script/presentation': 'What role should I take? (Speech writer, presentation coach, subject expert)',
        'general task': 'What role or expertise should I bring to this task?'
      }
    };

    return componentQuestions[component]?.[topic] || componentQuestions[component]?.['general task'] ||
      `Please provide more details about the ${component} for this task.`;
  };

  const improveAndAppendAnswer = (answer: string, questionIndex: number, currentPrompt: string): string => {
    let component: string;

    if (conversationState.targetComponent) {
      component = conversationState.targetComponent;
    } else {
      const analysis = analyzePromptContent(conversationState.buildingPrompt || content);
      const missingOrPartial = Object.entries(analysis.gaps)

        .filter(([_, status]) => status === 'missing' || status === 'partial')
        .map(([key]) => key);

      component = missingOrPartial[questionIndex];
    }

    if (!component) return currentPrompt;

    const improved = enhanceAnswerForFrameworkComponent(answer, component);

    const componentMappings: { [key: string]: string } = {
      purpose: '**Objective:**',
      context: '**Context:**',
      length: '**Length/Scope:**',
      examples: '**Examples/References:**',
      audience: '**Target Audience:**',
      role: '**Your Role:**'
    };

    const sectionHeader = componentMappings[component] || '**Additional Context:**';

    const existingSectionRegex = new RegExp(`\\*\\*${sectionHeader.replace(/\*\*/g, '').replace(/:/g, '')}:?\\*\\*[^\\n]*\\n?([^\\n*]*(?:\\n(?!\\*\\*)[^\\n*]*)*)?`, 'i');

    if (existingSectionRegex.test(currentPrompt)) {
      return currentPrompt.replace(existingSectionRegex, `${sectionHeader} ${improved}`);
    } else {
      if (!currentPrompt.trim()) {
        return `${sectionHeader} ${improved}`;
      }

      return `${currentPrompt}\n\n${sectionHeader} ${improved}`;
    }
  };

  const enhanceAnswerForFrameworkComponent = (rawAnswer: string, component: string): string => {
    if (!rawAnswer.trim()) return rawAnswer;

    switch (component) {
      case 'purpose':
        if (rawAnswer.length < 30) {
          return `${rawAnswer} with clear, actionable outcomes that deliver measurable value`;
        }
        break;
      case 'context':
        if (rawAnswer.length < 25) {
          return `${rawAnswer}, providing necessary background and situational details`;
        }
        break;
      case 'length':
        if (rawAnswer.length < 20) {
          return `${rawAnswer} maintaining quality and appropriate depth for the audience`;
        }
        break;
      case 'examples':
        if (rawAnswer.length < 25) {
          return `${rawAnswer} to illustrate key points and provide concrete references`;
        }
        break;
      case 'audience':
        if (rawAnswer.length < 25) {
          return `${rawAnswer}, considering their expertise level, preferences, and decision-making needs`;
        }
        break;
      case 'role':
        if (rawAnswer.length < 20) {
          return `${rawAnswer} with appropriate expertise and professional perspective`;
        }
        break;
    }

    return rawAnswer;
  };

  const handleClarificationRequest = (userInput: string, currentQuestion: string): string => {
    const input = userInput.toLowerCase();

    if (input.includes("don't know") || input.includes("not sure")) {
      return `No problem! Let me break this down differently. ${getAlternativeQuestion(currentQuestion)}`;
    } else if (input.includes("what do you mean") || input.includes("clarify") || input.includes("explain")) {
      return `Let me rephrase that: ${rephraseQuestion(currentQuestion)}`;
    } else if (input.includes("example") || input.includes("give me an example")) {
      return `Here's an example: ${getQuestionExample(currentQuestion)}\n\nNow, ${currentQuestion}`;
    }

    return `I understand you might need clarification. ${rephraseQuestion(currentQuestion)}`;
  };

  const getAlternativeQuestion = (originalQuestion: string): string => {
    if (originalQuestion.includes('goal') || originalQuestion.includes('outcome')) {
      return "What problem are you trying to solve or what do you want to accomplish?";
    } else if (originalQuestion.includes('audience')) {
      return "Who will see, read, or use what you're creating?";
    } else if (originalQuestion.includes('style') || originalQuestion.includes('tone')) {
      return "Should this be formal or casual? Professional or friendly?";
    } else if (originalQuestion.includes('constraints') || originalQuestion.includes('requirements')) {
      return "Are there any rules, limits, or specific things I should know about?";
    }
    return "Can you tell me more about what you have in mind?";
  };

  const rephraseQuestion = (originalQuestion: string): string => {
    if (originalQuestion.includes('goal') || originalQuestion.includes('outcome')) {
      return "What's the end result you're hoping to achieve with this?";
    } else if (originalQuestion.includes('audience')) {
      return "Who are you creating this for?";
    } else if (originalQuestion.includes('style') || originalQuestion.includes('tone')) {
      return "How should this sound or feel when someone reads it?";
    } else if (originalQuestion.includes('constraints') || originalQuestion.includes('requirements')) {
      return "Is there anything specific I should keep in mind or any limits to work within?";
    }
    return "Could you share your thoughts on this aspect?";
  };

  const getQuestionExample = (question: string): string => {
    if (question.includes('goal') || question.includes('outcome')) {
      return "For an email campaign, you might say 'increase product sales' or 'build brand awareness'";
    } else if (question.includes('audience')) {
      return "You might say 'small business owners' or 'tech-savvy millennials' or 'my team members'";
    } else if (question.includes('style') || question.includes('tone')) {
      return "You could say 'professional and informative' or 'friendly and conversational'";
    } else if (question.includes('constraints')) {
      return "You might mention 'keep it under 200 words' or 'must include legal disclaimer'";
    }
    return "Think about what's most important for your specific situation";
  };

  const generateUltimateEnhancement = async (prompt: string, topic: string): Promise<{ enhancedPrompt: string; improvements: string[] }> => {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const improvements = [
      'Enhanced clarity and specificity',
      'Optimized structure and flow',
      'Added professional tone refinements',
      'Improved actionable instructions',
      'Strengthened context and background'
    ];

    const lines = prompt.split('\n').filter(line => line.trim());
    const cleanedPrompt = lines
      .map(line => {
        if (line.includes('no to illustrate')) {
          return line.replace('no to illustrate key points and provide concrete references',
            'include relevant examples and concrete references to illustrate key points');
        }
        if (line.includes('collegues with appropriate')) {
          return line.replace('collegues with appropriate expertise and professional perspective',
            'act as an expert colleague with appropriate expertise and professional perspective');
        }
        return line;
      })
      .filter(line => {
        const seen = new Set();
        const key = line.split(':')[0]?.trim();
        if (key && seen.has(key)) return false;
        if (key) seen.add(key);
        return true;
      })
      .join('\n');

    const enhancedPrompt = `Create a comprehensive ${topic} with the following specifications:

${cleanedPrompt}

**Professional Standards:**
• Ensure all responses are actionable and specific
• Maintain professional tone throughout
• Include relevant examples when applicable  
• Structure information with clear logical flow
• Address potential variations or edge cases

**Quality Requirements:**
• Prioritize accuracy and relevance
• Balance comprehensiveness with conciseness
• Consider target audience expertise level
• Provide clear next steps when appropriate`;

    return { enhancedPrompt, improvements };
  };

  const runCoherenceCheck = async (prompt: string, topic: string): Promise<{ isCoherent: boolean; feedback: string; suggestions?: string }> => {
    await new Promise(resolve => setTimeout(resolve, 1200));

    const sentences = prompt.split('.').filter(s => s.trim().length > 0);
    const words = prompt.split(' ').filter(w => w.trim().length > 0);
    const hasTransitions = prompt.includes('furthermore') || prompt.includes('additionally') || prompt.includes('however');
    const hasSpecifics = prompt.includes('specifically') || prompt.includes('example') || prompt.includes('criteria');
    const hasStructure = prompt.includes('\n\n') || prompt.includes('- ') || prompt.includes('1.');

    const coherenceScore = (
      (sentences.length > 3 ? 1 : 0) +
      (words.length > 50 ? 1 : 0) +
      (hasTransitions ? 1 : 0) +
      (hasSpecifics ? 1 : 0) +
      (hasStructure ? 1 : 0)
    ) / 5;

    if (coherenceScore >= 0.7) {
      return {
        isCoherent: true,
        feedback: `🎯 Excellent coherence! Your ${topic} prompt flows well and maintains clear structure throughout.`,
        suggestions: `Consider adding specific examples or use cases to make it even more actionable.`
      };
    } else {
      return {
        isCoherent: false,
        feedback: `⚠️ Your ${topic} prompt could benefit from better flow and structure.`,
        suggestions: `Try adding transitions between ideas, more specific examples, and clearer organization with bullet points or sections.`
      };
    }
  };

  const generateFinalPolishedVersion = async (currentPrompt: string): Promise<string> => {
    setIsPolishing(true);

    try {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const polished = currentPrompt.trim();

      const detectedTopic = detectTopicAndGenerateQuestions(polished).topic;

      const sections = {
        objective: '',
        context: '',
        audience: '',
        role: '',
        length: '',
        examples: '',
        basePrompt: ''
      };

      const sectionRegexes = {
        objective: /\*\*Objective:\*\*\s*([^*]+?)(?=\*\*|$)/gi,
        context: /\*\*Context:\*\*\s*([^*]+?)(?=\*\*|$)/gi,
        audience: /\*\*Target Audience:\*\*\s*([^*]+?)(?=\*\*|$)/gi,
        role: /\*\*Your Role:\*\*\s*([^*]+?)(?=\*\*|$)/gi,
        length: /\*\*Length\/Scope:\*\*\s*([^*]+?)(?=\*\*|$)/gi,
        examples: /\*\*Examples\/References:\*\*\s*([^*]+?)(?=\*\*|$)/gi
      };

      Object.keys(sectionRegexes).forEach((key) => {
        const regex = sectionRegexes[key as keyof typeof sectionRegexes];
        regex.lastIndex = 0;
        const match = regex.exec(polished);
        if (match) {
          sections[key as keyof typeof sections] = match[1].trim().replace(/\n+/g, ' ');
        }
      });

      sections.basePrompt = polished.split(/\*\*(?:Objective|Context|Target Audience|Your Role|Length\/Scope|Examples\/References):\*\*/)[0].trim();

      if (!sections.basePrompt && sections.objective) {
        sections.basePrompt = sections.objective;
        sections.objective = '';
      }

      let optimizedPrompt = '';

      if (sections.role) {
        const cleanRole = sections.role.toLowerCase().replace(/^as\s+/i, '').replace(/with.*$/, '').trim();
        optimizedPrompt += `Acting as ${cleanRole}, `;
      }

      let mainInstruction = sections.basePrompt.charAt(0).toLowerCase() + sections.basePrompt.slice(1);

      if (detectedTopic.includes('summary')) {
        mainInstruction = `create a comprehensive summary that distills key information from ${mainInstruction.replace(/^(create|write|make)\s*/i, '')}`;
      } else if (detectedTopic.includes('analysis')) {
        mainInstruction = `conduct a thorough analysis of ${mainInstruction.replace(/^(analyze|review|examine)\s*/i, '')}`;
      } else if (detectedTopic.includes('email') || detectedTopic.includes('marketing')) {
        mainInstruction = `develop a strategic ${detectedTopic} campaign that ${mainInstruction.replace(/^(create|develop|write)\s*/i, '')}`;
      } else if (detectedTopic.includes('research')) {
        mainInstruction = `design and execute comprehensive research on ${mainInstruction.replace(/^(research|study|investigate)\s*/i, '')}`;
      } else if (detectedTopic.includes('business')) {
        mainInstruction = `formulate a strategic business approach to ${mainInstruction.replace(/^(create|develop|build)\s*/i, '')}`;
      }

      optimizedPrompt += mainInstruction;

      if (sections.objective && !mainInstruction.toLowerCase().includes(sections.objective.toLowerCase().substring(0, 15))) {
        optimizedPrompt += `. Focus specifically on ${sections.objective.toLowerCase()}`;
      }

      if (sections.context) {
        optimizedPrompt += `\n\n**Context & Background:**\n${sections.context}`;

        if (detectedTopic.includes('business')) {
          optimizedPrompt += ' Consider market conditions, competitive landscape, and stakeholder perspectives.';
        } else if (detectedTopic.includes('research')) {
          optimizedPrompt += ' Include relevant methodological considerations and data quality requirements.';
        } else if (detectedTopic.includes('technical') || detectedTopic.includes('analysis')) {
          optimizedPrompt += ' Account for technical constraints, system dependencies, and performance considerations.';
        }
      }

      if (sections.audience) {
        optimizedPrompt += `\n\n**Target Audience & Tone:**\nTailor the content specifically for ${sections.audience.toLowerCase()}`;

        if (sections.audience.toLowerCase().includes('executive') || sections.audience.toLowerCase().includes('management')) {
          optimizedPrompt += ', focusing on strategic insights, ROI implications, and actionable recommendations';
        } else if (sections.audience.toLowerCase().includes('technical') || sections.audience.toLowerCase().includes('developer')) {
          optimizedPrompt += ', emphasizing technical depth, implementation details, and best practices';
        } else if (sections.audience.toLowerCase().includes('general') || sections.audience.toLowerCase().includes('public')) {
          optimizedPrompt += ', using clear, accessible language and avoiding technical jargon';
        }
        optimizedPrompt += '.';
      }

      if (sections.length) {
        const lengthSpec = sections.length.toLowerCase().replace(/maintaining.*$/i, '').trim();
        optimizedPrompt += `\n\n**Scope & Deliverable:**\nProduce ${lengthSpec}`;

        if (detectedTopic.includes('summary')) {
          optimizedPrompt += ' with clear executive summary, key findings, and actionable insights';
        } else if (detectedTopic.includes('analysis')) {
          optimizedPrompt += ' including methodology, findings, conclusions, and recommendations';
        } else if (detectedTopic.includes('strategy') || detectedTopic.includes('business')) {
          optimizedPrompt += ' with strategic framework, implementation roadmap, and success metrics';
        } else if (detectedTopic.includes('technical')) {
          optimizedPrompt += ' with technical specifications, implementation guide, and troubleshooting section';
        }
        optimizedPrompt += '.';
      }

      if (sections.examples) {
        optimizedPrompt += `\n\n**Standards & References:**\nIncorporate ${sections.examples.toLowerCase()}`;

        if (detectedTopic.includes('research')) {
          optimizedPrompt += ' Follow academic standards with proper citations and peer-reviewed sources.';
        } else if (detectedTopic.includes('business')) {
          optimizedPrompt += ' Use industry benchmarks and established business frameworks.';
        } else if (detectedTopic.includes('technical')) {
          optimizedPrompt += ' Adhere to technical documentation standards and best practices.';
        } else {
          optimizedPrompt += ' Maintain professional quality and industry-standard formatting.';
        }
      }

      optimizedPrompt += `\n\n**Quality Requirements:**\n`;
      if (detectedTopic.includes('summary')) {
        optimizedPrompt += '- Ensure concise yet comprehensive coverage of all key points\n- Maintain logical flow and clear hierarchical structure\n- Include quantifiable metrics where applicable';
      } else if (detectedTopic.includes('analysis')) {
        optimizedPrompt += '- Provide data-driven insights with supporting evidence\n- Include multiple perspectives and potential limitations\n- Deliver actionable recommendations with implementation guidance';
      } else if (detectedTopic.includes('business')) {
        optimizedPrompt += '- Include strategic rationale and business impact assessment\n- Provide cost-benefit analysis and risk considerations\n- Deliver clear implementation timeline and resource requirements';
      } else {
        optimizedPrompt += '- Ensure accuracy, clarity, and professional presentation\n- Maintain consistency in terminology and formatting\n- Provide comprehensive coverage of all specified requirements';
      }

      optimizedPrompt = optimizedPrompt
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .replace(/\.\s*\./g, '.')
        .trim();

      return optimizedPrompt;
    } catch (error) {
      console.error('Final polishing failed:', error);
      return currentPrompt;
    } finally {
      setIsPolishing(false);
    }
  };

  const generateDialogQuestions = (suggestion: SuggestionCard): string[] => {
    const category = suggestion.title.toLowerCase();
    const persona = selectedPersona?.name.toLowerCase() || '';

    if (suggestion.title === 'Purpose Foundation') {
      if (suggestion.description.includes('specific outcome')) {
        return [
          "What specific outcome are you trying to achieve with this prompt?",
          "How will you measure success? What are your key performance indicators?",
          "What would a successful result look like in concrete terms?"
        ];
      } else {
        return [
          "What is the primary goal of this prompt?",
          "Who is your target audience and what do they need?",
          "What constraints or requirements should I consider?"
        ];
      }
    }

    if (category === 'context') {
      if (content.toLowerCase().includes('test')) {
        return [
          "What testing environment are you working with? (e.g., Windows, macOS, cloud platform)",
          "What software versions and dependencies are you using?",
          "Where is your test data coming from and how much data are you working with?"
        ];
      } else if (content.toLowerCase().includes('research') || content.toLowerCase().includes('study')) {
        return [
          "What type of research study are you conducting?",
          "What is your study population and sample size?",
          "What time period and data collection methods are involved?"
        ];
      } else {
        return [
          "What is the background context for this task?",
          "What environment or setting will this be used in?",
          "Are there any specific constraints or requirements I should know about?"
        ];
      }
    }

    if (category === 'length') {
      return [
        "What type of output format do you need? (brief summary, detailed report, etc.)",
        "How much detail is appropriate for your audience?",
        "Are there any length constraints or requirements?"
      ];
    }

    if (category === 'examples') {
      if (persona.includes('scientist') || persona.includes('research')) {
        return [
          "What similar studies or methodologies should I reference?",
          "Are there specific standards or guidelines you follow?",
          "What format or template should the output match?"
        ];
      } else if (persona.includes('regulatory')) {
        return [
          "Which regulatory guidelines should I reference? (FDA, EMA, ICH)",
          "Are there specific submission requirements or formats?",
          "What compliance standards need to be followed?"
        ];
      } else {
        return [
          "Can you provide an example of what good output looks like?",
          "Are there templates or formats I should follow?",
          "What similar work have you seen that you'd like to emulate?"
        ];
      }
    }

    if (category === 'audience') {
      return [
        "Who is the primary audience for this output?",
        "What is their level of expertise in this domain?",
        "What do they care most about and what are their priorities?"
      ];
    }

    if (category === 'role') {
      return [
        "What professional role should I take on for this task?",
        "What level of expertise should I demonstrate?",
        "Are there specific qualifications or perspectives that matter?"
      ];
    }

    if (suggestion.title.includes('Enhancement')) {
      return [
        "What advanced techniques or methodologies should be included?",
        "What quality standards or validation requirements apply?",
        "Are there specific performance metrics or benchmarks to consider?"
      ];
    }

    if (suggestion.title.includes('Mastery')) {
      return [
        "What cutting-edge approaches should be incorporated?",
        "What expert-level considerations are most important?",
        "How should this integrate with broader strategic objectives?"
      ];
    }

    if (suggestion.title.includes('Optimization')) {
      return [
        "What efficiency gains are you targeting?",
        "What resources or constraints need optimization?",
        "How should this scale for future requirements?"
      ];
    }

    return [
      "Can you provide more details about what you need?",
      "What specific aspects are most important to you?",
      "Are there any additional requirements I should consider?"
    ];
  };

  const handlePersonaSelect = (persona: Persona) => {
    setSelectedPersona(persona);
    setCurrentStep('editor');
    setCurrentLevel(0);
    setCurrentSubLevel(0);
    setDetectedTopic('');

    if (persona.id === 'generic') {
      setConversationState({
        step: 'initial',
        currentQuestion: 0,
        totalQuestions: 0,
        questions: [],
        answers: [],
        buildingPrompt: '',
        targetComponent: undefined
      });
    }

    setChatMessages([]);
  };

  const handleSuggestionClick = async (suggestion: SuggestionCard) => {
    if (suggestion.applied) return;

    const questions = generateDialogQuestions(suggestion);

    setDialogState({
      activeSuggestion: { ...suggestion, inDialog: true },
      currentStep: 0,
      collectedAnswers: [],
      questions,
      isComplete: false
    });

    setSuggestions(prev => prev.map(s =>
      s.id === suggestion.id ? { ...s, inDialog: true } : s
    ));

    const dialogMessage: ChatMessage = {
      id: `dialog-start-${Date.now()}`,
      role: 'assistant',
      content: `Great! Let me help you enhance your prompt with "${suggestion.title}". I'll ask you a few questions to gather the right information.\n\n${questions[0]}`
    };
    setChatMessages(prev => [...prev, dialogMessage]);
  };

  const processDialogResponse = async (userResponse: string) => {
    const currentDialog = dialogState;
    if (!currentDialog.activeSuggestion) return;

    if (selectedPersona?.id === 'generic') {
      if (currentDialog.activeSuggestion.id === 'topic-detection') {
        setDetectedTopic(userResponse.trim());
        setCurrentLevel(1);

        const confirmationMessage: ChatMessage = {
          id: `topic-confirmed-${Date.now()}`,
          role: 'assistant',
          content: `Perfect! I'll now customize questions for "${userResponse}". Let's enhance your prompt with topic-specific questions.`
        };
        setChatMessages(prev => [...prev, confirmationMessage]);

        setDialogState({
          activeSuggestion: null,
          currentStep: 0,
          collectedAnswers: [],
          questions: [],
          isComplete: false
        });

        setSuggestions(prev => prev.map(s =>
          s.id === 'topic-detection' ? { ...s, applied: true } : s
        ));

        generateSuggestions();
        return;
      }

      if (currentDialog.activeSuggestion.id === 'coherence-check') {
        const coherenceResult = await runCoherenceCheck(content, detectedTopic);

        const resultMessage: ChatMessage = {
          id: `coherence-result-${Date.now()}`,
          role: 'assistant',
          content: coherenceResult.feedback + (coherenceResult.suggestions ? `\n\n${coherenceResult.suggestions}` : '')
        };
        setChatMessages(prev => [...prev, resultMessage]);

        setSuggestions(prev => prev.map(s =>
          s.id === 'coherence-check' ? { ...s, applied: true } : s
        ));

        setCurrentLevel(4);
        generateSuggestions();

        setDialogState({
          activeSuggestion: null,
          currentStep: 0,
          collectedAnswers: [],
          questions: [],
          isComplete: false
        });
        return;
      }

      if (currentDialog.activeSuggestion.id === 'ultimate-enhancement') {
        const enhancementResult = await generateUltimateEnhancement(content, detectedTopic);

        const comparisonMessage: ChatMessage = {
          id: `ultimate-comparison-${Date.now()}`,
          role: 'assistant',
          content: `🚀 **Ultimate Enhancement Complete!**

**Improvements Made:**
${enhancementResult.improvements.map(imp => `• ${imp}`).join('\n')}

**📋 CURRENT VERSION:**
${content}

**✨ ULTIMATE VERSION:**
${enhancementResult.enhancedPrompt}

**Would you like to:**
• Type "KEEP ULTIMATE" to use the enhanced version
• Type "KEEP CURRENT" to stick with your current version
• Type "SHOW DIFFERENCES" to see detailed changes`
        };
        setChatMessages(prev => [...prev, comparisonMessage]);

        setEnhancementPreview(enhancementResult.enhancedPrompt);

        setDialogState({
          activeSuggestion: null,
          currentStep: 0,
          collectedAnswers: [],
          questions: [],
          isComplete: false
        });
        return;
      }
    }

    const enhancedAnswer = enhanceUserAnswer(userResponse, currentDialog.currentStep, currentDialog.activeSuggestion);
    const newAnswers = [...currentDialog.collectedAnswers, enhancedAnswer];
    const nextStep = currentDialog.currentStep + 1;

    if (nextStep < currentDialog.questions.length) {
      setDialogState({
        ...currentDialog,
        currentStep: nextStep,
        collectedAnswers: newAnswers
      });

      const nextQuestion: ChatMessage = {
        id: `dialog-${nextStep}-${Date.now()}`,
        role: 'assistant',
        content: currentDialog.questions[nextStep]
      };
      setChatMessages(prev => [...prev, nextQuestion]);
    } else {
      setDialogState({
        ...currentDialog,
        collectedAnswers: newAnswers,
        isComplete: true
      });

      const refinedAnswers = await refineAnswerSection(newAnswers, currentDialog.activeSuggestion);
      const enhanced = await smartPromptIntegration(currentDialog.activeSuggestion, refinedAnswers, content);
      setContent(enhanced);

      setSuggestions(prev => prev.map(s =>
        s.id === currentDialog.activeSuggestion!.id ?
          { ...s, applied: true, inDialog: false, enhancement: enhanced } : s
      ));

      setDialogState({
        activeSuggestion: null,
        currentStep: 0,
        collectedAnswers: [],
        questions: [],
        isComplete: false
      });

      await analyzePrompt();

      if (selectedPersona?.id === 'generic') {
        if (currentLevel === 1) {
          const enhancementBatches = [
            ['goal', 'audience'],
            ['format', 'constraints']
          ];

          if (currentSubLevel < enhancementBatches.length - 1) {
            setCurrentSubLevel(prev => prev + 1);
          } else {
            setCurrentLevel(2);
            setCurrentSubLevel(0);
          }
        } else if (currentLevel === 2) {
          setCurrentLevel(3);
        }
      } else {
        if (currentLevel === 1) {
          const clearBatches = [
            ['context', 'length'],
            ['examples', 'audience'],
            ['role']
          ];

          const currentBatch = clearBatches[currentSubLevel] || clearBatches[0];
          const remainingInBatch = currentBatch.filter(category => {
            const gapStatus = promptAnalysis?.gaps[category as keyof typeof promptAnalysis.gaps];
            return gapStatus === 'missing' || gapStatus === 'partial';
          });

          if (remainingInBatch.length <= 1 && currentSubLevel < clearBatches.length - 1) {
            setCurrentSubLevel(prev => prev + 1);
          } else if (currentSubLevel >= clearBatches.length - 1) {
            setCurrentLevel(prev => prev + 1);
            setCurrentSubLevel(0);
          }
        }
      }

      generateSuggestions();

      const confirmationMessage: ChatMessage = {
        id: `dialog-complete-${Date.now()}`,
        role: 'assistant',
        content: `✅ Section completed! I've enhanced and refined your responses to create a comprehensive ${currentDialog.activeSuggestion.title.toLowerCase()}. Your answers have been professionally structured and integrated into your prompt.`
      };
      setChatMessages(prev => [...prev, confirmationMessage]);
    }
  };

  const enhanceUserAnswer = (rawAnswer: string, questionIndex: number, suggestion: SuggestionCard): string => {
    if (!rawAnswer.trim()) return rawAnswer;

    const category = suggestion.title.toLowerCase();

    if (category === 'purpose foundation') {
      if (questionIndex === 0) {
        if (rawAnswer.toLowerCase().includes('summary')) {
          return 'Create a comprehensive, concise summary that extracts key insights and actionable information from source materials while maintaining accuracy and relevance';
        }
        if (rawAnswer.toLowerCase().includes('shorter')) {
          return 'Generate a condensed version that preserves essential information while reducing length by 50-70% through strategic content prioritization';
        }
        if (rawAnswer.length < 20) {
          return `Develop a ${rawAnswer} that meets professional standards with clear objectives and measurable outcomes`;
        }
      }
      if (questionIndex === 1) {
        if (rawAnswer.length < 30) {
          return `Success will be measured by: ${rawAnswer}, accuracy of content retention, clarity of presentation, and stakeholder satisfaction with deliverables`;
        }
      }
      if (questionIndex === 2) {
        if (rawAnswer.length < 25) {
          return `Expected deliverable: ${rawAnswer} that demonstrates clear value, meets quality standards, and provides actionable insights for decision-making`;
        }
      }
    }

    if (category.includes('context')) {
      if (questionIndex === 0 && rawAnswer.length < 25) {
        return `Operating environment: ${rawAnswer} with consideration for technical constraints, resource availability, and stakeholder requirements`;
      }
    }

    if (category.includes('length')) {
      if (questionIndex === 0 && rawAnswer.length < 20) {
        return `Format specification: ${rawAnswer} with professional structure, clear sections, and appropriate detail level for intended audience`;
      }
    }

    if (category.includes('audience')) {
      if (questionIndex === 0 && rawAnswer.length < 20) {
        return `Primary stakeholders: ${rawAnswer} with varying expertise levels requiring clear, actionable information tailored to their decision-making needs`;
      }
    }

    if (category.includes('role')) {
      if (questionIndex === 0 && rawAnswer.length < 20) {
        return `Professional perspective: ${rawAnswer} with deep domain expertise, analytical thinking, and commitment to accuracy and best practices`;
      }
    }

    if (rawAnswer.length < 30) {
      return `${rawAnswer} - with professional execution standards, quality assurance, and alignment with industry best practices`;
    }

    return rawAnswer;
  };

  const refineAnswerSection = async (answers: string[], suggestion: SuggestionCard): Promise<string[]> => {
    await new Promise(resolve => setTimeout(resolve, 500));

    return answers.map((answer, index) => {
      const category = suggestion.title.toLowerCase();

      if (category === 'purpose foundation') {
        const purposes = ['Clear objective definition', 'Measurable success criteria', 'Concrete deliverable specification'];
        return `${purposes[index]}: ${answer}`;
      }

      if (category.includes('context')) {
        const contexts = ['Environmental factors', 'Technical specifications', 'Resource considerations'];
        return `${contexts[index]}: ${answer}`;
      }

      if (category.includes('audience')) {
        const audiences = ['Primary users', 'Expertise requirements', 'Decision-making priorities'];
        return `${audiences[index]}: ${answer}`;
      }

      return answer.charAt(0).toUpperCase() + answer.slice(1);
    });
  };

  const smartPromptIntegration = async (suggestion: SuggestionCard, answers: string[], currentPrompt: string): Promise<string> => {
    await new Promise(resolve => setTimeout(resolve, 800));

    const category = suggestion.title.toLowerCase();
    let enhanced = currentPrompt.trim();

    if (suggestion.title === 'Purpose Foundation') {
      if (enhanced.toLowerCase() === 'test agent' || enhanced.length < 50) {
        enhanced = `${answers[0]}

Success Criteria:
${answers[1]}

Expected Outcome:
${answers[2]}`;
      } else {
        enhanced = `${enhanced}

Objective: ${answers[0]}
Success Criteria: ${answers[1]}
Expected Outcome: ${answers[2]}`;
      }
    } else if (category === 'context') {
      const contextSection = `
Context & Environment:
- Environment: ${answers[0]}
- Technical Details: ${answers[1]}
- Data Sources: ${answers[2]}`;
      enhanced = `${enhanced}${contextSection}`;
    } else if (category === 'length') {
      const lengthSection = `
Output Requirements:
- Format: ${answers[0]}
- Detail Level: ${answers[1]}
- Constraints: ${answers[2]}`;
      enhanced = `${enhanced}${lengthSection}`;
    } else if (category === 'examples') {
      const examplesSection = `
Reference Standards:
- Guidelines: ${answers[0]}
- Requirements: ${answers[1]}
- Format: ${answers[2]}`;
      enhanced = `${enhanced}${examplesSection}`;
    } else if (category === 'audience') {
      const audienceSection = `
Target Audience:
- Primary Users: ${answers[0]}
- Expertise Level: ${answers[1]}
- Key Priorities: ${answers[2]}`;
      enhanced = `${enhanced}${audienceSection}`;
    } else if (category === 'role') {
      const roleSection = `
Professional Context:
- Role: ${answers[0]}
- Expertise Level: ${answers[1]}
- Perspective: ${answers[2]}`;
      enhanced = `${enhanced}${roleSection}`;
    } else if (suggestion.title.includes('Enhancement')) {
      const enhancementSection = `
Advanced Requirements:
- Techniques: ${answers[0]}
- Quality Standards: ${answers[1]}
- Performance Metrics: ${answers[2]}`;
      enhanced = `${enhanced}${enhancementSection}`;
    } else if (suggestion.title.includes('Mastery')) {
      const masterySection = `
Expert Considerations:
- Advanced Approaches: ${answers[0]}
- Strategic Factors: ${answers[1]}
- Integration Requirements: ${answers[2]}`;
      enhanced = `${enhanced}${masterySection}`;
    } else if (suggestion.title.includes('Optimization')) {
      const optimizationSection = `
Optimization Goals:
- Efficiency Targets: ${answers[0]}
- Resource Optimization: ${answers[1]}
- Scalability: ${answers[2]}`;
      enhanced = `${enhanced}${optimizationSection}`;
    }

    return enhanced.trim();
  };

  const sendChatMessage = async () => {
    if (!chatInput.trim() || isChatLoading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: chatInput
    };

    setChatMessages(prev => [...prev, userMessage]);
    const currentInput = chatInput;
    setChatInput('');
    setIsChatLoading(true);

    try {
      if (dialogState.activeSuggestion && !dialogState.isComplete) {
        await processDialogResponse(currentInput);
      } else {
        await new Promise(resolve => setTimeout(resolve, 1500));

        const aiResponse: ChatMessage = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: generateAIResponse(currentInput)
        };

        setChatMessages(prev => [...prev, aiResponse]);
      }
    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsChatLoading(false);
    }
  };

  const generateAIResponse = (userInput: string): string => {
    if (!selectedPersona) return "I'm here to help with your prompt enhancement.";

    if (selectedPersona.id === 'generic') {
      const state = conversationState;
      const input = userInput.toLowerCase().trim();

      if (input.includes("don't know") || input.includes("not sure") ||
        input.includes("what do you mean") || input.includes("clarify") ||
        input.includes("example")) {
        if (state.step === 'questioning' && state.questions[state.currentQuestion]) {
          return handleClarificationRequest(userInput, state.questions[state.currentQuestion]);
        }
      }

      if (state.step === 'initial') {
        const { topic, questions } = detectTopicAndGenerateQuestions(userInput);

        const analysis = analyzePromptContent(userInput);
        const missingOrPartial = Object.entries(analysis.gaps)

          .filter(([_, status]) => status === 'missing' || status === 'partial')
          .map(([key]) => key);

        const componentNames: { [key: string]: string } = {
          purpose: 'Purpose',
          context: 'Context',
          length: 'Length',
          examples: 'Examples',
          audience: 'Audience',
          role: 'Role'
        };

        const componentList = missingOrPartial.map(comp => componentNames[comp] || comp);

        setDetectedTopic(topic);
        setConversationState({
          step: 'questioning',
          currentQuestion: 0,
          totalQuestions: questions.length,
          questions,
          answers: [],
          buildingPrompt: '',
          targetComponent: undefined
        });

        return `Perfect! I've analyzed your prompt and detected you want to create ${topic === 'general task' ? 'something' : `a ${topic}`}.

📋 **Framework Analysis:**
Components to address: ${componentList.join(', ')}

I'll ask you ${questions.length} targeted questions to fill these gaps and build the perfect prompt.

**Question 1 of ${questions.length}:**
${questions[0]}`;
      }

      if (state.step === 'questioning') {
        const newAnswers = [...state.answers, userInput];

        const currentPrompt = state.buildingPrompt || content;
        const updatedPrompt = improveAndAppendAnswer(userInput, state.currentQuestion, currentPrompt);

        const analysis = analyzePromptContent(currentPrompt);
        const missingOrPartial = Object.entries(analysis.gaps)
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          .filter(([key, status]) => status === 'missing' || status === 'partial')
          .map(([key]) => key);

        const componentNames: { [key: string]: string } = {
          purpose: 'Purpose',
          context: 'Context',
          length: 'Length',
          examples: 'Examples',
          audience: 'Audience',
          role: 'Role'
        };

        const justAddressed = state.targetComponent || missingOrPartial[state.currentQuestion];
        const componentName = componentNames[justAddressed] || 'Component';

        setContent(updatedPrompt);

        if (state.currentQuestion + 1 < state.totalQuestions) {
          const nextQuestionIndex = state.currentQuestion + 1;
          const nextComponent = missingOrPartial[nextQuestionIndex];
          const nextComponentName = componentNames[nextComponent] || 'Component';

          setConversationState({
            ...state,
            currentQuestion: nextQuestionIndex,
            answers: newAnswers,
            buildingPrompt: updatedPrompt,
            targetComponent: nextComponent
          });

          return `✅ **${componentName}** added to your prompt!

**Question ${nextQuestionIndex + 1} of ${state.totalQuestions}:**
*Addressing: ${nextComponentName}*

${state.questions[nextQuestionIndex]}`;
        } else {

          if (state.totalQuestions === 1 && state.targetComponent) {
            setConversationState({
              step: 'initial',
              currentQuestion: 0,
              totalQuestions: 0,
              questions: [],
              answers: [],
              buildingPrompt: '',
              targetComponent: undefined
            });

            return `✅ **${componentName}** enhanced successfully!

Your prompt has been updated with the ${componentName.toLowerCase()} details. You can click on other framework components to continue improving, or start a new conversation by describing what you want to create.`;
          } else {
            setConversationState({
              ...state,
              step: 'enhancement',
              answers: newAnswers,
              buildingPrompt: updatedPrompt,
              targetComponent: undefined
            });

            return `✅ **${componentName}** completed! All framework components addressed.

**Your enhanced ${detectedTopic} prompt:**
${updatedPrompt}

Would you like me to run a final AI optimization to polish and enhance it further? Type **YES** to optimize or **NO** to keep it as is.`;
          }
        }
      }

      if (state.step === 'enhancement') {
        if (input.includes('yes') || input.includes('optimize') || input.includes('enhance')) {
          setTimeout(async () => {
            const enhanced = await generateUltimateEnhancement(content, detectedTopic);

            setOriginalVersion(content);
            setOptimizedVersion(enhanced.enhancedPrompt);
            setShowComparisonPopup(true);

          }, 1500);

          return '⚡ Running final AI optimization... This will take a moment.';
        } else {
          return '✅ Perfect! Your prompt is ready to use. You can now save it and start using it for your needs.';
        }
      }

      if (enhancementPreview) {
        return 'Please use the comparison popup to choose your preferred version.';
      }

      return 'I\'m here to help with your prompt. What would you like to create?';
    }

    if (userInput.toLowerCase().includes('help') || userInput.toLowerCase().includes('improve')) {
      if (promptAnalysis && promptAnalysis.missing.length > 0) {
        return `Based on your current prompt, I notice you could strengthen: ${promptAnalysis.missing.join(', ')}. Click on any suggestion card above to start a guided enhancement process.`;
      }
    }

    return `I see you mentioned: "${userInput}". To help enhance your prompt, feel free to click on any suggestion card above. I'll guide you through targeted questions to improve that specific aspect.`;
  };

  const handleApply = () => {
    onSave(content, selectedPersona?.id, selectedPersona?.icon);
    onClose();
  };

  const handleBackToSelection = () => {
    setCurrentStep('selection');
    setSelectedPersona(null);
    setCurrentLevel(0);
    setChatMessages([]);
    setSuggestions([]);
  };

  const handleFrameworkComponentClick = (component: string) => {
    if (selectedPersona?.id !== 'generic') return;

    setConversationState(prev => ({ ...prev, targetComponent: component }));

    const { topic } = detectTopicAndGenerateQuestions(content || 'general');

    const question = getFrameworkQuestion(component, topic);

    setConversationState(prev => ({
      ...prev,
      step: 'questioning',
      currentQuestion: 0,
      totalQuestions: 1,
      questions: [question],
      answers: []
    }));

    const newMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'assistant',
      content: question
    };

    setChatMessages(prev => [...prev, newMessage]);
  };

  const handleFinalPolishingYes = () => {
    setShowFinalPolishingPopup(false);

    setTimeout(async () => {
      const polishedVersion = await generateFinalPolishedVersion(content);

      setOriginalVersion(content);
      setOptimizedVersion(polishedVersion);
      setShowComparisonPopup(true);
    }, 50);
  };

  const handleFinalPolishingNo = () => {
    setShowFinalPolishingPopup(false);
  };

  const progressLevels = [
    { name: 'Purpose', level: 0 },
    { name: 'CLEAR', level: 1 },
    { name: 'Enhance', level: 2 },
    { name: 'Master', level: 3 },
    { name: 'Optimize', level: 4 }
  ];

  const getLevelName = (level: number): string => {
    const levelData = progressLevels.find(p => p.level === level);
    return levelData ? levelData.name : 'Unknown';
  };

  if (!isOpen) return null;

  return (
    <div className="persona-modal-overlay">
      <div className="persona-modal-container">
        {}
        <div className="persona-modal-header">
          <h2 className="persona-modal-title">Prompt Builder Assistance</h2>
          <div className="persona-modal-actions">
            <button className="persona-close-btn" onClick={onClose}>
              <FaTimes />
            </button>
          </div>
        </div>

        {}
        {currentStep === 'selection' ? (
          <div className="persona-selection-container">
            <h1 className="persona-selection-title">Choose Your Expertise</h1>
            <p className="persona-selection-subtitle">
              Select your professional context to unlock specialized prompt enhancement frameworks
              tailored to your specific domain and requirements.
            </p>
            {initialContent && (
              <div className="persona-existing-content-notice">
                <div className="persona-content-indicator">
                  <span className="persona-content-icon">📝</span>
                  <div className="persona-content-text">
                    <strong>Existing prompt detected</strong>
                    <p>We&apos;ll analyze your current prompt and suggest persona-specific enhancements</p>
                    {promptAnalysis?.recommendedPersona && (
                      <div className="persona-recommendation">
                        🤖 <strong>AI Recommendation:</strong> Based on your content, consider the <strong>
                          {personas.find(p => p.id === promptAnalysis.recommendedPersona)?.name || 'specialized'}</strong> persona
                      </div>
                    )}
                  </div>
                </div>
                <div className="persona-content-preview">
                  <div className="persona-preview-header">Current prompt:</div>
                  <div className="persona-preview-text">
                    {initialContent.length > 100 ? `${initialContent.substring(0, 100)}...` : initialContent}
                  </div>
                </div>
                {isAnalyzing && (
                  <div className="persona-analyzing">
                    <div className="persona-analyzing-spinner"></div>
                    Analyzing your prompt to recommend the best persona...
                  </div>
                )}
              </div>
            )}
            <div className="persona-grid">
              {personas.map((persona) => (
                <div
                  key={persona.id}
                  className={`persona-card ${promptAnalysis?.recommendedPersona === persona.id ? 'recommended' : ''
                    }`}
                  onClick={() => handlePersonaSelect(persona)}
                >
                  <div className="persona-icon">{persona.icon}</div>
                  <h3 className="persona-name">{persona.name}</h3>
                  <p className="persona-description">{persona.description}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="persona-editor-container">
            {}
            <div className="persona-editor-main">
              {}
              <div className="persona-editor-header">
                <div className="persona-current-info">
                  <div className="persona-current-icon">{selectedPersona?.icon}</div>
                  <div className="persona-current-details">
                    <h3 className="persona-current-name">{selectedPersona?.name}</h3>
                    <p className="persona-current-level">Level {currentLevel}: {getLevelName(currentLevel)}</p>
                  </div>
                </div>
                <button className="persona-change-btn" onClick={handleBackToSelection}>
                  Change Persona
                </button>
              </div>

              {}
              {selectedPersona?.id !== 'generic' && (
                <div className="persona-progress-header">
                  <button
                    className="persona-nav-btn persona-prev-btn"
                    onClick={() => setCurrentLevel(Math.max(0, currentLevel - 1))}
                    disabled={currentLevel === 0}
                    title="Previous level"
                  >
                    ← Previous
                  </button>
                  <div className="persona-progress-info">
                    <div className="persona-progress-bar">
                      {progressLevels.map((level, index) => (
                        <React.Fragment key={level.level}>
                          <div
                            className={`persona-level-dot ${level.level < currentLevel ? 'completed' :
                              level.level === currentLevel ? 'active' : ''
                              }`}
                            onClick={() => setCurrentLevel(level.level)}
                          />
                          {index < progressLevels.length - 1 && (
                            <div className={`persona-level-line ${level.level < currentLevel ? 'completed' : ''}`} />
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                    <div className="persona-progress-label">
                      Level {currentLevel}: {getLevelName(currentLevel)}
                    </div>
                  </div>
                  <button
                    className="persona-nav-btn persona-next-btn"
                    onClick={() => setCurrentLevel(Math.min(4, currentLevel + 1))}
                    disabled={currentLevel === 4}
                    title="Next level"
                  >
                    Next →
                  </button>
                </div>
              )}

              {}
              {promptAnalysis && (
                <div className="persona-gap-analysis">
                  <div className="persona-gap-header">
                    <h4>Framework Coverage</h4>
                    <div className="persona-confidence-score">
                      {Math.round(promptAnalysis.confidence * 100)}% Complete
                    </div>
                  </div>
                  <div className="persona-gap-grid">
                    {Object.entries(promptAnalysis.gaps).map(([key, status]) => (
                      <div
                        key={key}
                        className={`persona-gap-item ${status} ${selectedPersona?.id === 'generic' && status !== 'complete' ? 'clickable' : ''
                          }`}
                        onClick={() => {
                          if (selectedPersona?.id === 'generic' && status !== 'complete') {
                            handleFrameworkComponentClick(key);
                          }
                        }}
                        title={
                          selectedPersona?.id === 'generic' && status !== 'complete'
                            ? `Click to improve ${key}`
                            : ''
                        }
                      >
                        <div className="persona-gap-icon">
                          {status === 'complete' ? '✓' : status === 'partial' ? '◐' : '○'}
                        </div>
                        <span className="persona-gap-label">{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                      </div>
                    ))}
                  </div>
                  {isAnalyzing && (
                    <div className="persona-analyzing">
                      <div className="persona-analyzing-spinner"></div>
                      Analyzing prompt structure...
                    </div>
                  )}
                  {selectedPersona?.id === 'generic' && (
                    <div className="persona-gap-hint">
                      💡 Click any incomplete component above to get targeted questions
                    </div>
                  )}
                </div>
              )}

              {}
              <div className="persona-textarea-container">
                <textarea
                  ref={textareaRef}
                  className="persona-textarea"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={`Enter your prompt here and I'll help you enhance it using ${selectedPersona?.name} best practices...`}
                />
              </div>
            </div>

            {}
            <div className="persona-ai-chat">
              <div className="persona-chat-header">
                <div className="persona-chat-icon">🤖</div>
                <h3 className="persona-chat-title">AI Assistant</h3>
              </div>

              {}
              {selectedPersona?.id !== 'generic' && (
                !dialogState.activeSuggestion ? (
                  <div className="persona-framework-section">
                    <h4 className="persona-framework-title">{getLevelName(currentLevel)} Suggestions</h4>
                    <div className="persona-suggestion-cards">
                      {suggestions.map((suggestion) => (
                        <div
                          key={suggestion.id}
                          className={`persona-suggestion-card ${suggestion.applied ? 'applied' :
                            suggestion.inDialog ? 'inDialog' : ''
                            }`}
                          onClick={() => handleSuggestionClick(suggestion)}
                        >
                          <div className="persona-card-icon">{suggestion.icon}</div>
                          <div className="persona-card-content">
                            <div className="persona-card-title">{suggestion.title}</div>
                            <div className="persona-card-description">{suggestion.description}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="persona-framework-section">
                    <h4 className="persona-framework-title">🎯 {dialogState.activeSuggestion.title} Enhancement</h4>
                    <div className="persona-dialog-status">
                      <div className="persona-dialog-progress">
                        <span>Question {dialogState.currentStep + 1} of {dialogState.questions.length}</span>
                        <div className="persona-dialog-progress-bar">
                          <div
                            className="persona-dialog-progress-fill"
                            style={{ width: `${((dialogState.currentStep + 1) / dialogState.questions.length) * 100}%` }}
                          />
                        </div>
                      </div>
                      <p className="persona-dialog-description">
                        Answer the questions below to enhance your prompt with {dialogState.activeSuggestion.title.toLowerCase()} details.
                      </p>
                    </div>
                  </div>
                )
              )}

              {}
              {selectedPersona?.id === 'generic' && conversationState.step === 'questioning' && (
                <div className="persona-framework-section">
                  <h4 className="persona-framework-title">🎯 Building Your {detectedTopic} Prompt</h4>
                  <div className="persona-dialog-status">
                    <div className="persona-dialog-progress">
                      <span>Question {conversationState.currentQuestion + 1} of {conversationState.totalQuestions}</span>
                      <div className="persona-dialog-progress-bar">
                        <div
                          className="persona-dialog-progress-fill"
                          style={{ width: `${((conversationState.currentQuestion + 1) / conversationState.totalQuestions) * 100}%` }}
                        />
                      </div>
                    </div>
                    <p className="persona-dialog-description">
                      Building your personalized prompt through guided conversation.
                    </p>
                  </div>
                </div>
              )}

              {}
              <div className="persona-chat-messages" ref={chatMessagesRef}>
                {chatMessages.map((message) => (
                  <div key={message.id} className={`persona-chat-message ${message.role}`}>
                    <div
                      className="persona-message-bubble"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                    />
                  </div>
                ))}
                {isChatLoading && (
                  <div className="persona-chat-message assistant">
                    <div className="persona-message-bubble">Thinking...</div>
                  </div>
                )}
              </div>

              {}
              <div className="persona-chat-input-container">
                <input
                  type="text"
                  className="persona-chat-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendChatMessage()}
                  placeholder="Ask for specific help..."
                />
                <button
                  className="persona-chat-send-btn"
                  onClick={sendChatMessage}
                  disabled={!chatInput.trim() || isChatLoading}
                >
                  <FaPaperPlane />
                </button>
              </div>
            </div>
          </div>
        )}

        {}
        {currentStep === 'editor' && (
          <div className="persona-footer-actions">
            <button className="persona-back-btn" onClick={handleBackToSelection}>
              ← Back to Personas
            </button>
            <button className="persona-apply-btn" onClick={handleApply}>
              Apply Enhanced Prompt
            </button>
          </div>
        )}

        {}
        {showComparisonPopup && (
          <div className="comparison-popup-overlay">
            <div className="comparison-popup">
              <div className="comparison-header">
                <h3>🔍 Compare Versions</h3>
                <p>Choose the version you prefer for your final prompt</p>
              </div>

              <div className="comparison-content">
                <div className="version-column">
                  <div className="version-header original">
                    <h4>📋 Your Original Version</h4>
                  </div>
                  <div
                    className="version-text"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(originalVersion) }}
                  />
                  <button
                    className="version-choice-btn original-btn"
                    onClick={() => {
                      setContent(originalVersion);
                      setShowComparisonPopup(false);
                      setShowCompletionPopup(true);
                    }}
                  >
                    Keep Original
                  </button>
                </div>

                <div className="version-divider">
                  <div className="divider-line"></div>
                  <span className="divider-text">VS</span>
                  <div className="divider-line"></div>
                </div>

                <div className="version-column">
                  <div className="version-header optimized">
                    <h4>✨ AI Optimized Version</h4>
                  </div>
                  <div
                    className="version-text"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(optimizedVersion) }}
                  />
                  <button
                    className="version-choice-btn optimized-btn"
                    onClick={() => {
                      setContent(optimizedVersion);
                      setShowComparisonPopup(false);
                      setShowCompletionPopup(true);
                    }}
                  >
                    Keep Optimized
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {}
        {showCompletionPopup && (
          <div className="completion-popup-overlay">
            <div className="completion-popup">
              <div className="completion-content">
                <div className="completion-icon">🎉</div>
                <h3>Prompt Enhancement Complete!</h3>
                <p>Your enhanced prompt is now ready to use.</p>
                <div className="completion-actions">
                  <button
                    className="completion-btn primary"
                    onClick={() => {
                      setShowCompletionPopup(false);
                    }}
                  >
                    Continue Editing
                  </button>
                  <button
                    className="completion-btn apply"
                    onClick={() => {
                      setShowCompletionPopup(false);
                      handleApply();
                    }}
                  >
                    Apply Enhanced Prompt
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {}
        {showFinalPolishingPopup && (
          <div className="completion-popup-overlay">
            <div className="completion-popup">
              <div className="completion-content">
                <div className="completion-icon">✨</div>
                <h3>Framework 100% Complete!</h3>
                <p>Congratulations! Your prompt now covers all framework components.</p>
                <div className="polishing-question">
                  <p><strong>Would you like a final polish and enrichment?</strong></p>
                  <p>I can add professional finishing touches and enhance the overall quality.</p>
                </div>
                <div className="completion-actions">
                  <button
                    className="completion-btn secondary"
                    onClick={handleFinalPolishingNo}
                  >
                    No, I'm Happy With It
                  </button>
                  <button
                    className="completion-btn primary"
                    onClick={handleFinalPolishingYes}
                    disabled={isPolishing}
                  >
                    {isPolishing ? 'Polishing...' : 'Yes, Polish It!'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PersonaPromptEditor; 