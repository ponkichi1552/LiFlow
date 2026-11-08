import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { AccordionSection } from '@/components/accordion-section';
import { AppButton, BackButton, Page, ScreenHeading, palette, typography } from '@/components/planner-ui';
import { HELP_SECTIONS } from '@/features/help/help-content';

export default function HelpScreen() {
  const params = useLocalSearchParams<{ section?: string }>();
  const selected = HELP_SECTIONS.find(section => section.title === params.section);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(selected ? [selected.title] : []));
  const sections = selected ? [selected, ...HELP_SECTIONS.filter(section => section !== selected)] : HELP_SECTIONS;
  return <Page header={<BackButton onPress={() => router.back()} />}>

    <ScreenHeading eyebrow="HELP" title="アプリの使い方" description="知りたい項目をタップして開いてください。" />
    {sections.map((section) => (
      <AccordionSection key={section.title} title={section.title} expanded={expanded.has(section.title)}
        onToggle={() => setExpanded((current) => {
          const next = new Set(current);
          if (next.has(section.title)) next.delete(section.title);
          else next.add(section.title);
          return next;
        })}>
        {section.paragraphs.map((paragraph) => <Text key={paragraph} style={styles.body}>{paragraph}</Text>)}
      </AccordionSection>
    ))}
    <AppButton title="設定を開く" onPress={() => router.push('/settings')} variant="secondary" />
  </Page>;
}

const styles = StyleSheet.create({ body: { ...typography.body, color: palette.ink } });
