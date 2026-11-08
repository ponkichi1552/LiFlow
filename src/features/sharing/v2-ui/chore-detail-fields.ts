import type { JsonValue } from '../operations';
import type { V2FieldCodec } from './field-editor-state';
import { parseSettingInteger } from '../../../domain/chores/settings-patch.ts';

export interface V2SectionDraft { title: string; text: string }
const text = (raw: JsonValue): string => { if (typeof raw !== 'string') throw new Error('文章を入力してください。'); return raw; };
const lines = (raw: JsonValue): string[] => {
  const values = text(raw).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (values.some((line) => line.length > 20000)) throw new Error('1項目は2万文字以内で入力してください。'); return values;
};
const lineCodec: V2FieldCodec = { format: (value) => Array.isArray(value) ? value.join('\n') : '', parse: lines };
export const v2ChoreDetailCodecs: Record<string, V2FieldCodec> = {
  estimatedMinutes: { format: value => typeof value === 'number' ? String(value) : '', parse: raw => {
    const minutes = parseSettingInteger(text(raw), 1, 1440); if (minutes === undefined) throw new Error('目安時間は1〜1440分で入力してください。'); return minutes;
  } },
  name: { format: (value) => typeof value === 'string' ? value : '', parse: (raw) => {
    const value = text(raw).trim(); if (!value || value.length > 500) throw new Error('家事名は1〜500文字で入力してください。'); return value;
  } },
  description: { format: (value) => typeof value === 'string' ? value : '', parse: (raw) => {
    const value = text(raw); if (value.length > 100000) throw new Error('説明は10万文字以内で入力してください。'); return value;
  } },
  instructions: lineCodec, tools: lineCodec, cautions: lineCodec,
  procedureSections: { format: (value) => Array.isArray(value) ? value.map((part) => {
    const section = part as { title: string; steps: string[] }; return { title: section.title, text: section.steps.join('\n') };
  }) : [], parse: (raw) => {
    if (!Array.isArray(raw)) throw new Error('手順の区分を確認してください。');
    return raw.map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part) || typeof part.title !== 'string' || typeof part.text !== 'string') throw new Error('手順の区分を確認してください。');
      if (!part.title.trim()) throw new Error('手順の区分に見出しを入力してください。');
      return { title: part.title.trim(), steps: lines(part.text) };
    });
  } },
};

export function v2DetailValueLabel(value: JsonValue): string {
  if (value === null) return '未設定';
  if (typeof value === 'string') return value || '（空欄）';
  if (Array.isArray(value)) return value.length ? value.map((part) => {
    if (typeof part === 'string') return `・${part}`;
    const section = part as { title?: string; steps?: string[] };
    return `${section.title ?? ''}\n${section.steps?.map((step) => `・${step}`).join('\n') ?? ''}`;
  }).join('\n') : '（項目なし）';
  return String(value);
}
