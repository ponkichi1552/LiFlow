import { StyleSheet, Text, View } from 'react-native';
import { Card, ScreenHeading, SectionHeading, palette, typography } from '../../components/planner-ui';
import { ChoreMeta } from '../../components/chore-meta';
import { ProcedureStep } from '../../components/procedure-step';
import { ChoreSourceLinks } from '../../components/chore-source-links';
import type { ChoreDefinition } from '../../domain/chores/types';
import type { ReactNode } from 'react';
export function ChoreGuide({ chore, mode, procedureAction }: { chore: ChoreDefinition; mode: import('@/domain/chores/types').FrequencyMode; procedureAction?: ReactNode }) {
  return (
    <>
      <ScreenHeading title={chore.name} />
      <ChoreMeta chore={chore} mode={mode} />
      {chore.description ? <Text style={styles.body}>{chore.description}</Text> : null}
      <Card>
        <SectionHeading title="家事の手順" trailing={procedureAction} />
        {chore.procedureSections?.length ? chore.procedureSections.map((section) => (
          <View key={section.title} style={styles.procedureSection}>
            <Text style={styles.procedureTitle}>{section.title}</Text>
            {section.steps.map((step, index) => <ProcedureStep key={`${index}-${step}`} step={step} index={index} />)}
          </View>
        )) : chore.instructions.length > 0 ? chore.instructions.map((step, index) => (
          <ProcedureStep key={`${index}-${step}`} step={step} index={index} />
        )) : <Text style={styles.body}>手順はまだ登録されていません。</Text>}
        <ChoreSourceLinks key={chore.id} sources={chore.sourceNotes} />
      </Card>
      <Card>
        <SectionHeading title="必要な道具" />
        {chore.tools.length > 0
          ? <View style={styles.toolList}>{chore.tools.map((tool) => <Text key={tool} style={styles.toolText}>・{tool}</Text>)}</View>
          : <Text style={styles.body}>道具は特にありません。</Text>}
      </Card>
      <Card style={styles.cautionCard}>
        <Text style={styles.cautionHeading}>注意事項</Text>
        {chore.cautions.length > 0
          ? chore.cautions.map((caution) => <Text key={caution} style={styles.cautionText}>・{caution}</Text>)
          : <Text style={styles.body}>注意事項はありません。</Text>}
      </Card>
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
  body: { ...typography.body, color: palette.ink }, procedureSection: { gap: 10 },
  procedureTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  toolList: { gap: 6 }, toolText: { ...typography.body, color: palette.ink },
  cautionCard: { backgroundColor: palette.warningSoft }, cautionHeading: { ...typography.subheading, color: palette.warning, fontWeight: '700' }, cautionText: { ...typography.body, color: palette.ink },
  triviaCard: { backgroundColor: palette.accentSoft }, triviaHeading: { ...typography.subheading, color: palette.ink, fontWeight: '700' }, triviaItem: { gap: 6 }, triviaTitle: { ...typography.label, color: palette.ink, fontWeight: '700' }, triviaBody: { ...typography.body, color: palette.ink },
});
