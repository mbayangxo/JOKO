import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from './PressScale';
import { fontFamily, radius, spacing, type } from '../theme';
import { ob } from '../theme/onboarding';

function SheetRow({ leading, title, subtitle, selected, onPress }) {
  return (
    <PressScale scaleTo={0.98} onPress={onPress}>
      <View style={[styles.row, selected && styles.rowSelected]}>
        <View style={styles.rowLeading}>
          <Text style={{ fontSize: 22 }}>{leading}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>{title}</Text>
          {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
        </View>
        {selected ? (
          <View style={styles.checkDot}>
            <Text style={{ fontSize: 10, fontWeight: '900', color: ob.ink }}>✓</Text>
          </View>
        ) : null}
      </View>
    </PressScale>
  );
}

/** Full-screen sheet: search + scrollable list. Used for pays / région / langue. */
export default function SearchPickerSheet({
  visible,
  title,
  searchPlaceholder,
  query,
  onChangeQuery,
  onClose,
  children,
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{title}</Text>
          <PressScale scaleTo={0.92} onPress={onClose} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Fermer">
            <Text style={styles.closeText}>✕</Text>
          </PressScale>
        </View>

        <View style={styles.searchWrap}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder={searchPlaceholder}
            placeholderTextColor={ob.faint}
            value={query}
            onChangeText={onChangeQuery}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export { SheetRow };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: ob.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.huge,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: ob.border,
  },
  headerTitle: { fontFamily: fontFamily.displayBlack, fontSize: 16, color: ob.ink, letterSpacing: -0.3 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    borderBottomRightRadius: 9,
    backgroundColor: ob.surface,
    borderWidth: 1,
    borderColor: ob.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { fontSize: 14, color: ob.muted, fontWeight: '700' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.huge,
    marginVertical: spacing.lg,
    height: 46,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.xl,
    borderBottomRightRadius: 10,
    backgroundColor: ob.surface,
    borderWidth: 1.5,
    borderColor: ob.border,
  },
  searchIcon: { fontSize: 14, opacity: 0.45 },
  searchInput: { flex: 1, fontFamily: fontFamily.bodyRegular, fontSize: 14, color: ob.ink, padding: 0 },
  listContent: { paddingBottom: spacing.giant },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
    marginHorizontal: spacing.huge,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderBottomRightRadius: 10,
    backgroundColor: ob.surface,
    borderWidth: 1,
    borderColor: ob.border,
  },
  rowSelected: { backgroundColor: ob.greenSoft, borderColor: ob.greenBorder },
  rowLeading: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderBottomRightRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ob.orangeSoft,
  },
  rowTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: ob.ink },
  rowSubtitle: { fontSize: 10, color: ob.faint, marginTop: 1 },
  checkDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: ob.green, alignItems: 'center', justifyContent: 'center' },
});
