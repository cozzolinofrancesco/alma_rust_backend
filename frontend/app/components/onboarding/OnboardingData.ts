export interface OnboardingStep {
    id: string;
    title: string;
    subtitle: string;
    content: string;
    actions: OnboardingAction[];
    icon: string;
    illustration?: string;
}

export interface OnboardingAction {
    label: string;
    href?: string;
    onClick?: () => void;
    variant: 'primary' | 'secondary' | 'outline';
    icon?: string;
}

export const onboardingSteps: OnboardingStep[] = [
    {
        id: 'welcome',
        title: 'Your Project is Ready!',
        subtitle: 'Setup completed successfully',
        content: `Your ALMA project structure has been created with all the necessary folders. You now have a fully organized workspace in Google Drive with dedicated spaces for documents, analysis, AI agents, and more.

**What's been set up for you:**
- **Documents & Collections** - For organizing your research materials
- **AI Agents** - Ready for custom AI assistants
- **Analysis** - For storing research insights and outputs
- **Scripts & Tools** - For automation and workflows`,
        actions: [
            {
                label: 'Continue Tour',
                variant: 'primary'
            },
            {
                label: 'Skip to Dashboard',
                href: '/',
                variant: 'outline'
            }
        ],
        icon: '',
        illustration: 'project-ready'
    },
    {
        id: 'upload',
        title: 'Upload Your First Documents',
        subtitle: 'Start building your knowledge base',
        content: `Ready to add your research materials? ALMA makes it easy to upload and organize documents with powerful features:

**Upload Options:**
- **Drag & Drop** - Simply drag files into the upload area
- **OCR Processing** - Scanned documents are automatically made searchable
- **Batch Upload** - Upload multiple files at once
- **Format Support** - PDFs, Word docs, images, and more

**Pro Tip:** Start with 2-3 key documents to get familiar with the system before uploading your entire library.`,
        actions: [
            {
                label: 'Upload Documents',
                href: '/upload',
                variant: 'primary'
            },
            {
                label: 'Next Step',
                variant: 'secondary'
            }
        ],
        icon: ''
    },
    {
        id: 'ai-agents',
        title: 'Create Your First AI Agent',
        subtitle: 'Unleash the power of AI analysis',
        content: `AI Agents are your specialized research assistants. They can analyze documents, answer questions, and help with specific research tasks tailored to your field.

**Popular Agent Types:**
- **Document Analyzer** - Extract key insights and summaries
- **Research Assistant** - Answer questions about your materials
- **Citation Helper** - Find and format references
- **Data Extractor** - Pull specific information from documents

**Getting Started:**
Use templates or create custom agents for your specific research methodology.`,
        actions: [
            {
                label: 'Create AI Agent',
                href: '/ai-agents',
                variant: 'primary'
            },
            {
                label: 'Next Step',
                variant: 'secondary'
            }
        ],
        icon: ''
    },
    {
        id: 'search',
        title: 'Discover Academic Resources',
        subtitle: 'Access powerful search capabilities',
        content: `ALMA integrates with leading academic databases to help you discover relevant research and expand your knowledge base.

**Search Capabilities:**
- **PubMed** - Medical and life science literature
- **OpenAlex** - Open scholarly works across disciplines  
- **Google Scholar** - Broad academic search
- **Cross-Project Search** - Find information across all your materials

**Smart Features:**
- AI-powered recommendations for related papers
- Advanced filtering by publication date, author, journal
- Automatic citation extraction and formatting`,
        actions: [
            {
                label: 'Start Searching',
                href: '/searchpaper',
                variant: 'primary'
            },
            {
                label: 'Next Step',
                variant: 'secondary'
            }
        ],
        icon: ''
    },
    {
        id: 'tips',
        title: 'Tips for Success',
        subtitle: 'Make the most of your ALMA experience',
        content: `Here are some proven strategies to maximize your productivity with ALMA:

**Start Small & Build:**
- Begin with a focused research question
- Upload a few key documents first
- Experiment with one AI agent before creating multiple

**Stay Organized:**
- Use descriptive names for projects and collections
- Take advantage of automatic organization features
- Regularly review and clean up materials

**Leverage AI Effectively:**
- Ask specific questions about your documents
- Use AI agents for repetitive analysis tasks
- Let ALMA suggest related documents and sources`,
        actions: [
            {
                label: 'View Full Documentation',
                href: '/documentation',
                variant: 'primary'
            },
            {
                label: 'Finish Tour',
                variant: 'secondary'
            }
        ],
        icon: ''
    }
];

export const onboardingConfig = {
    totalSteps: onboardingSteps.length,
    canSkip: true,
    showProgress: true,
    autoAdvance: false,
    dismissible: true
}; 