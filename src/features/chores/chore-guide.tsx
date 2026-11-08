import { StyleSheet, Text, View } from 'react-native';
import { Card, ScreenHeading, SectionHeading, palette, typography } from '../../components/planner-ui';
import { ChoreMeta } from '../../components/chore-meta';
import { ProcedureStep } from '../../components/procedure-step';
import type { ChoreDefinition } from '../../domain/chores/types';
import type { ReactNode } from 'react';
export function ChoreGuide({ chore, mode, procedureAction, cadenceLabel }: { chore: ChoreDefinition; mode: import('@/domain/chores/types').FrequencyMode; procedureAction?: ReactNode; cadenceLabel?: string }) {
  const instructions = chore.instructions.filter(line => line.trim());
  const sections = chore.procedureSections?.map(section => ({ ...section, steps: section.steps.filter(line => line.trim()) })).filter(section => section.steps.length) ?? [];
  const tools = chore.tools.filter(line => line.trim()); const cautions = chore.cautions.filter(line => line.trim());
  const hasSteps = sections.length > 0 || instructions.length > 0;
  return (
    <>
      <ScreenHeading title={chore.name} />
      <ChoreMeta chore={chore} mode={mode} cadenceLabel={cadenceLabel} />
      {chore.schedulingNotes?.trim() ? <Text style={styles.notes}>{chore.schedulingNotes}</Text> : null}
      {chore.description?.trim() ? <Text style={styles.body}>{chore.description}</Text> : null}
      {hasSteps ? <Card>
        <SectionHeading title="家事の手順" trailing={procedureAction} />
        {sections.length ? sections.map((section) => (
          <View key={section.title} style={styles.procedureSection}>
            {section.title.trim() ? <Text style={styles.procedureTitle}>{section.title}</Text> : null}
            {section.steps.map((step, index) => <ProcedureStep key={`${index}-${step}`} step={step} index={index} />)}
          </View>
        )) : instructions.map((step, index) => (
          <ProcedureStep key={`${index}-${step}`} step={step} index={index} />
        ))}
      </Card> : procedureAction ? <View style={styles.procedureAction}>{procedureAction}</View> : null}
      {tools.length ? <Card>
        <SectionHeading title="必要な道具" />
        <View style={styles.toolList}>{tools.map((tool) => <Text key={tool} style={styles.toolText}>・{tool}</Text>)}</View>
      </Card> : null}
      {cautions.length ? <Card style={styles.cautionCard}>
        <Text style={styles.cautionHeading}>注意事項</Text>
        {cautions.map((caution) => <Text key={caution} style={styles.cautionText}>・{caution}</Text>)}
      </Card> : null}
      {chore.trivia?.length ? (
        <Card style={styles.triviaCard}>
          <Text style={styles.triviaHeading}>豆知識</Text>
          {chore.trivia.map((trivia) => (
            <View key={trivia.id} style={styles.triviaItem}>
              <Text style={styles.triviaTitle}>{trivia.title}</Text>
              <Text style={styles.triviaBody}>{trivia.body}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  notes: { ...typography.caption, color: palette.muted },
  procedureAction: { alignItems: 'flex-end', paddingVertical: 4 },
  body: { ...typography.body, color: palette.ink }, procedureSection: { gap: 10 },
  procedureTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  toolList: { gap: 6 }, toolText: { ...typography.body, color: palette.ink },
  cautionCard: { backgroundColor: palette.warningSoft }, cautionHeading: { ...typography.subheading, color: palette.warning, fontWeight: '700' }, cautionText: { ...typography.body, color: palette.ink },
  triviaCard: { backgroundColor: palette.accentSoft }, triviaHeading: { ...typography.subheading, color: palette.ink, fontWeight: '700' }, triviaItem: { gap: 6 }, triviaTitle: { ...typography.label, color: palette.ink, fontWeight: '700' }, triviaBody: { ...typography.body, color: palette.ink },
});
