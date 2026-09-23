'use client';

import React from 'react';
import { useLanguage } from '../contexts/LanguageContext';

const UPDATE_ITEM_IDS = [
  'session-persistence-full-coverage',
  'report-creation-sessions',
  'voice',
  'agents',
  'quality',
] as const;

function getWeekRange(locale: 'en' | 'ja' | 'zh'): string {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const loc = locale === 'ja' ? 'ja-JP' : locale === 'zh' ? 'zh-CN' : 'en-US';
  const fmt = (d: Date) =>
    d.toLocaleDateString(loc, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

const styles: { [key: string]: React.CSSProperties } = {
  wrapper: {
    marginBottom: '1.5rem',
    padding: '1.25rem 1.5rem',
    borderRadius: '12px',
    border: '1px solid rgba(17, 7, 74, 0.12)',
    backgroundColor: '#f8f9ff',
  },
  title: {
    margin: '0 0 0.5rem',
    fontSize: '0.85rem',
    fontWeight: '700',
    color: '#6c757d',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  weekRange: {
    margin: '0 0 1rem',
    fontSize: '0.95rem',
    color: '#4A4453',
    fontWeight: '500',
  },
  featuredBadge: {
    display: 'inline-block',
    marginBottom: '0.5rem',
    padding: '0.35rem 0.75rem',
    borderRadius: '20px',
    fontSize: '0.8rem',
    fontWeight: '700',
    color: '#fff',
    backgroundColor: '#11074A',
    letterSpacing: '0.02em',
  },
  item: {
    marginBottom: '0.85rem',
  },
  itemFirst: {
    marginBottom: '1rem',
    paddingBottom: '1rem',
    borderBottom: '1px solid rgba(17, 7, 74, 0.08)',
  },
  itemTitle: {
    margin: '0 0 0.25rem',
    fontSize: '1rem',
    fontWeight: '700',
    color: '#11074A',
    lineHeight: '1.35',
  },
  itemDescription: {
    margin: 0,
    fontSize: '0.95rem',
    color: '#4A4453',
    lineHeight: '1.5',
  },
};

const ThisWeekUpdatesPatch: React.FC = () => {
  const { t, locale } = useLanguage();
  const weekRange = getWeekRange(locale);

  return (
    <div style={styles.wrapper}>
      <p style={styles.title}>{t('home.updatesThisWeek.title')}</p>
      <p style={styles.weekRange}>{weekRange}</p>

      {UPDATE_ITEM_IDS.map((id, index) => {
        const featured = id === 'session-persistence-full-coverage';
        return (
          <div
            key={id}
            style={index === 0 ? { ...styles.item, ...styles.itemFirst } : styles.item}
          >
            {featured ? <span style={styles.featuredBadge}>{t('home.updatesThisWeek.featured')}</span> : null}
            <h3 style={styles.itemTitle}>{t(`home.updatesThisWeek.items.${id}.title`)}</h3>
            <p style={styles.itemDescription}>{t(`home.updatesThisWeek.items.${id}.description`)}</p>
          </div>
        );
      })}
    </div>
  );
};

export default ThisWeekUpdatesPatch;
