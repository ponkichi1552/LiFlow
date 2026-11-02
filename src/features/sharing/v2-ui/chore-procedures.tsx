import { StyleSheet, Text, View } from 'react-native';
import { palette, SectionHeading, typography } from '../../../components/planner-ui';
import { ProcedureStep } from '../../../components/procedure-step';
import type { ChoreDefinition } from '../../../domain/chores/types';

/** Shared and private displays reuse the rendering, while their data and commands stay separate. */
export function V2ChoreProcedures({ chore }: { chore: Pick<ChoreDefinition, 'description' | 'instructions' | 'procedureSections' | 'tools' | 'cautions' | 'sourceNotes'> }) {
  const sections = chore.procedureSections?.length ? chore.procedureSections : [{ title: '', steps: chore.instructions }];
  return <View style={{ gap: 12 }}>{chore.description ? <Text style={styles.body}>{chore.description}</Text> : null}
    {sections.map((section, sectionIndex) => <View key={sectionIndex} style={{ gap: 8 }}>{section.title ? <SectionHeading title={section.title} level="subsection" /> : null}
      {section.steps.length ? section.steps.map((step, index) => <ProcedureStep key={index} step={step} index={index} />) : <Text style={styles.caption}>手順はまだ登録されていません。</Text>}
    </View>)}
    {chore.tools.length ? <View style={{ gap: 6 }}><SectionHeading title="使う道具" level="subsection" /><Text style={styles.body}>{chore.tools.join('・')}</Text></View> : null}
    {chore.cautions.length ? <View style={{ gap: 6 }}><SectionHeading title="注意点" level="subsection" />{chore.cautions.map((text, index) => <Text key={index} style={styles.body}>・{text}</Text>)}</View> : null}
  </View>;
}
const styles = StyleSheet.create({
  body: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 }, number: { ...typography.body, color: palette.accent, fontWeight: '700', width: 30 },
});
