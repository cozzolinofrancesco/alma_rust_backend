import type { ReactNode } from 'react';

export type SpotlightPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

export interface TutorialStep {
    id: string;
    title: string;
    subtitle?: string;
    content: ReactNode | string;
    actions?: TutorialAction[];
    icon?: ReactNode | string;
    target?: string;
    placement?: SpotlightPlacement;
}

export interface TutorialAction {
    label: string;
    href?: string;
    onClick?: () => void;
    variant: 'primary' | 'secondary' | 'outline';
    icon?: string;
}

export interface ContentVariant {
    title: string;
    subtitle: string;
    steps: TutorialStep[];
}

export const contentVariants: Record<string, ContentVariant> = {
    homepage: {
        title: "Welcome to ALMA",
        subtitle: "Get started with your research platform",
        steps: [
            {
                id: 'welcome-home',
                title: 'Welcome to ALMA',
                subtitle: 'Your AI-powered research assistant',
                content: `Welcome to ALMA - the Advanced Literature Management Assistant designed specifically for pharmaceutical and scientific research.

**What ALMA offers:**
- **AI-Powered Analysis** - Intelligent document processing and insights
- **Project Organization** - Structured workspace management
- **Academic Search** - Access to PubMed, OpenAlex, and more
- **Collaboration Tools** - Share and work together on research

**Getting Started:**
Create your first project to begin organizing your research materials and leveraging AI assistance.`,
                actions: [
                    {
                        label: 'Create Project',
                        href: '/projects',
                        variant: 'primary'
                    },
                    {
                        label: 'Continue Tour',
                        variant: 'secondary'
                    }
                ]
            },
            {
                id: 'key-features',
                title: 'Key Features Overview',
                subtitle: 'Discover what makes ALMA powerful',
                content: `ALMA combines cutting-edge AI with intuitive research workflows:

**Smart Document Processing:**
- OCR for scanned documents
- Automatic text extraction and analysis
- AI-powered summarization and insights

**Research Discovery:**
- Integrated academic database search
- Citation management and formatting
- Related paper recommendations

**Workflow Automation:**
- Custom AI agents for repetitive tasks
- Batch processing capabilities
- Automated report generation`,
                actions: [
                    {
                        label: 'Explore Features',
                        href: '/documentation',
                        variant: 'primary'
                    },
                    {
                        label: 'Next Step',
                        variant: 'secondary'
                    }
                ]
            },
            {
                id: 'get-started',
                title: 'Ready to Begin?',
                subtitle: 'Start your research journey',
                content: `You're all set to begin using ALMA! Here are your next steps:

**Immediate Actions:**
1. **Create a Project** - Set up your first research workspace
2. **Upload Documents** - Add your research materials
3. **Try AI Analysis** - Experience intelligent document processing

**Pro Tips:**
- Start with a focused research question
- Upload 2-3 key documents initially
- Explore AI agents for specialized tasks

The ALMA community is here to help you succeed!`,
                actions: [
                    {
                        label: 'Start Now',
                        href: '/projects',
                        variant: 'primary'
                    },
                    {
                        label: 'View Documentation',
                        href: '/documentation',
                        variant: 'outline'
                    }
                ]
            }
        ]
    },

    navbar: {
        title: "ALMA Tutorial",
        subtitle: "Learn how to use the platform",
        steps: [
            {
                id: 'platform-overview',
                title: 'Platform Overview',
                subtitle: 'Navigate ALMA like a pro',
                content: `ALMA is organized into key sections to streamline your research workflow:

**Main Navigation:**
- **Home** - Dashboard and recent activity
- **Projects** - Manage research workspaces
- **Search** - Find academic papers and resources
- **Add Data** - Upload and process documents
- **Workflow Agents** - AI assistants for automation

**Community Features:**
- Documentation and guides
- API documentation for developers
- Feedback and support channels`,
                actions: [
                    {
                        label: 'Explore Projects',
                        href: '/projects',
                        variant: 'primary'
                    },
                    {
                        label: 'Continue',
                        variant: 'secondary'
                    }
                ]
            },
            {
                id: 'workflow-guide',
                title: 'Typical Research Workflow',
                subtitle: 'From setup to insights',
                content: `Follow this proven workflow to maximize your research efficiency:

**Phase 1: Setup**
1. Create a project with organized folder structure
2. Upload your initial research materials
3. Configure AI agents for your research domain

**Phase 2: Discovery**
1. Search academic databases for related work
2. Import relevant papers and documents
3. Use AI to identify key themes and gaps

**Phase 3: Analysis**
1. Deploy AI agents for systematic analysis
2. Generate summaries and extract insights
3. Create reports and visualizations`,
                actions: [
                    {
                        label: 'Start Workflow',
                        href: '/projects',
                        variant: 'primary'
                    },
                    {
                        label: 'Next Tip',
                        variant: 'secondary'
                    }
                ]
            },
            {
                id: 'advanced-tips',
                title: 'Advanced Tips & Tricks',
                subtitle: 'Become an ALMA power user',
                content: `Unlock ALMA's full potential with these advanced techniques:

**Efficiency Boosters:**
- Use batch processing for multiple documents
- Create custom AI agent templates
- Set up automated workflows for routine tasks

**Collaboration Features:**
- Share projects with team members
- Use collections to organize related materials
- Export findings in multiple formats

**Integration Options:**
- Connect with reference managers
- Use API for custom integrations
- Sync with cloud storage services`,
                actions: [
                    {
                        label: 'View Advanced Docs',
                        href: '/doc-technical',
                        variant: 'primary'
                    },
                    {
                        label: 'Finish Tutorial',
                        variant: 'secondary'
                    }
                ]
            }
        ]
    },

    projects: {
        title: "Your Project is Ready!",
        subtitle: "Setup completed successfully",
        steps: [
            {
                id: 'project-ready',
                title: 'Project Structure Created',
                subtitle: 'Your workspace is organized and ready',
                content: `Congratulations! Your ALMA project has been set up with a complete folder structure:

**Organized Workspace:**
- **Documents & Collections** - For research materials
- **AI Agents** - Custom assistants for your project
- **Analysis** - Results and insights storage
- **Scripts & Tools** - Automation and workflows
- **Reports** - Generated outputs and summaries

**Next Steps:**
Your project is now ready for research materials and AI-powered analysis.`,
                actions: [
                    {
                        label: 'Upload Documents',
                        href: '/upload',
                        variant: 'primary'
                    },
                    {
                        label: 'Continue Setup',
                        variant: 'secondary'
                    }
                ]
            },
            {
                id: 'first-upload',
                title: 'Add Your Research Materials',
                subtitle: 'Start building your knowledge base',
                content: `Time to populate your project with research materials:

**Upload Options:**
- **Drag & Drop** - Simply drag files into the upload area
- **OCR Processing** - Scanned documents become searchable
- **Batch Upload** - Process multiple files simultaneously
- **Format Support** - PDFs, Word docs, images, and more

**Best Practices:**
- Start with 2-3 key documents
- Use descriptive filenames
- Organize by research themes or topics`,
                actions: [
                    {
                        label: 'Upload Now',
                        href: '/upload',
                        variant: 'primary'
                    },
                    {
                        label: 'Skip for Now',
                        variant: 'outline'
                    }
                ]
            },
            {
                id: 'ai-agents-setup',
                title: 'Configure AI Agents',
                subtitle: 'Set up intelligent assistants',
                content: `AI Agents are your specialized research assistants:

**Popular Agent Types:**
- **Document Analyzer** - Extract insights and summaries
- **Research Assistant** - Answer questions about materials
- **Citation Helper** - Manage references and formatting
- **Data Extractor** - Pull specific information systematically

**Getting Started:**
Use pre-built templates or create custom agents tailored to your research methodology and domain.`,
                actions: [
                    {
                        label: 'Create AI Agent',
                        href: '/ai-agents',
                        variant: 'primary'
                    },
                    {
                        label: 'Finish Setup',
                        variant: 'secondary'
                    }
                ]
            }
        ]
    }
};

export const tutorialConfig = {
    totalSteps: 3,
    canSkip: true,
    showProgress: true,
    dismissible: true,
    cookieDuration: 30
}; 