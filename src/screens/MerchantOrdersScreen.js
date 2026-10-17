import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import PressScale from '../components/PressScale';
import ScreenBackground from '../components/ScreenBackground';
import GlowButton from '../components/GlowButton';
import StepUpOverlay from '../components/StepUpOverlay';
import { useToast } from '../components/Toast';
import { useSecurity } from '../context/SecurityContext';
import {
  getMerchantOrders,
  getMyMarketplaceOrders,
  updateMarketplaceOrderStatus,
  confirmMarketplaceOrder,
} from '../lib/api-client';
import { colors, fontFamily, radius, spacing, type } from '../theme';

const STATUS_ACTIONS = {
  confirmed: [{ key: 'preparing', label: 'Préparer' }],
  pending_payment: [{ key: 'preparing', label: 'Préparer' }],
  preparing: [
    { key: 'out_for_delivery', label: 'Expédier' },
    { key: 'ready_for_pickup', label: 'Prête au retrait' },
  ],
  pending_delivery: [{ key: 'preparing', label: 'Préparer' }],
};

function OrderCard({ order, mode, onAction, onConfirm, busy }) {
  const actions = mode === 'merchant' ? STATUS_ACTIONS[order.status] ?? [] : [];
  const canConfirmBuyer =
    mode === 'buyer' &&
    ['delivered', 'ready_for_pickup'].includes(order.status) &&
    !(order.paymentTerm === 'cod' && order.paymentStatus === 'paid' && order.status === 'completed');
  const confirmLabel =
    order.paymentTerm === 'cod' && order.paymentStatus === 'pending'
      ? 'Confirmer et payer'
      : 'Confirmer réception';

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle}>{order.business?.name ?? order.buyer?.name ?? 'Commande'}</Text>
        <Text style={styles.cardAmount}>{order.totalFormatted}</Text>
      </View>
      <Text style={styles.cardMeta}>
        {order.channel?.toUpperCase?.() ?? 'B2C'} · {order.paymentTerm} · {order.paymentStatus} · {order.status}
      </Text>
      {order.preferredDeliveryDate ? (
        <Text style={styles.cardMeta}>Livraison souhaitée · {order.preferredDeliveryDate}</Text>
      ) : null}
      {order.paymentTerm === 'cod' && order.paymentStatus === 'pending' ? (
        <Text style={styles.cardMeta}>💵 Paiement à la livraison — en attente</Text>
      ) : null}
      {order.invoice ? (
        <Text style={styles.cardMeta}>Facture {order.invoice.reference} · {order.invoice.status}</Text>
      ) : null}
      {order.items?.map((li) => (
        <Text key={li.id} style={styles.lineItem}>
          {li.quantity}× {li.product?.title ?? 'Article'}
        </Text>
      ))}
      {order.delivery ? (
        <Text style={styles.cardMeta}>Livraison · {order.delivery.status} · {order.delivery.pickupLabel}</Text>
      ) : null}
      <Text style={styles.date}>{new Date(order.createdAt).toLocaleString('fr-FR')}</Text>
      <View style={styles.actions}>
        {actions.map((a) => (
          <PressScale
            key={a.key}
            scaleTo={0.95}
            disabled={busy}
            onPress={() => onAction(order.id, a.key)}
            style={styles.actionBtn}
          >
            <Text style={styles.actionText}>{a.label}</Text>
          </PressScale>
        ))}
        {canConfirmBuyer ? (
          <PressScale scaleTo={0.95} disabled={busy} onPress={() => onConfirm(order.id)} style={styles.actionBtnPrimary}>
            <Text style={styles.actionTextPrimary}>{confirmLabel}</Text>
          </PressScale>
        ) : null}
      </View>
    </View>
  );
}

export default function MerchantOrdersScreen({ navigation, route }) {
  const showToast = useToast();
  const security = useSecurity();
  const [stepUpVisible, setStepUpVisible] = useState(false);
  const businessId = route.params?.businessId;
  const mode = route.params?.mode ?? (businessId ? 'merchant' : 'buyer');
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data =
        mode === 'merchant' && businessId
          ? await getMerchantOrders(businessId)
          : await getMyMarketplaceOrders();
      setOrders(data.orders ?? []);
    } finally {
      setLoading(false);
    }
  }, [businessId, mode]);

  useEffect(() => {
    load();
  }, [load]);

  const runStatusUpdate = async (orderId, status, stepUpToken) => {
    setBusy(true);
    try {
      await updateMarketplaceOrderStatus(orderId, status);
      showToast('Commande mise à jour ✓');
      await load();
    } catch (err) {
      if (err.code === 'step_up_required') {
        setPendingAction({ type: 'status', orderId, status });
        setStepUpVisible(true);
        return;
      }
      showToast(err.message ?? 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async (orderId, stepUpToken) => {
    setBusy(true);
    try {
      await confirmMarketplaceOrder(orderId, { stepUpToken: stepUpToken ?? security.stepUpToken });
      showToast('Commande terminée ✓');
      await load();
    } catch (err) {
      if (err.code === 'step_up_required') {
        setPendingAction({ type: 'confirm', orderId });
        setStepUpVisible(true);
        return;
      }
      showToast(err.message ?? 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Retour">
            <Text style={{ fontSize: 18 }}>←</Text>
          </PressScale>
          <Text style={styles.title}>{mode === 'merchant' ? 'Commandes reçues' : 'Mes commandes'}</Text>
        </View>
        {loading ? (
          <ActivityIndicator color={colors.greenDark} style={{ marginTop: 40 }} />
        ) : orders.length === 0 ? (
          <Text style={styles.empty}>Aucune commande pour le moment.</Text>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            {orders.map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                mode={mode}
                busy={busy}
                onAction={runStatusUpdate}
                onConfirm={runConfirm}
              />
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
      <StepUpOverlay
        visible={stepUpVisible}
        onCancel={() => {
          setStepUpVisible(false);
          setPendingAction(null);
        }}
        onVerified={(token) => {
          setStepUpVisible(false);
          if (pendingAction?.type === 'status') {
            runStatusUpdate(pendingAction.orderId, pendingAction.status, token);
          } else if (pendingAction?.type === 'confirm') {
            runConfirm(pendingAction.orderId, token);
          }
          setPendingAction(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.huge, paddingVertical: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.appCanvas.surface, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 20, color: colors.ink },
  empty: { ...type.body, textAlign: 'center', marginTop: 48, color: 'rgba(5,8,5,0.5)' },
  list: { padding: spacing.huge, gap: spacing.md, paddingBottom: 80 },
  card: { backgroundColor: colors.appCanvas.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.appCanvas.border },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.sm },
  cardTitle: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink, flex: 1 },
  cardAmount: { fontFamily: fontFamily.displayBlack, fontSize: 14, color: colors.greenDark },
  cardMeta: { ...type.caption, color: 'rgba(5,8,5,0.55)', marginTop: 4 },
  lineItem: { ...type.bodySmall, color: colors.ink, marginTop: 4 },
  date: { ...type.caption, color: 'rgba(5,8,5,0.4)', marginTop: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  actionBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: 'rgba(5,8,5,0.06)' },
  actionBtnPrimary: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.greenA12 },
  actionText: { fontSize: 11, fontWeight: '700', color: colors.ink },
  actionTextPrimary: { fontSize: 11, fontWeight: '700', color: colors.greenDark },
});
