import { StyleSheet, Text, View } from 'react-native';

import { colors } from './theme';

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {subtitle !== undefined && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
    gap: 8,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
});
