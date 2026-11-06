import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, typography } from '@/components/planner-ui';
import { AccordionSection } from '@/components/accordion-section';

function CreditLink({ title, url }: { title: string; url: string }) {
  const [failed, setFailed] = useState(false);
  return <View>
    <Pressable accessibilityRole="link" onPress={() => {
      setFailed(false);
      void Linking.openURL(url).catch(() => setFailed(true));
    }} style={styles.linkArea}><Text style={styles.link}>{title} ↗</Text></Pressable>
    {failed ? <Text style={styles.error}>リンクを開けませんでした。</Text> : null}
  </View>;
}

export function WeatherAttribution() {
  return <CreditLink title="Weather data: MET Norway · CC BY 4.0" url="https://www.met.no/en/free-meteorological-data/Licensing-and-crediting" />;
}

export function LocationAttribution() {
  return <CreditLink title="地域データ：Geolonia · CC BY 4.0" url="https://geolonia.github.io/japanese-addresses/" />;
}

export function DataCredits() {
  const [expanded, setExpanded] = useState(false);
  return <AccordionSection title="クレジット" expanded={expanded} onToggle={() => setExpanded((value) => !value)}>
    <WeatherAttribution />
    <LocationAttribution />
    <CreditLink title="データライセンス：CC BY 4.0" url="https://creativecommons.org/licenses/by/4.0/" />
    <Text style={styles.body}>MET Norwayの予報を時間帯ごとに集計します。Geolonia住所データを自治体ごとに集約し、地域の代表座標を丸めています。</Text>
  </AccordionSection>;
}

const styles = StyleSheet.create({
  linkArea: { minHeight: 44, justifyContent: 'center' },
  link: { ...typography.caption, color: palette.accent, fontWeight: '600', textDecorationLine: 'underline' },
  body: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning },
});
