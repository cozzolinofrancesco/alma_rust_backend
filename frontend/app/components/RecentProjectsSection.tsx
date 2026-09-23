'use client';

import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FaFolder, FaCalendar, FaUser, FaSyncAlt } from 'react-icons/fa';
import { getCleanProjectName as getSharedCleanProjectName } from '../lib/project-constants';

interface Project {
  id: string;
  name: string;
  displayName?: string;
  createdTime: string;
  owner?: string;
  almaRootOwner?: string;
}

export default function RecentProjectsSection() {
  console.log('🎬 RecentProjectsSection: Component mounted/rendered');
  
  const { data: session } = useSession();
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  
  console.log('🔍 Component state:', { loading, error, projectCount: recentProjects.length, hasSession: !!session });

  useEffect(() => {
    const fetchRecentProjects = async () => {
      console.log('🔍 RecentProjectsSection: Starting to fetch projects...');
      console.log('Session status:', { 
        session: !!session, 
        status: session ? 'authenticated' : 'unauthenticated',
        accessToken: !!session?.accessToken 
      });
      
      if (!session) {
        console.log('⚠️ No session yet, waiting...');
        setLoading(false);
        return;
      }

      setLoading(true);

      try {
        const url = new URL('/api/list-projects', window.location.origin);
        console.log('📡 Fetching projects from:', url.toString());
        
        const response = await fetch(url.toString(), { mode: 'cors' });

        if (response.ok) {
          const data = await response.json();
          const projects = data.projects ?? [];
          
          console.log(`📊 Received ${projects.length} projects from API`);

          const projectMap = new Map<string, Project>();
          projects.forEach((project: Project) => {
            if (project.id) {
              if (!projectMap.has(project.id)) {
                projectMap.set(project.id, project);
              } else {
                console.log(`🔄 Duplicate removed: ${project.name} (${project.id})`);
              }
            }
          });
          
          const uniqueProjects = Array.from(projectMap.values());
          console.log(`🎯 Deduplication: ${projects.length} → ${uniqueProjects.length} projects`);

          const sortedProjects = uniqueProjects
            .sort((a: Project, b: Project) => {
              const timeA = new Date(a.createdTime).getTime();
              const timeB = new Date(b.createdTime).getTime();
              return timeB - timeA;
            })
            .slice(0, 5);

          console.log('✅ Last 5 created projects:', sortedProjects);
          setRecentProjects(sortedProjects);
        } else {
          console.error('❌ Error loading projects:', response.status, response.statusText);
          setError('Failed to load projects');
        }
      } catch (err) {
        console.error('❌ Error fetching recent projects:', err);
        setError('Failed to load recent projects');
      } finally {
        setLoading(false);
      }
    };

    fetchRecentProjects();
  }, [session]);

  const handleRefresh = async () => {
    console.log('🔄 Manual refresh triggered');
    setRefreshing(true);
    setError(null);
    
    try {
      const url = new URL('/api/list-projects', window.location.origin);
      url.searchParams.set('_cacheBust', Date.now().toString());
      console.log('📡 Force fetching projects...');
      
      const response = await fetch(url.toString(), { mode: 'cors' });

      if (response.ok) {
        const data = await response.json();
        const projects = data.projects ?? [];
        
        console.log(`📊 Refresh: Received ${projects.length} projects`);

        const projectMap = new Map<string, Project>();
        projects.forEach((project: Project) => {
          if (project.id && !projectMap.has(project.id)) {
            projectMap.set(project.id, project);
          }
        });
        
        const uniqueProjects = Array.from(projectMap.values());
        const sortedProjects = uniqueProjects
          .sort((a: Project, b: Project) => {
            const timeA = new Date(a.createdTime).getTime();
            const timeB = new Date(b.createdTime).getTime();
            return timeB - timeA;
          })
          .slice(0, 5);

        console.log('✅ Refresh: Displaying', sortedProjects.length, 'projects');
        setRecentProjects(sortedProjects);
      }
    } catch (err) {
      console.error('❌ Refresh error:', err);
      setError('Failed to refresh projects');
    } finally {
      setRefreshing(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getCleanProjectName = (name: string) => {
    const cleanName = getSharedCleanProjectName(name);
    const maxLength = 10;
    if (cleanName.length > maxLength) {
      return cleanName.substring(0, maxLength) + '...';
    }
    return cleanName;
  };

  console.log('👤 RecentProjectsSection: Session check:', { 
    hasSession: !!session, 
    hasAccessToken: !!session?.accessToken,
    userEmail: session?.user?.email
  });
  
  console.log('🎨 RecentProjectsSection: Rendering with state:', { 
    loading, 
    error, 
    projectCount: recentProjects.length 
  });

  if (loading) {
    console.log('⏳ RecentProjectsSection: Still loading...');
    return (
      <section style={styles.section}>
        <h2 style={styles.title}>Recent Projects</h2>
        <div style={styles.loadingContainer}>
          <p style={styles.loadingText}>Loading projects...</p>
        </div>
      </section>
    );
  }

  if (error) {
    console.log('❌ RecentProjectsSection: Error state:', error);
    return (
      <section style={styles.section}>
        <h2 style={styles.title}>Recent Projects</h2>
        <div style={styles.errorContainer}>
          <p style={styles.errorText}>{error}</p>
        </div>
      </section>
    );
  }

  if (recentProjects.length === 0) {
    console.log('📭 RecentProjectsSection: No projects to display');
    return (
      <section style={styles.section}>
        <h2 style={styles.title}>Recent Projects</h2>
        <div style={styles.emptyContainer}>
          <p style={styles.emptyText}>No projects found. View all projects to get started!</p>
          <Link href="/projects" style={styles.createButton}>
            View All Projects
          </Link>
        </div>
      </section>
    );
  }

  console.log('✅ RecentProjectsSection: Rendering', recentProjects.length, 'projects');
  console.log('🎨 Section styles applied:', styles.section);

  return (
    <section style={styles.section}>
      <div style={styles.header}>
        <h2 style={styles.title}>Recent Projects</h2>
        <div style={styles.headerActions}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              ...styles.refreshButton,
              opacity: refreshing ? 0.6 : 1,
              cursor: refreshing ? 'not-allowed' : 'pointer',
            }}
            title="Refresh projects"
          >
            <FaSyncAlt 
              size={16} 
              style={{
                animation: refreshing ? 'spin 1s linear infinite' : 'none',
              }}
            />
          </button>
          <Link href="/projects" style={styles.viewAllLink}>
            View All →
          </Link>
        </div>
      </div>

      <div style={styles.projectsGrid}>
        {recentProjects.map((project, index) => {
          console.log(`🎨 Rendering project ${index}:`, project.displayName || project.name);
          return (
          <Link
            key={project.id}
            href={`/projects?id=${project.id}`}
            style={styles.projectCard}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-4px)';
              e.currentTarget.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.1)';
            }}
          >
            <div style={styles.projectIcon}>
              <FaFolder size={24} color="#11074A" />
            </div>

            <h3 style={styles.projectName}>
              {project.displayName || getCleanProjectName(project.name)}
            </h3>

            <div style={styles.projectMeta}>
              <div style={styles.metaItem}>
                <FaCalendar size={12} color="#6c757d" />
                <span style={styles.metaText}>{formatDate(project.createdTime)}</span>
              </div>
              {(project.owner || project.almaRootOwner) && (
                <div style={styles.metaItem}>
                  <FaUser size={12} color="#6c757d" />
                  <span style={styles.metaText}>
                    {(project.owner || project.almaRootOwner || '').split('@')[0]}
                  </span>
                </div>
              )}
            </div>
          </Link>
        );
        })}
      </div>
      
      {}
      <style jsx global>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </section>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  section: {
    margin: '4rem 0',
    position: 'relative',
    zIndex: 100,
    backgroundColor: '#f8f9fa',
    padding: '2rem',
    borderRadius: '12px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '2rem',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  refreshButton: {
    backgroundColor: 'white',
    border: '2px solid #11074A',
    borderRadius: '8px',
    padding: '0.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.2s',
    color: '#11074A',
  },
  title: {
    fontSize: '2rem',
    fontWeight: '700',
    color: '#11074A',
    margin: 0,
  },
  viewAllLink: {
    color: '#11074A',
    textDecoration: 'none',
    fontWeight: '600',
    fontSize: '1rem',
    transition: 'opacity 0.2s',
  },
  projectsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
    gap: '1.5rem',
    maxWidth: '100%',
  },
  projectCard: {
    backgroundColor: 'white',
    borderRadius: '12px',
    padding: '1.5rem',
    textDecoration: 'none',
    color: 'inherit',
    border: '2px solid #e9ecef',
    transition: 'all 0.3s ease',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
  },
  projectIcon: {
    width: '48px',
    height: '48px',
    borderRadius: '12px',
    backgroundColor: '#F0F4FC',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectName: {
    fontSize: '1.2rem',
    fontWeight: '600',
    color: '#11074A',
    margin: 0,
    lineHeight: '1.4',
  },
  projectMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  metaItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  metaText: {
    fontSize: '0.875rem',
    color: '#6c757d',
  },
  loadingContainer: {
    textAlign: 'center',
    padding: '3rem',
    backgroundColor: 'white',
    borderRadius: '12px',
    border: '2px solid #e9ecef',
    position: 'relative',
    zIndex: 10,
  },
  loadingText: {
    color: '#6c757d',
    fontSize: '1rem',
  },
  errorContainer: {
    textAlign: 'center',
    padding: '3rem',
    backgroundColor: '#fee2e2',
    borderRadius: '12px',
    border: '2px solid #fca5a5',
    position: 'relative',
    zIndex: 10,
  },
  errorText: {
    color: '#dc2626',
    fontSize: '1rem',
  },
  emptyContainer: {
    textAlign: 'center',
    padding: '3rem',
    backgroundColor: 'white',
    borderRadius: '12px',
    border: '2px solid #e9ecef',
    position: 'relative',
    zIndex: 10,
  },
  emptyText: {
    color: '#6c757d',
    fontSize: '1rem',
    marginBottom: '1.5rem',
  },
  createButton: {
    display: 'inline-block',
    backgroundColor: '#11074A',
    color: 'white',
    padding: '0.75rem 2rem',
    borderRadius: '8px',
    textDecoration: 'none',
    fontWeight: '600',
    transition: 'all 0.3s ease',
  },
};

