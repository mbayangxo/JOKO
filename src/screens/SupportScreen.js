import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import { useToast } from '../components/Toast';
import {
  getSupportContact,
  getMySupportTickets,
  createSupportTicket,
  getSupportTicket,
  replySupportTicket,
} from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

export default function SupportScreen({ navigation }) {
  const showToast = useToast();
  const [loading, setLoading] = useState(true);
  const [contact, setContact] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, t] = await Promise.all([getSupportContact(), getMySupportTickets()]);
      setContact(c);
      setTickets(t.tickets ?? []);
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const openTicket = async (id) => {
    setSelectedId(id);
    try {
      const t = await getSupportTicket(id);
      setDetail(t);
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    }
  };

  const submitTicket = async () => {
    if (!subject.trim() || body.trim().length < 10) {
      showToast('Sujet + message (10 caractères min)');
      return;
    }
    setSubmitting(true);
    try {
      await createSupportTicket({ subject: subject.trim(), body: body.trim() });
      showToast('Demande envoyée ✓');
      setSubject('');
      setBody('');
      await load();
    } catch (err) {
      showToast(err.message ?? 'Envoi impossible');
    } finally {
      setSubmitting(false);
    }
  };

  const sendReply = async () => {
    if (!selectedId || !reply.trim()) return;
    setSubmitting(true);
    try {
      await replySupportTicket(selectedId, { body: reply.trim() });
      setReply('');
      await openTicket(selectedId);
      showToast('Message envoyé');
    } catch (err) {
      showToast(err.message ?? 'Erreur');
    } finally {
      setSubmitting(false);
    }
  };

  const dialCs = () => {
    const phone = contact?.phone?.replace(/\s/g, '');
    if (phone) Linking.openURL(`tel:${phone}`).catch(() => showToast('Impossible d’ouvrir le téléphone'));
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => (selectedId ? (setSelectedId(null), setDetail(null)) : navigation.goBack())} style={styles.backBtn}>
            <Text style={{ fontSize: 16 }}>←</Text>
          </PressScale>
          <Text style={styles.title}>{selectedId ? 'Conversation' : 'Aide & Support'}</Text>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.green} style={{ marginTop: 40 }} />
        ) : selectedId && detail ? (
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.ref}>{detail.subject} · {detail.status}</Text>
            {(detail.messages ?? []).map((m) => (
              <View key={m.id} style={[styles.msg, m.authorType === 'user' ? styles.msgUser : styles.msgAdmin]}>
                <Text style={styles.msgBody}>{m.body}</Text>
                <Text style={styles.msgMeta}>{new Date(m.createdAt).toLocaleString('fr-FR')}</Text>
              </View>
            ))}
            {!['closed', 'resolved'].includes(detail.status) ? (
              <>
                <TextInput accessibilityLabel="Ta réponse"
                  style={[styles.input, { minHeight: 80 }]}
                  multiline
                  placeholder="Ta réponse…"
                  placeholderTextColor="rgba(5,8,5,0.4)"
                  value={reply}
                  onChangeText={setReply}
                />
                <GlowButton label={submitting ? '…' : 'Envoyer'} onPress={sendReply} disabled={submitting} />
              </>
            ) : null}
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Contacter K21</Text>
              <Text style={styles.cardSub}>{contact?.hours ?? 'Lun–Sam 8h–20h'}</Text>
              <PressScale scaleTo={0.98} onPress={dialCs} style={styles.phoneRow}>
                <Text style={styles.phone}>📞 {contact?.phone ?? '+221 33 000 00 00'}</Text>
              </PressScale>
              {contact?.email ? <Text style={styles.cardSub}>{contact.email}</Text> : null}
            </View>

            <Text style={styles.sectionLabel}>Nouvelle demande</Text>
            <TextInput accessibilityLabel="Sujet" style={styles.input} placeholder="Sujet" value={subject} onChangeText={setSubject} placeholderTextColor="rgba(5,8,5,0.4)" />
            <TextInput accessibilityLabel="Décris ton problème"
              style={[styles.input, { minHeight: 100 }]}
              multiline
              placeholder="Décris ton problème…"
              value={body}
              onChangeText={setBody}
              placeholderTextColor="rgba(5,8,5,0.4)"
            />
            <GlowButton label={submitting ? 'Envoi…' : 'Ouvrir un ticket'} onPress={submitTicket} disabled={submitting} />

            <Text style={[styles.sectionLabel, { marginTop: spacing.lg }]}>Mes demandes</Text>
            {tickets.length === 0 ? (
              <Text style={styles.empty}>Aucune demande ouverte.</Text>
            ) : (
              tickets.map((t) => (
                <PressScale key={t.id} scaleTo={0.98} style={styles.ticketRow} onPress={() => openTicket(t.id)}>
                  <Text style={styles.ticketTitle}>{t.subject}</Text>
                  <Text style={styles.ticketMeta}>{t.status} · {new Date(t.updatedAt).toLocaleDateString('fr-FR')}</Text>
                </PressScale>
              ))
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.huge },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  body: { padding: spacing.huge, gap: spacing.md, paddingBottom: 80 },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: colors.appCanvas.border },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 16, color: colors.ink },
  cardSub: { ...type.caption, color: 'rgba(5,8,5,0.55)' },
  phoneRow: { marginTop: spacing.sm },
  phone: { fontFamily: fontFamily.displayBlack, fontSize: 18, color: colors.greenDark },
  sectionLabel: { ...type.caption, color: 'rgba(5,8,5,0.55)', textTransform: 'uppercase' },
  input: { borderWidth: 1, borderColor: colors.appCanvas.border, borderRadius: radius.md, padding: spacing.md, fontFamily: fontFamily.bodyRegular, color: colors.ink, backgroundColor: colors.appCanvas.surface },
  empty: { ...type.body, color: 'rgba(5,8,5,0.5)' },
  ticketRow: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.appCanvas.border },
  ticketTitle: { fontFamily: fontFamily.bodyBold, color: colors.ink },
  ticketMeta: { ...type.caption, color: 'rgba(5,8,5,0.5)', marginTop: 4 },
  ref: { ...type.caption, color: 'rgba(5,8,5,0.55)' },
  msg: { borderRadius: radius.md, padding: spacing.md, maxWidth: '92%' },
  msgUser: { alignSelf: 'flex-end', backgroundColor: 'rgba(26,240,96,0.12)' },
  msgAdmin: { alignSelf: 'flex-start', backgroundColor: colors.appCanvas.surface, borderWidth: 1, borderColor: colors.appCanvas.border },
  msgBody: { ...type.body, color: colors.ink },
  msgMeta: { ...type.caption, color: 'rgba(5,8,5,0.45)', marginTop: 4 },
});
