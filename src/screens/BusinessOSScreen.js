import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenBackground from '../components/ScreenBackground';
import PressScale from '../components/PressScale';
import K21QrCode from '../components/K21QrCode';
import { useToast } from '../components/Toast';
import {
  addBusinessLocation,
  adjustStock,
  cancelBusinessOrder,
  cancelMerchantCharge,
  changeBusinessMemberRole,
  createCatalogItem,
  createMerchantCharge,
  getBusinessAnalytics,
  getBusinessCatalog,
  getBusinessCharges,
  getBusinessCustomers,
  getBusinessMembers,
  getBusinessMoney,
  getBusinessOrders,
  getBusinessProfile,
  getBusinessToday,
  inviteBusinessMember,
  moveBusinessOrder,
  refundBusinessOrder,
  removeBusinessMember,
  requestBusinessVerification,
  switchBusinessSettlement,
  updateCatalogItem,
} from '../lib/api-client';
import { can, chargeState, moneyLine, orderButtons, reasonProblem, stockBadge, visibleSections } from '../lib/business-ux';
import { newIntentKey } from '../lib/money-ux';
import { colors, fontFamily, radius, spacing } from '../theme';

/**
 * J5 Merchant mode — the daily operating loop on a phone: Today, Encaisser
 * (QR charges), Commandes, Produits, Stock, Clients, Équipe, Activité,
 * Réglages. Sections and buttons follow the caller's capabilities; the
 * server re-checks every action.
 */
const ROLE_CHOICES = ['cashier', 'fulfillment', 'inventory', 'manager', 'finance', 'viewer'];
const ROLE_LABEL = { cashier: 'Caisse', fulfillment: 'Préparation', inventory: 'Stock', manager: 'Gérant·e', finance: 'Finances', viewer: 'Lecture', owner: 'Propriétaire' };

function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}
function Btn({ label, onPress, primary, disabled }) {
  return (
    <PressScale scaleTo={0.96} onPress={disabled ? undefined : onPress} style={[styles.btn, primary && styles.btnPrimary, disabled && { opacity: 0.4 }]}>
      <Text style={[styles.btnText, primary && styles.btnTextPrimary]}>{label}</Text>
    </PressScale>
  );
}
function Field(props) {
  return <TextInput placeholderTextColor="rgba(5,8,5,0.4)" style={styles.input} {...props} />;
}
const tone = (t) => ({ ok: colors.greenDark, warn: colors.terracottaDark, pending: '#8a6d00', muted: 'rgba(5,8,5,0.45)', in: colors.greenDark, out: colors.terracottaDark }[t] ?? colors.ink);

function Today({ id, onGo }) {
  const [d, setD] = useState(null);
  useEffect(() => { getBusinessToday(id).then(setD).catch(() => setD(null)); }, [id]);
  if (!d) return <ActivityIndicator color={colors.greenDark} />;
  const tiles = [
    d.orders.new != null && { label: 'Nouvelles commandes', value: d.orders.new, go: 'orders' },
    d.orders.preparing != null && { label: 'En préparation', value: d.orders.preparing, go: 'orders' },
    d.orders.readyOrOut != null && { label: 'Prêtes / en livraison', value: d.orders.readyOrOut, go: 'orders' },
    d.openCharges != null && { label: 'QR en attente', value: d.openCharges, go: 'payments' },
    d.lowStock != null && { label: 'Stock bas', value: d.lowStock, go: 'stock' },
    d.salesToday && { label: "Ventes aujourd'hui", value: `${d.salesToday.amountKori} ₭ · ${d.salesToday.count}`, go: 'activity' },
  ].filter(Boolean);
  return (
    <View style={styles.tiles}>
      {tiles.map((t) => (
        <PressScale key={t.label} scaleTo={0.97} onPress={() => onGo(t.go)} style={styles.tile}>
          <Text style={styles.tileValue}>{t.value}</Text>
          <Text style={styles.tileLabel}>{t.label}</Text>
        </PressScale>
      ))}
    </View>
  );
}

function Payments({ id, access, toast }) {
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [ref, setRef] = useState('');
  const [current, setCurrent] = useState(null);
  const [list, setList] = useState([]);
  const load = useCallback(() => getBusinessCharges(id).then(setList).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);
  const create = async () => {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) return toast('Montant invalide');
    try {
      const c = await createMerchantCharge({ businessId: id, amountKori: n, label: label || undefined, externalRef: ref || undefined });
      setCurrent(c);
      setAmount(''); setLabel(''); setRef('');
      load();
    } catch (e) { toast(e.message); }
  };
  const st = current ? chargeState(current) : null;
  return (
    <View style={{ gap: spacing.lg }}>
      {can(access, 'business.charges.create') ? (
        <Card>
          <Text style={styles.h}>Nouveau paiement par QR</Text>
          <Field placeholder="Montant (₭)" keyboardType="number-pad" value={amount} onChangeText={setAmount} />
          <Field placeholder="Description (facultatif)" value={label} onChangeText={setLabel} maxLength={80} />
          <Field placeholder="Référence / n° de ticket (facultatif)" value={ref} onChangeText={setRef} maxLength={60} />
          <Btn primary label="Afficher le QR" onPress={create} />
        </Card>
      ) : null}
      {current ? (
        <Card style={{ alignItems: 'center' }}>
          <Text style={styles.h}>{current.amountKori} ₭ {current.label ? `· ${current.label}` : ''}</Text>
          {st.showQr ? <K21QrCode value={current.qrUrl} size={220} /> : null}
          <Text style={{ color: tone(st.tone) }}>{st.label}</Text>
          <Text style={styles.meta}>Le client scanne : le montant vient du serveur, il ne peut pas le changer. Valable 30 min, un seul paiement.</Text>
          <View style={styles.row}>
            <Btn label="Actualiser" onPress={() => getBusinessCharges(id).then((l) => { setList(l); setCurrent((c) => l.find((x) => x.code === c.code) ?? c); }).catch((e) => toast(e.message))} />
            {st.showQr && can(access, 'business.charges.create') ? <Btn label="Annuler" onPress={() => cancelMerchantCharge(current.code).then(() => { setCurrent(null); load(); }).catch((e) => toast(e.message))} /> : null}
          </View>
        </Card>
      ) : null}
      <Text style={styles.section}>Derniers QR</Text>
      {list.map((c) => {
        const s = chargeState(c);
        return (
          <PressScale key={c.code} scaleTo={0.98} onPress={() => setCurrent(c)} style={styles.line}>
            <Text style={styles.lineTitle}>{c.amountKori} ₭ {c.label ? `· ${c.label}` : ''}{c.externalRef ? ` · ${c.externalRef}` : ''}</Text>
            <Text style={{ color: tone(s.tone) }}>{s.label}</Text>
          </PressScale>
        );
      })}
    </View>
  );
}

function Orders({ id, access, toast }) {
  const [orders, setOrders] = useState(null);
  const [pending, setPending] = useState(null); // { order, kind, key }
  const [reason, setReason] = useState('');
  const load = useCallback(() => getBusinessOrders(id).then(setOrders).catch((e) => toast(e.message)), [id, toast]);
  useEffect(() => { load(); }, [load]);
  const act = async (order, b) => {
    if (b.kind === 'move') {
      try { await moveBusinessOrder(id, order.id, b.to); } catch (e) { toast(e.message); }
      return load();
    }
    setReason('');
    setPending({ order, kind: b.kind, key: newIntentKey() }); // one intent key per attempt
  };
  const confirm = async () => {
    const problem = reasonProblem(reason);
    if (problem) return toast(problem);
    try {
      const r = pending.kind === 'cancel'
        ? await cancelBusinessOrder(id, pending.order.id, reason, pending.key)
        : await refundBusinessOrder(id, pending.order.id, { reason, restock: false }, pending.key);
      toast(r.refund ? `${r.refund.amountKori} ₭ remboursés au client` : 'Commande annulée');
      setPending(null);
    } catch (e) {
      // A lost response keeps the SAME key: retrying can never refund twice.
      toast(e.code === 'outcome_unknown' ? 'Vérification en cours… réessaie : aucun double remboursement possible.' : e.message);
    }
    load();
  };
  if (!orders) return <ActivityIndicator color={colors.greenDark} />;
  if (!orders.length) return <Text style={styles.meta}>Aucune commande pour l'instant.</Text>;
  return (
    <View style={{ gap: spacing.md }}>
      {orders.map((o) => (
        <Card key={o.id}>
          <Text style={styles.h}>{o.statusLabel} · {o.totalKori} ₭</Text>
          <Text style={styles.meta}>{o.customer?.name || o.customer?.handle || 'Client'} · {o.fulfillmentType === 'delivery' ? 'Livraison' : 'Retrait'} · {new Date(o.createdAt).toLocaleString('fr-FR')}</Text>
          {o.items.map((li) => <Text key={li.productId} style={styles.meta}>{li.quantity} × {li.title}</Text>)}
          {o.deliveryAddress ? <Text style={styles.meta}>Adresse : {o.deliveryAddress}</Text> : null}
          {o.cancelReason ? <Text style={styles.meta}>Motif : {o.cancelReason}</Text> : null}
          <View style={styles.row}>{orderButtons(o, access).map((b) => <Btn key={b.label} label={b.label} primary={b.primary} onPress={() => act(o, b)} />)}</View>
          {pending?.order.id === o.id ? (
            <View style={{ gap: spacing.sm }}>
              <Field placeholder="Motif (obligatoire)" value={reason} onChangeText={setReason} maxLength={300} />
              <View style={styles.row}>
                <Btn label="Retour" onPress={() => setPending(null)} />
                <Btn primary label={pending.kind === 'cancel' ? 'Confirmer l’annulation' : 'Confirmer le remboursement'} onPress={confirm} />
              </View>
            </View>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

function Products({ id, toast, stockMode }) {
  const [items, setItems] = useState(null);
  const [form, setForm] = useState({ title: '', price: '', stock: '', kind: 'product' });
  const [adj, setAdj] = useState(null);
  const load = useCallback(() => getBusinessCatalog(id).then(setItems).catch((e) => toast(e.message)), [id, toast]);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    try {
      await createCatalogItem(id, { title: form.title, priceKori: Number(form.price), kind: form.kind, initialStock: form.kind === 'product' ? Number(form.stock || 0) : undefined });
      setForm({ title: '', price: '', stock: '', kind: 'product' });
      load();
    } catch (e) { toast(e.message); }
  };
  const saveAdj = async () => {
    const problem = reasonProblem(adj.note);
    if (problem) return toast(problem);
    try { await adjustStock(id, adj.item.id, { delta: Number(adj.delta), note: adj.note }); setAdj(null); load(); } catch (e) { toast(e.message); }
  };
  if (!items) return <ActivityIndicator color={colors.greenDark} />;
  const shown = stockMode ? items.filter((i) => i.trackInventory) : items;
  return (
    <View style={{ gap: spacing.md }}>
      {!stockMode ? (
        <Card>
          <Text style={styles.h}>Ajouter</Text>
          <View style={styles.row}>
            <Btn label="Produit" primary={form.kind === 'product'} onPress={() => setForm({ ...form, kind: 'product' })} />
            <Btn label="Service" primary={form.kind === 'service'} onPress={() => setForm({ ...form, kind: 'service' })} />
          </View>
          <Field placeholder="Nom" value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} />
          <Field placeholder="Prix (₭)" keyboardType="number-pad" value={form.price} onChangeText={(v) => setForm({ ...form, price: v })} />
          {form.kind === 'product' ? <Field placeholder="Stock de départ" keyboardType="number-pad" value={form.stock} onChangeText={(v) => setForm({ ...form, stock: v })} /> : null}
          <Btn primary label="Ajouter au catalogue" onPress={add} disabled={!form.title || !Number(form.price)} />
        </Card>
      ) : null}
      {shown.map((i) => {
        const badge = stockBadge(i);
        return (
          <Card key={i.id} style={!i.active && { opacity: 0.5 }}>
            <Text style={styles.h}>{i.title} · {i.priceKori} ₭</Text>
            <Text style={{ color: tone(badge.tone) }}>{badge.label}{i.sku ? ` · ${i.sku}` : ''}</Text>
            {stockMode ? (
              adj?.item.id === i.id ? (
                <View style={{ gap: spacing.sm }}>
                  <Field placeholder="Variation (ex. 10 ou -2)" keyboardType="numbers-and-punctuation" value={adj.delta} onChangeText={(v) => setAdj({ ...adj, delta: v })} />
                  <Field placeholder="Motif (réception, casse, inventaire…)" value={adj.note} onChangeText={(v) => setAdj({ ...adj, note: v })} />
                  <View style={styles.row}><Btn label="Retour" onPress={() => setAdj(null)} /><Btn primary label="Enregistrer" onPress={saveAdj} /></View>
                </View>
              ) : (
                <Btn label="Ajuster le stock" onPress={() => setAdj({ item: i, delta: '', note: '' })} />
              )
            ) : (
              <Btn label={i.active ? 'Désactiver' : 'Réactiver'} onPress={() => updateCatalogItem(id, i.id, { active: !i.active }).then(load).catch((e) => toast(e.message))} />
            )}
          </Card>
        );
      })}
    </View>
  );
}

function Customers({ id, toast }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { getBusinessCustomers(id).then(setRows).catch((e) => toast(e.message)); }, [id, toast]);
  if (!rows) return <ActivityIndicator color={colors.greenDark} />;
  if (!rows.length) return <Text style={styles.meta}>Pas encore de clients.</Text>;
  return rows.map((c) => (
    <View key={`${c.handle}-${c.lastAt}`} style={styles.line}>
      <Text style={styles.lineTitle}>{c.name || (c.handle ? `@${c.handle}` : 'Client')}</Text>
      <Text style={styles.meta}>{c.orders} commande(s) · {c.payments} QR · {c.totalKori} ₭</Text>
    </View>
  ));
}

function Team({ id, toast }) {
  const [members, setMembers] = useState(null);
  const [handle, setHandle] = useState('');
  const [role, setRole] = useState('cashier');
  const load = useCallback(() => getBusinessMembers(id).then(setMembers).catch((e) => toast(e.message)), [id, toast]);
  useEffect(() => { load(); }, [load]);
  const invite = async () => {
    try { await inviteBusinessMember(id, { userHandle: handle, role }); setHandle(''); toast('Invitation envoyée — active après acceptation'); load(); } catch (e) { toast(e.message); }
  };
  if (!members) return <ActivityIndicator color={colors.greenDark} />;
  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <Text style={styles.h}>Inviter</Text>
        <Field placeholder="@identifiant" autoCapitalize="none" value={handle} onChangeText={setHandle} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.row}>{ROLE_CHOICES.map((r) => <Btn key={r} label={ROLE_LABEL[r]} primary={role === r} onPress={() => setRole(r)} />)}</View></ScrollView>
        <Btn primary label="Inviter" onPress={invite} disabled={handle.trim().length < 3} />
        <Text style={styles.meta}>Un rôle donne des droits précis (ex. la caisse n'accède ni à la paie ni à l'équipe).</Text>
      </Card>
      {members.filter((m) => m.role !== 'owner').map((m) => (
        <Card key={m.id}>
          <Text style={styles.h}>{m.user?.name || `@${m.user?.handle}`} · {ROLE_LABEL[m.role] ?? m.role}</Text>
          <Text style={styles.meta}>{m.status === 'invited' ? 'Invitation en attente' : 'Actif'}</Text>
          {m.status === 'active' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.row}>
                {ROLE_CHOICES.filter((r) => r !== m.role).map((r) => (
                  <Btn key={r} label={`→ ${ROLE_LABEL[r]}`} onPress={() => changeBusinessMemberRole(id, m.id, r).then(load).catch((e) => toast(e.message))} />
                ))}
                <Btn label="Retirer" onPress={() => removeBusinessMember(id, m.id, 'Retiré depuis le mode commerce').then(load).catch((e) => toast(e.message))} />
              </View>
            </ScrollView>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

function Activity({ id, access, toast }) {
  const [money, setMoney] = useState(null);
  const [stats, setStats] = useState(null);
  const [period, setPeriod] = useState('30d');
  useEffect(() => {
    if (can(access, 'business.activity.read') || can(access, 'business.wallet.read')) getBusinessMoney(id).then(setMoney).catch((e) => toast(e.message));
  }, [id, access, toast]);
  useEffect(() => {
    if (can(access, 'business.analytics.read')) getBusinessAnalytics(id, period).then(setStats).catch((e) => toast(e.message));
  }, [id, access, period, toast]);
  return (
    <View style={{ gap: spacing.md }}>
      {money?.balance ? (
        <Card>
          <Text style={styles.meta}>Solde du commerce</Text>
          <Text style={styles.big}>{money.balance.availableKori} ₭</Text>
          {money.pending.openChargesCount ? <Text style={styles.meta}>À encaisser : {money.pending.openChargesKori} ₭ ({money.pending.openChargesCount} QR) — pas encore reçu</Text> : null}
        </Card>
      ) : null}
      {stats ? (
        <Card>
          <View style={styles.row}>{['today', '7d', '30d', '90d'].map((p) => <Btn key={p} label={p === 'today' ? "Aujourd'hui" : p} primary={period === p} onPress={() => setPeriod(p)} />)}</View>
          <Text style={styles.big}>{stats.sales.netKori} ₭ net</Text>
          <Text style={styles.meta}>Ventes {stats.sales.grossKori} ₭ · Remboursements {stats.sales.refundsKori} ₭</Text>
          <Text style={styles.meta}>{stats.orders.paidCount} commande(s) payée(s) · panier moyen {stats.orders.averageOrderKori} ₭</Text>
          {stats.topProducts.slice(0, 3).map((p) => <Text key={p.productId} style={styles.meta}>• {p.title} : {p.units} vendu(s)</Text>)}
          <Text style={[styles.meta, { color: stats.reconciliation.ok ? colors.greenDark : colors.terracottaDark }]}>
            {stats.reconciliation.ok ? 'Chiffres rapprochés avec le grand livre ✓' : 'Écart détecté — contacte le support'}
          </Text>
        </Card>
      ) : null}
      {money?.items.map((i, n) => {
        const l = moneyLine(i);
        return (
          <View key={`${i.reference ?? 'r'}-${n}`} style={styles.line}>
            <Text style={styles.lineTitle}>{l.label}</Text>
            <Text style={{ color: tone(l.tone) }}>{l.amount}</Text>
          </View>
        );
      })}
    </View>
  );
}

function Settings({ id, profile, reload, toast }) {
  const [loc, setLoc] = useState('');
  const me = profile.me;
  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <Text style={styles.h}>Vérification : {({ unverified: 'non vérifié', pending: 'en cours', verified: 'vérifié ✓', rejected: 'refusée' })[profile.verification.status]}</Text>
        {me.isOwner && ['unverified', 'rejected'].includes(profile.verification.status) ? (
          <Btn label="Demander la vérification" onPress={() => requestBusinessVerification(id).then(reload).catch((e) => toast(e.message))} />
        ) : null}
        <Text style={styles.meta}>Décidée par l'équipe Jokko, jamais par le commerce lui-même.</Text>
      </Card>
      <Card>
        <Text style={styles.h}>Encaissement : {profile.settlement.label}</Text>
        {me.isOwner && profile.settlement.mode !== 'business' ? (
          <Btn primary label="Encaisser sur le portefeuille du commerce" onPress={() => switchBusinessSettlement(id).then(reload).catch((e) => toast(e.message))} />
        ) : null}
      </Card>
      <Card>
        <Text style={styles.h}>Lieux</Text>
        {profile.locations.map((l) => <Text key={l.id} style={styles.meta}>{l.isPrimary ? '★ ' : ''}{l.name}{l.address ? ` · ${l.address}` : ''}{l.active ? '' : ' (fermé)'}</Text>)}
        <Field placeholder="Nouveau lieu (nom)" value={loc} onChangeText={setLoc} />
        <Btn label="Ajouter un lieu" disabled={loc.trim().length < 2} onPress={() => addBusinessLocation(id, { name: loc }).then(() => { setLoc(''); reload(); }).catch((e) => toast(e.message))} />
      </Card>
    </View>
  );
}

export default function BusinessOSScreen({ navigation, route }) {
  const id = route.params?.businessId;
  const toast = useToast();
  const [profile, setProfile] = useState(null);
  const [section, setSection] = useState(route.params?.section ?? 'today');
  const reload = useCallback(() => getBusinessProfile(id).then(setProfile).catch((e) => toast(e.message)), [id, toast]);
  useEffect(() => { reload(); }, [reload]);
  if (!profile) return <View style={styles.root}><ScreenBackground /><ActivityIndicator style={{ marginTop: 80 }} color={colors.greenDark} /></View>;
  const access = profile.me;
  const sections = visibleSections(access.capabilities);
  const body = {
    today: <Today id={id} onGo={setSection} />,
    payments: <Payments id={id} access={access} toast={toast} />,
    orders: <Orders id={id} access={access} toast={toast} />,
    products: <Products id={id} toast={toast} />,
    stock: <Products id={id} toast={toast} stockMode />,
    customers: <Customers id={id} toast={toast} />,
    team: <Team id={id} toast={toast} />,
    activity: <Activity id={id} access={access} toast={toast} />,
    settings: <Settings id={id} profile={profile} reload={reload} toast={toast} />,
  }[section];
  return (
    <View style={styles.root}>
      <ScreenBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <PressScale scaleTo={0.9} onPress={() => navigation.goBack()} style={styles.back}><Text>←</Text></PressScale>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>{profile.name}{profile.verification.verified ? ' ✓' : ''}</Text>
            <Text style={styles.meta}>{access.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}</Text>
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {sections.map((s) => (
            <PressScale key={s.key} scaleTo={0.95} onPress={() => setSection(s.key)} style={[styles.chip, section === s.key && styles.chipOn]}>
              <Text style={[styles.chipText, section === s.key && styles.chipTextOn]}>{s.label}</Text>
            </PressScale>
          ))}
        </ScrollView>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">{body}</ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appCanvas.base },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.xxl, paddingTop: spacing.xl },
  back: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fontFamily.displayBlack, fontSize: 17, color: colors.ink },
  chips: { gap: spacing.sm, paddingHorizontal: spacing.xxl, paddingVertical: spacing.lg },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: 'rgba(5,8,5,0.08)' },
  chipOn: { backgroundColor: colors.ink },
  chipText: { fontFamily: fontFamily.bodyBold, fontSize: 13, color: colors.ink },
  chipTextOn: { color: '#fff' },
  body: { paddingHorizontal: spacing.xxl, paddingBottom: 80, gap: spacing.md },
  card: { backgroundColor: 'rgba(255,255,255,0.78)', borderRadius: radius.xl, borderWidth: 1, borderColor: 'rgba(5,8,5,0.07)', padding: spacing.xl, gap: spacing.sm },
  h: { fontFamily: fontFamily.bodyBold, fontSize: 15, color: colors.ink },
  big: { fontFamily: fontFamily.displayBlack, fontSize: 26, color: colors.ink },
  meta: { fontSize: 13, color: 'rgba(5,8,5,0.6)' },
  section: { fontSize: 12, fontWeight: '700', letterSpacing: 1, color: 'rgba(5,8,5,0.45)', textTransform: 'uppercase', marginTop: spacing.md },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.lg, backgroundColor: 'rgba(5,8,5,0.06)', minHeight: 44, justifyContent: 'center' },
  btnPrimary: { backgroundColor: colors.greenDark },
  btnText: { fontFamily: fontFamily.bodyBold, fontSize: 14, color: colors.ink },
  btnTextPrimary: { color: '#fff' },
  input: { borderWidth: 1, borderColor: 'rgba(5,8,5,0.15)', borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, backgroundColor: '#fff', color: colors.ink },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: { width: '47%', backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: radius.xl, padding: spacing.xl, gap: 4 },
  tileValue: { fontFamily: fontFamily.displayBlack, fontSize: 22, color: colors.ink },
  tileLabel: { fontSize: 13, color: 'rgba(5,8,5,0.6)' },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(5,8,5,0.06)', gap: spacing.md },
  lineTitle: { flex: 1, fontSize: 14, color: colors.ink },
});
