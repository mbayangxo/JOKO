import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import GlowButton from '../components/GlowButton';
import ScreenBackground from '../components/ScreenBackground';
import ScreenHeader from '../components/ScreenHeader';
import { useToast } from '../components/Toast';
import { createEvent } from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

export default function EventCreateScreen({ navigation }) {
  const showToast = useToast();
  const [title, setTitle] = useState('');
  const [venue, setVenue] = useState('');
  const [description, setDescription] = useState('');
  const [ticketPrice, setTicketPrice] = useState('5000');
  const [capacity, setCapacity] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const price = Number(ticketPrice);
    const cap = capacity ? Number(capacity) : undefined;
    const startsAt = dateStr ? new Date(dateStr).toISOString() : null;
    if (!title.trim() || !startsAt || !Number.isFinite(price)) {
      showToast('Titre, date et prix requis');
      return;
    }
    setSubmitting(true);
    try {
      await createEvent({
        title: title.trim(),
        description: description.trim() || undefined,
        venue: venue.trim() || undefined,
        ticketPrice: price,
        capacity: cap,
        startsAt,
      });
      showToast('Événement publié ✦');
      navigation.replace('EventScanner');
    } catch (e) {
      showToast(e.message ?? 'Erreur');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ScreenHeader onBack={() => navigation.goBack()} title="Créer un événement" style={styles.header} />
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.hero}>Ton event,{'\n'}tes billets.</Text>
          <TextInput accessibilityLabel="Titre" value={title} onChangeText={setTitle} placeholder="Titre" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
          <TextInput accessibilityLabel="Lieu" value={venue} onChangeText={setVenue} placeholder="Lieu" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
          <TextInput accessibilityLabel="Description" value={description} onChangeText={setDescription} placeholder="Description" style={[styles.input, styles.multi]} multiline placeholderTextColor="rgba(5,8,5,0.35)" />
          <TextInput accessibilityLabel="Date ISO (2026-08-01T20:00:00Z)" value={dateStr} onChangeText={setDateStr} placeholder="Date ISO (2026-08-01T20:00:00Z)" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
          <TextInput accessibilityLabel="Prix billet (C̶)" value={ticketPrice} onChangeText={setTicketPrice} placeholder="Prix billet (C̶)" keyboardType="number-pad" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
          <TextInput accessibilityLabel="Capacité (optionnel)" value={capacity} onChangeText={setCapacity} placeholder="Capacité (optionnel)" keyboardType="number-pad" style={styles.input} placeholderTextColor="rgba(5,8,5,0.35)" />
          <GlowButton label={submitting ? 'Publication…' : 'Publier l\'événement'} onPress={submit} disabled={submitting} tone="orange" />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f2f8ec' },
  header: { paddingHorizontal: spacing.lg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.huge },
  hero: { fontFamily: fontFamily.displayBlack, fontSize: 28, color: colors.terracotta, marginBottom: spacing.lg },
  input: { borderWidth: 1, borderColor: 'rgba(5,8,5,0.1)', borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, fontFamily: fontFamily.bodyRegular, color: colors.ink, backgroundColor: 'rgba(255,255,255,0.9)' },
  multi: { minHeight: 80, textAlignVertical: 'top' },
});
