import { useCallback, useEffect, useState } from 'react';
import {
  Animated,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import { useToast } from '../components/Toast';
import { useLocale } from '../context/LocaleContext';
import { useAppState } from '../state/AppState';
import { coordsFromArrondissement } from '../lib/dakar-coords';
import { colors, fontFamily, radius, spacing, type } from '../theme';
import { useEntrance } from '../hooks/animations';
import {
  acceptDelivery,
  createProduct,
  getMyActiveDeliveries,
  getNearbyDeliveries,
  getProducts,
  markDeliveryDelivered,
  markDeliveryPickup,
  registerDriverProfile,
  registerSellerProfile,
  requestDelivery,
} from '../lib/api-client';

const MODES = [
  { key: 'drive', label: 'Livraison' },
  { key: 'gigs', label: 'Gigs' },
];

function ModeSwitch({ mode, onChange }) {
  return (
    <View style={styles.modeTrack}>
      {MODES.map((item) => {
        const active = mode === item.key;
        return (
          <PressScale
            key={item.key}
            scaleTo={0.97}
            onPress={() => onChange(item.key)}
            style={[styles.modeBtn, active && styles.modeBtnOn]}
          >
            <Text style={[styles.modeBtnText, active && styles.modeBtnTextOn]}>{item.label}</Text>
          </PressScale>
        );
      })}
    </View>
  );
}

function ListRow({ icon, title, meta, tag, tagColor, delay, onPress }) {
  const entrance = useEntrance(delay, 350, 8);
  const body = (
    <Animated.View style={[styles.listRow, entrance]}>
      <View style={styles.listIcon}>
        <Text style={{ fontSize: 20 }}>{icon}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.listTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.listMeta}>{meta}</Text>
      </View>
      {tag ? (
        <View style={[styles.listTag, { backgroundColor: `${tagColor}20`, borderColor: `${tagColor}40` }]}>
          <Text style={[styles.listTagText, { color: tagColor }]}>{tag}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
  if (onPress) {
    return <PressScale scaleTo={0.98} onPress={onPress}>{body}</PressScale>;
  }
  return body;
}

function PostSheet({ visible, title, fields, submitLabel, loading, onClose, onSubmit }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.key, ''])));

  useEffect(() => {
    if (visible) setValues(Object.fromEntries(fields.map((f) => [f.key, ''])));
  }, [visible, fields]);

  const setField = (key, text) => setValues((prev) => ({ ...prev, [key]: text }));

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheetCard}>
          <Text style={styles.sheetTitle}>{title}</Text>
          {fields.map((field) => (
            <View key={field.key} style={{ gap: spacing.xs }}>
              <Text style={styles.sheetLabel}>{field.label}</Text>
              <TextInput
                style={styles.sheetInput}
                placeholder={field.placeholder}
                placeholderTextColor={colors.appCanvas.textFaint}
                value={values[field.key]}
                onChangeText={(text) => setField(field.key, text)}
                keyboardType={field.numeric ? 'number-pad' : 'default'}
                multiline={field.multiline}
              />
            </View>
          ))}
          <View style={styles.sheetActions}>
            <PressScale scaleTo={0.97} onPress={onClose} style={styles.sheetCancel}>
              <Text style={styles.sheetCancelText}>Annuler</Text>
            </PressScale>
            <PressScale
              scaleTo={0.97}
              onPress={() => onSubmit(values)}
              style={[styles.sheetSubmit, loading && { opacity: 0.6 }]}
            >
              <Text style={styles.sheetSubmitText}>{loading ? '…' : submitLabel}</Text>
            </PressScale>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function GigsPanel({ onPostGig, refreshKey }) {
  const [gigs, setGigs] = useState([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      getProducts('gig')
        .then((list) => {
          if (cancelled) return;
          setGigs(
            (Array.isArray(list) ? list : []).map((g) => ({
              key: g.id,
              icon: '💼',
              title: g.title,
              meta: g.description ?? 'Dakar · Flexible',
              pay: `${g.price.toLocaleString('fr-FR')} F`,
            })),
          );
        })
        .catch(() => setGigs([]))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [refreshKey]),
  );

  return (
    <View style={styles.panel}>
      <PressScale scaleTo={0.98} onPress={onPostGig} style={styles.postBtn}>
        <Text style={styles.postBtnIcon}>＋</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.postBtnTitle}>Publier un gig</Text>
          <Text style={styles.postBtnSub}>Propose une mission courte ou un petit boulot</Text>
        </View>
      </PressScale>
      <Text style={styles.sectionLabel}>Gigs disponibles</Text>
      {loading && <Text style={styles.emptyText}>Chargement…</Text>}
      {!loading && gigs.length === 0 && (
        <Text style={styles.emptyText}>Aucun gig publié pour l’instant.</Text>
      )}
      {gigs.map((item, i) => (
        <ListRow key={item.key} icon={item.icon} title={item.title} meta={item.meta} tag={item.pay} tagColor={colors.green} delay={i * 60} />
      ))}
    </View>
  );
}

function DrivePanel({ onRequestCourier, refreshKey, navigation, coords }) {
  const showToast = useToast();
  const [online, setOnline] = useState(false);
  const [activating, setActivating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [activeTasks, setActiveTasks] = useState([]);
  const [acceptingId, setAcceptingId] = useState(null);
  const [actionId, setActionId] = useState(null);

  const loadActive = useCallback(async () => {
    if (!online) {
      setActiveTasks([]);
      return;
    }
    try {
      const res = await getMyActiveDeliveries();
      setActiveTasks(Array.isArray(res?.deliveries) ? res.deliveries : []);
    } catch {
      setActiveTasks([]);
    }
  }, [online]);

  const loadJobs = useCallback(async () => {
    if (!online) {
      setJobs([]);
      return;
    }
    setLoading(true);
    try {
      const [list] = await Promise.all([
        getNearbyDeliveries({
          lat: coords?.lat,
          lng: coords?.lng,
        }),
        loadActive(),
      ]);
      setJobs(Array.isArray(list) ? list : []);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [online, coords?.lat, coords?.lng, loadActive]);

  useFocusEffect(
    useCallback(() => {
      loadJobs();
    }, [loadJobs, refreshKey]),
  );

  const toggleOnline = async (next) => {
    if (next) {
      setActivating(true);
      try {
        await registerDriverProfile({});
        setOnline(true);
        showToast('Mode livreur activé');
      } catch (err) {
        const msg = err.message ?? '';
        if (msg.includes('profil travailleur') || msg.includes('worker')) {
          navigation.navigate('WorkerProfile');
        } else {
          showToast(msg || 'Impossible d’activer le mode livreur');
        }
      } finally {
        setActivating(false);
      }
      return;
    }
    setOnline(false);
    setJobs([]);
  };

  const onAccept = async (jobId) => {
    setAcceptingId(jobId);
    try {
      await acceptDelivery(jobId);
      showToast('Course acceptée ✓');
      await loadJobs();
    } catch (err) {
      showToast(err.message ?? 'Acceptation impossible');
    } finally {
      setAcceptingId(null);
    }
  };

  const onPickup = async (taskId) => {
    setActionId(taskId);
    try {
      await markDeliveryPickup(taskId);
      showToast('Colis récupéré ✓');
      await loadJobs();
    } catch (err) {
      showToast(err.message ?? 'Impossible');
    } finally {
      setActionId(null);
    }
  };

  const onDeliver = async (taskId) => {
    setActionId(taskId);
    try {
      await markDeliveryDelivered(taskId);
      showToast('Livré — en attente confirmation client ✓');
      await loadJobs();
    } catch (err) {
      showToast(err.message ?? 'Impossible');
    } finally {
      setActionId(null);
    }
  };

  return (
    <View style={styles.panel}>
      <PressScale scaleTo={0.98} onPress={onRequestCourier} style={styles.postBtn}>
        <Text style={styles.postBtnIcon}>📦</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.postBtnTitle}>Demander un livreur</Text>
          <Text style={styles.postBtnSub}>Envoie un colis ou une commande à récupérer</Text>
        </View>
      </PressScale>

      <View style={styles.driveHero}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionLabel}>Mode livreur</Text>
          <Text style={styles.panelHint}>
            {online ? 'En ligne — les courses à proximité apparaissent ici.' : 'Passe en ligne pour accepter des livraisons.'}
          </Text>
        </View>
        <Switch
          value={online}
          onValueChange={toggleOnline}
          disabled={activating}
          trackColor={{ false: 'rgba(5,8,5,0.12)', true: colors.greenA25 }}
          thumbColor={online ? colors.green : colors.appCanvas.surface}
        />
      </View>

      {!online && (
        <View style={styles.offlineCard}>
          <Text style={styles.offlineEmoji}>🛵</Text>
          <Text style={styles.offlineTitle}>Hors ligne</Text>
          <Text style={styles.offlineSub}>Active le mode livreur pour gagner sur les courses près de toi.</Text>
        </View>
      )}

      {online && activeTasks.length > 0 ? (
        <View style={styles.activeBlock}>
          <Text style={styles.sectionLabel}>Mes courses en cours</Text>
          {activeTasks.map((task, i) => {
            const actionLabel =
              task.status === 'assigned'
                ? 'Marquer récupéré'
                : ['picked_up', 'in_transit'].includes(task.status)
                  ? 'Marquer livré'
                  : 'En attente client';
            const canAct =
              task.status === 'assigned' || ['picked_up', 'in_transit'].includes(task.status);
            return (
              <ListRow
                key={task.id}
                icon="🛵"
                title={task.pickupLabel ?? 'Collecte'}
                meta={`${task.dropoffArea ?? 'Dakar'} · ${task.status}${task.orderNotes ? ` · ${task.orderNotes}` : ''}`}
                tag={actionId === task.id ? '…' : actionLabel}
                tagColor={colors.green}
                delay={i * 40}
                onPress={
                  !canAct || actionId
                    ? undefined
                    : () => (task.status === 'assigned' ? onPickup(task.id) : onDeliver(task.id))
                }
              />
            );
          })}
        </View>
      ) : null}

      {online && loading && <Text style={styles.emptyText}>Recherche de courses…</Text>}
      {online && !loading && jobs.length === 0 && (
        <Text style={styles.emptyText}>Aucune course disponible pour le moment.</Text>
      )}
      {online &&
        jobs.map((job, i) => {
          const hubNote = job.hub?.name ? ` · ${job.hub.name}` : '';
          const summary = job.productSummary ? ` · ${job.productSummary}` : '';
          return (
            <ListRow
              key={job.id}
              icon={job.pickup?.type === 'hub_parcel' ? '📦' : job.pickup?.type === 'warehouse' ? '🏭' : job.pickup?.type === 'hub' ? '📍' : '📦'}
              title={job.pickup?.label ?? 'Collecte'}
              meta={`${job.dropoff?.area ?? 'Dakar'} · ${job.distanceLabel ?? '—'} · ${job.deliveryFeeNational?.toLocaleString('fr-FR') ?? '—'} F${hubNote}${summary}`}
              tag={acceptingId === job.id ? '…' : 'Accepter'}
              tagColor={colors.orange}
              delay={i * 60}
              onPress={acceptingId ? undefined : () => onAccept(job.id)}
            />
          );
        })}
    </View>
  );
}

export default function MovementScreen({ navigation, route }) {
  const showToast = useToast();
  const { profile } = useAppState();
  const riderCoords = coordsFromArrondissement(profile?.arrondissement?.key);
  const { showMovementTab, setShowMovementTab } = useLocale();
  const initialMode = route.params?.initialMode === 'gigs' ? 'gigs' : 'drive';
  const [mode, setMode] = useState(initialMode);
  const [refreshKey, setRefreshKey] = useState(0);
  const [gigSheetOpen, setGigSheetOpen] = useState(false);
  const [courierSheetOpen, setCourierSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (route.params?.initialMode) setMode(route.params.initialMode === 'gigs' ? 'gigs' : 'drive');
  }, [route.params?.initialMode]);

  const bump = () => setRefreshKey((k) => k + 1);

  const ensureSeller = async () => {
    try {
      await registerSellerProfile({ shopName: profile.name || 'Mon shop' });
    } catch (err) {
      const msg = err.message ?? '';
      if (msg.includes('profil travailleur') || msg.includes('worker')) {
        navigation.navigate('WorkerProfile');
        throw err;
      }
      /* seller profile may already exist */
    }
  };

  const submitGig = async (values) => {
    const title = values.title?.trim();
    const price = parseInt(values.price, 10);
    if (!title || !Number.isFinite(price) || price <= 0) {
      showToast('Titre et prix requis');
      return;
    }
    setSubmitting(true);
    try {
      await ensureSeller();
      await createProduct({
        title,
        description: values.description?.trim() || undefined,
        price,
        category: 'gig',
      });
      showToast('Gig publié ✓');
      setGigSheetOpen(false);
      bump();
    } catch (err) {
      const msg = err.message ?? '';
      if (msg.includes('profil travailleur') || msg.includes('worker')) {
        navigation.navigate('WorkerProfile');
      } else {
        showToast(msg || 'Publication impossible');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitCourier = async (values) => {
    const pickupLabel = values.pickupLabel?.trim();
    const pickupAddress = values.pickupAddress?.trim();
    const dropoffArea = values.dropoffArea?.trim();
    const dropoffAddress = values.dropoffAddress?.trim();
    if (!pickupLabel || !pickupAddress || !dropoffArea || !dropoffAddress) {
      showToast('Remplis tous les champs');
      return;
    }
    setSubmitting(true);
    try {
      await requestDelivery({ pickupLabel, pickupAddress, dropoffArea, dropoffAddress });
      showToast('Demande envoyée — un livreur peut accepter');
      setCourierSheetOpen(false);
      bump();
    } catch (err) {
      showToast(err.message ?? 'Demande impossible');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <View style={styles.headerTop}>
            {navigation.canGoBack() ? (
              <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn}>
                <Text style={{ fontSize: 16, color: colors.ink }}>←</Text>
              </PressScale>
            ) : null}
            <Text style={styles.title}>Mouvement</Text>
          </View>
          <Text style={styles.subtitle}>Livraison, courses et petits boulots</Text>
          <ModeSwitch mode={mode} onChange={setMode} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: spacing.giant + 20 }}
          showsVerticalScrollIndicator={false}
        >
          {mode === 'drive' ? (
            <View style={styles.panel}>
              {/* J8: verified, ASSIGNED deliveries — the open-claim courier marketplace is closed to new requests (D41). */}
              <PressScale scaleTo={0.98} onPress={() => navigation.navigate('CourierWork')} style={styles.postBtn}>
                <Text style={styles.postBtnIcon}>🛵</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.postBtnTitle}>Mes livraisons attribuées</Text>
                  <Text style={styles.postBtnSub}>Codes d’enlèvement et de livraison · gains et retenues</Text>
                </View>
              </PressScale>
              <PressScale scaleTo={0.98} onPress={() => navigation.navigate('Deliveries')} style={styles.postBtn}>
                <Text style={styles.postBtnIcon}>📦</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.postBtnTitle}>Mes réceptions</Text>
                  <Text style={styles.postBtnSub}>Ce qui arrive pour moi ou mon commerce</Text>
                </View>
              </PressScale>
            </View>
          ) : null}
          {mode === 'drive' ? (
            <DrivePanel
              onRequestCourier={() => {
                showToast('Les courses libres sont fermées : la livraison se demande avec ta commande, et elle est prouvée par ton code.');
                navigation.navigate('Deliveries');
              }}
              refreshKey={refreshKey}
              navigation={navigation}
              coords={riderCoords}
            />
          ) : (
            <GigsPanel onPostGig={() => setGigSheetOpen(true)} refreshKey={refreshKey} />
          )}

          <View style={styles.pinRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.pinTitle}>Onglet Mouvement</Text>
              <Text style={styles.pinSub}>Afficher dans la barre du bas si tu livres souvent</Text>
            </View>
            <Switch
              value={showMovementTab}
              onValueChange={setShowMovementTab}
              trackColor={{ false: 'rgba(5,8,5,0.12)', true: colors.greenA25 }}
              thumbColor={showMovementTab ? colors.green : colors.appCanvas.surface}
            />
          </View>
        </ScrollView>
      </SafeAreaView>

      <PostSheet
        visible={gigSheetOpen}
        title="Publier un gig"
        submitLabel="Publier"
        loading={submitting}
        onClose={() => setGigSheetOpen(false)}
        onSubmit={submitGig}
        fields={[
          { key: 'title', label: 'Titre', placeholder: 'Ex: Aide déménagement 2h' },
          { key: 'description', label: 'Description', placeholder: 'Détails, lieu, horaire…', multiline: true },
          { key: 'price', label: 'Rémunération (F CFA)', placeholder: '5000', numeric: true },
        ]}
      />

      <PostSheet
        visible={courierSheetOpen}
        title="Demander un livreur"
        submitLabel="Envoyer la demande"
        loading={submitting}
        onClose={() => setCourierSheetOpen(false)}
        onSubmit={submitCourier}
        fields={[
          { key: 'pickupLabel', label: 'Point de collecte', placeholder: 'Ex: Boutique Sandaga' },
          { key: 'pickupAddress', label: 'Adresse de collecte', placeholder: 'Rue, quartier…' },
          { key: 'dropoffArea', label: 'Quartier de livraison', placeholder: 'Ex: Almadies' },
          { key: 'dropoffAddress', label: 'Adresse de livraison', placeholder: 'Rue, repère…' },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: {
    paddingHorizontal: spacing.huge,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.appCanvas.border,
    backgroundColor: colors.orangeA08,
  },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    backgroundColor: colors.appCanvas.surface,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 22, letterSpacing: -0.6, color: colors.ink },
  subtitle: { fontSize: 12, color: colors.appCanvas.textMuted, marginTop: -4 },
  modeTrack: {
    flexDirection: 'row',
    backgroundColor: colors.appCanvas.surface,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    borderRadius: radius.round,
    padding: 3,
    marginTop: spacing.sm,
  },
  modeBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md, borderRadius: radius.round },
  modeBtnOn: { backgroundColor: colors.ink },
  modeBtnText: { fontFamily: fontFamily.bodyBold, fontSize: 12, color: colors.appCanvas.textMuted },
  modeBtnTextOn: { color: colors.white },
  panel: { paddingHorizontal: spacing.huge, paddingTop: spacing.lg, gap: spacing.sm },
  activeBlock: { marginBottom: spacing.md, gap: spacing.xs },
  sectionLabel: { ...type.eyebrow, color: colors.appCanvas.textFaint },
  panelHint: { fontSize: 11, color: colors.appCanvas.textMuted, marginBottom: spacing.sm },
  emptyText: { fontSize: 12, color: colors.appCanvas.textFaint, paddingVertical: spacing.lg },
  postBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: colors.appCanvas.surface,
    borderWidth: 1.5,
    borderColor: colors.greenA25,
    borderRadius: radius.xxl,
    padding: spacing.xl,
    marginBottom: spacing.md,
  },
  postBtnIcon: { fontSize: 22, color: colors.greenDark },
  postBtnTitle: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  postBtnSub: { fontSize: 11, color: colors.appCanvas.textMuted, marginTop: 2 },
  driveHero: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.md },
  offlineCard: {
    alignItems: 'center',
    backgroundColor: colors.appCanvas.surface,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    borderRadius: radius.xxl,
    padding: spacing.xxxl,
    marginTop: spacing.md,
  },
  offlineEmoji: { fontSize: 40, marginBottom: spacing.md },
  offlineTitle: { fontFamily: fontFamily.displayBold, fontSize: 16, color: colors.ink, marginBottom: spacing.xs },
  offlineSub: { fontSize: 12, color: colors.appCanvas.textMuted, textAlign: 'center', lineHeight: 18 },
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginHorizontal: spacing.huge,
    marginTop: spacing.xxxl,
    padding: spacing.xl,
    backgroundColor: colors.appCanvas.surface,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    borderRadius: radius.xxl,
  },
  pinTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  pinSub: { fontSize: 10, color: colors.appCanvas.textFaint, marginTop: 2 },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: colors.appCanvas.surface,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  listIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    backgroundColor: colors.greenA08,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listTitle: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.appCanvas.text },
  listMeta: { fontSize: 10, color: colors.appCanvas.textFaint, marginTop: 2 },
  listTag: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 4 },
  listTagText: { fontSize: 9, fontWeight: '700' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(5,8,5,0.45)', justifyContent: 'flex-end' },
  sheetCard: {
    backgroundColor: colors.appCanvas.base,
    borderTopLeftRadius: radius.xxxl,
    borderTopRightRadius: radius.xxxl,
    padding: spacing.huge,
    gap: spacing.lg,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  sheetTitle: { fontFamily: fontFamily.displayBold, fontSize: 18, color: colors.ink },
  sheetLabel: { fontSize: 10, fontWeight: '700', color: colors.appCanvas.textFaint, textTransform: 'uppercase', letterSpacing: 0.8 },
  sheetInput: {
    backgroundColor: colors.appCanvas.surface,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    fontSize: 14,
    color: colors.ink,
  },
  sheetActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  sheetCancel: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.appCanvas.border,
  },
  sheetCancelText: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.appCanvas.textMuted },
  sheetSubmit: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.green,
  },
  sheetSubmitText: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
});
