// Class glyph badges, status pills, and inline SVG icons for the AI Analysis view.
// Ported from the Claude Design mockup; colors are the Blizzard class palette.

import { fmtTime } from '../../../../utils/cooldowns';
import { FindingConfidence, FindingSeverity } from '../aiFindings';
import { ClassKey } from '../matchAnalysisData';

export const CLASS_COLOR: Record<ClassKey, string> = {
  deathknight: '#C41E3A',
  demonhunter: '#A330C9',
  druid: '#FF7D0A',
  evoker: '#33937F',
  hunter: '#A9D271',
  mage: '#40C7EB',
  monk: '#00FF98',
  paladin: '#F58CBA',
  priest: '#FFFFFF',
  rogue: '#FFF569',
  shaman: '#0070DE',
  warlock: '#8787ED',
  warrior: '#C79C6E',
  unknown: '#888888',
};

// Disambiguated initials — Mage/Monk and Paladin/Priest collide on a single letter.
export const CLASS_GLYPH: Record<ClassKey, string> = {
  hunter: 'Hu',
  monk: 'Mo',
  priest: 'Pr',
  paladin: 'Pa',
  warrior: 'Wa',
  mage: 'Mg',
  rogue: 'Ro',
  warlock: 'Wl',
  shaman: 'Sh',
  druid: 'Dr',
  deathknight: 'DK',
  demonhunter: 'DH',
  evoker: 'Ev',
  unknown: '?',
};

type GlyphSize = 'sm' | 'md' | 'lg';

export function ClassGlyph({ cls, size = 'md', title }: { cls: ClassKey; size?: GlyphSize; title?: string }) {
  const px = size === 'sm' ? 20 : size === 'md' ? 26 : 34;
  const fs = size === 'sm' ? 9.5 : size === 'md' ? 11 : 13;
  const color = CLASS_COLOR[cls] ?? CLASS_COLOR.unknown;
  const glyph = CLASS_GLYPH[cls] ?? '?';
  return (
    <span
      title={title || cls}
      className="inline-flex items-center justify-center rounded-md font-bold shrink-0"
      style={{
        width: px,
        height: px,
        background: `linear-gradient(135deg, ${color}33, ${color}11)`,
        border: `1px solid ${color}66`,
        color,
        fontSize: fs,
        letterSpacing: '-0.02em',
        fontFamily: 'var(--ai-font-display)',
      }}
    >
      {glyph}
    </span>
  );
}

interface IconProps {
  size?: number;
  className?: string;
}

export function CCIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 4.5V8L10.5 9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function BoltIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M9 1.5L3 9h4l-1 5.5L13 7H9l1-5.5z" fill="currentColor" />
    </svg>
  );
}

export function ShieldIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5L2.5 3v5c0 3 2.5 5.5 5.5 6.5C11 13.5 13.5 11 13.5 8V3L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="none"
      />
    </svg>
  );
}

export function SwordIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M13.5 2.5L8 8M8 8l-1.5 1.5M8 8L9.5 9.5M3 13l2.5-2.5M11 5l1-2.5L14.5 1.5 13 4 11 5z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PurgeIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />
    </svg>
  );
}

export function SparkleIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 1L9.2 6.8L15 8L9.2 9.2L8 15L6.8 9.2L1 8L6.8 6.8L8 1Z" fill="currentColor" />
    </svg>
  );
}

export function ChevronDown({ size = 14, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CopyIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="5" y="3" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M11 3V2a1 1 0 00-1-1H3a1 1 0 00-1 1v9a1 1 0 001 1h1"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function RefreshIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M2 8a6 6 0 0110-4.5M14 8a6 6 0 01-10 4.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="M11 2v2h-2M5 14v-2h2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ArrowRight({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TargetIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

export function ConfidencePill({ value }: { value: FindingConfidence }) {
  const map: Record<FindingConfidence, { bg: string; fg: string; border: string }> = {
    High: { bg: 'rgba(34,197,94,0.10)', fg: '#7ee0a0', border: 'rgba(34,197,94,0.35)' },
    Medium: { bg: 'rgba(245,158,11,0.10)', fg: '#fbbf6b', border: 'rgba(245,158,11,0.35)' },
    Low: { bg: 'rgba(244,63,94,0.10)', fg: '#f4a4a0', border: 'rgba(244,63,94,0.35)' },
  };
  const c = map[value] ?? map.Medium;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10.5px] uppercase tracking-[0.08em] font-semibold"
      style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.fg }} />
      {value} confidence
    </span>
  );
}

export const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  Critical: '#ff5a4a',
  High: '#f97316',
  Medium: '#facc15',
  Low: '#60a5fa',
};

export function SeverityDot({ value }: { value: FindingSeverity }) {
  const color = SEVERITY_COLOR[value] ?? '#888';
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] font-semibold"
      style={{ color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}aa` }} />
      {value}
    </span>
  );
}

export function TimePill({ secs }: { secs: number }) {
  return (
    <span className="font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-[#0e0e10] border border-zinc-800 text-zinc-300 tabular-nums">
      {fmtTime(secs)}
    </span>
  );
}

export function PlayIcon({ size = 14, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}
