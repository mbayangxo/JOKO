import { setCors, readJson, validationError } from '../api/_lib/http.js';
import { getUserIdFromRequest } from '../api/_lib/auth.js';
import { getAdminFromBearer } from './admin-auth.js';
import { enforceRoutePolicy } from './authz/enforce.js';
import {
  adminMoneyLimitsUsageHandler,
  adminMoneyLookupHandler,
  moneyActivityHandler,
  moneyChargeCancelHandler,
  moneyChargeCreateHandler,
  moneyChargePayHandler,
  moneyChargeViewHandler,
  moneyHomeHandler,
  moneyIntentHandler,
  moneyPreviewHandler,
  moneyReceiptHandler,
  moneyRefundHandler,
} from './money-handlers.js';
import {
  adminAdminRoleRequest,
  adminAdminRoleRevoke,
  adminAdminsList,
  adminAgentsSuspend,
  adminApprovalApprove,
  adminApprovalReject,
  adminApprovalsList,
  adminCourierApprove,
  adminCourierRevoke,
  adminCourierSuspend,
  adminIdentityEvents,
  adminMe,
} from './identity-admin-handlers.js';
import {
  adminAuthBootstrap,
  adminAuthConfirm2fa,
  adminAuthLogin,
  adminAuthLogout,
  adminAuthSetup2fa,
  adminAuthVerify2fa,
  adminDailyReportExport,
  adminDailyReports,
  adminDashboard,
  adminFraudAlertAck,
  adminFraudAlerts,
  adminFreezeUser,
  adminInvalidateCredentials,
  adminUnfreezeUser,
  adminHeldTransactionApprove,
  adminHeldTransactionReject,
  adminHeldTransactionsList,
  adminIssueRefund,
  adminReleaseRail,
  adminSupportTicketGet,
  adminSupportTicketPatch,
  adminSupportTicketReply,
  adminSupportTicketsList,
  adminTransactionDetail,
  adminAgentsList,
  adminAgentsCreate,
  adminAgentsFloat,
  adminAgentsApprove,
  adminAgentsReject,
  adminAgentsPatch,
  adminAgentsReconcile,
  adminAgentFloatRequestsList,
  adminAgentFloatRequestApprove,
  adminAgentFloatRequestReject,
  adminAuditLogs,
  adminUsersSearch,
  adminUserDetail,
  adminKycQueue,
  adminKycApprove,
  adminKycReject,
  adminKycAddressApprove,
  adminDistributorsList,
  adminDistributorDetail,
  adminDistributorPatch,
  adminSupportStats,
  adminSupportCallsList,
  adminSupportCallLog,
  adminOpsHealth,
} from './admin-handlers.js';
import {
  supportContactInfo,
  supportTicketsMine,
  supportTicketCreate,
  supportTicketGet,
  supportTicketReply,
} from './support-handlers.js';
import { inviteShare } from './invite-handlers.js';
import {
  partnerCheckoutSessions,
  partnerMessagesSend,
  partnerPayConfirm,
  partnerPayPage,
  partnerPaymentGet,
  partnerPaymentSandboxComplete,
  partnerPaymentsCollect,
  partnerPosGet,
  partnerPosSessions,
  partnerPayoutGet,
  partnerPayoutSandboxComplete,
  partnerPayoutsCreate,
  partnerSupportAgentsCreate,
  partnerSupportAgentsList,
  partnerSupportThreadAssign,
  partnerSupportThreadMessage,
  partnerSupportThreadsCreate,
  partnerSupportThreadsList,
} from './partner-handlers.js';
import { logApiCall } from './api-audit.js';
import {
  tontineAccept,
  tontineCancel,
  tontineContribute,
  tontineDecline,
  tontineGroupGet,
  tontineGroups,
  tontineInvite,
  tontineLeave,
  tontineRelease,
  tontineRemove,
  tontineStart,
} from './tontine-handlers.js';
import { enforceAuthRouteLimits, enforceSensitiveRouteLimit, isSensitiveRoute, TooManyRequestsError } from './request-limits.js';
import { withIdempotency } from './api-idempotency.js';
import { scrubSecrets } from './response-scrubber.js';
import {
  adminMoneyAdjustmentApprove,
  adminMoneyAdjustmentReject,
  adminMoneyAdjustments,
  adminMoneyExceptions,
  adminMoneyImportStatement,
  adminMoneyPosition,
} from './money-admin-handlers.js';
import { enforceRateLimit, RateLimitError, SecurityBlockError } from './rate-limit.js';
import { databaseConfigured } from './prisma.js';
import { captureServerError } from './sentry-server.js';
import {
  health,
  platformConfig,
  authPhone,
  authEmail,
  authVerify,
  authRecover,
  authPasswordLogin,
  authPasswordSet,
  authPasswordSetWithOtp,
  authRefresh,
  authCompleteProfile,
  cultureFeed,
  trendingFeed,
  trendingAlertDetail,
  trendingAlertRead,
  trendingAlertShare,
  getMe,
  getMeSummary,
  meUpdate,
  meStudentPass,
  mePhoneRequest,
  mePhoneConfirm,
  meEmailRequest,
  meEmailConfirm,
  usersLookup,
  getWallet,
  getTransactions,
  transfersSend,
  transferUndo,
  transfersRequest,
  transfersRequestsList,
  transfersRequestById,
  transfersRequestAccept,
  transfersRequestDeny,
  transfersRequestCancel,
  cashIn,
  cashOut,
  depositsNational,
  mboloThreads,
  mboloThreadMessages,
  mboloShare,
  mboloVideoUploadToken,
  mboloBroadcast,
  mboloThreadMembers,
  mboloRequests,
  authLogout,
  authLogoutAll,
  authSessionsList,
  authSessionRevoke,
  authDevicesList,
  authDeviceRevoke,
  mboloRequestAccept,
  mboloRequestDecline,
  mboloRequestBlock,
  mboloRequestReport,
  mboloThreadInvite,
  mboloJoinByInvite,
  events,
  eventsTickets,
  products,
  businessesList,
  businessesCreate,
  merchantPublic,
  merchantPay,
  merchantVouchersMine,
  friendsHandler,
  friendsRemove,
  friendRequestsList,
  friendRequestRespond,
  vouchHandler,
  callsToken,
  notificationsList,
  notificationsRead,
  authPinSet,
  authPinVerify,
  chartsGet,
  chartsSubmit,
  chartsVote,
  chartsSearch,
  publicProfileGet,
  pollsAsk,
  pollsVote,
  channelsMine,
  channelsPost,
  channelsPostDelete,
  channelsBrowse,
  channelsFeed,
  channelsView,
  channelsFollow,
  geoSearch,
  businessReviewsCreate,
  businessReviewsList,
  authPinUnlock,
  authBiometric,
  authDeviceVerify,
  kycStatus,
  kycCniSubmit,
  kycAddressSubmit,
  koriConvert,
  koriTransactions,
  koriReserve,
  rolesAssign,
  sellersProfile,
  driversProfile,
  deliveriesNearby,
  deliveriesCreate,
  deliveryDetail,
  deliveriesAccept,
  deliveriesClaim,
  deliveriesPickup,
  deliveriesDeliver,
  deliveriesConfirm,
  deliveriesDispute,
  deliveriesDisputeEvidence,
  deliveriesDisputeResolve,
  smsPreferencesGet,
  smsPreferencesUpdate,
  webhooksJulaya,
  webhooksKycSmile,
  webhooksKycSumsub,
  webhooksSmsInbound,
  workersProfile,
  workersReceipts,
  workersCreditSummary,
} from './handlers.js';
import {
  mboloMediaUploadUrl,
  mboloMediaComplete,
  mboloVaultList,
  mboloVaultDelete,
  mboloGifsList,
  mboloGifsCreate,
  mboloGifsUse,
  mboloStorageStatus,
  mboloMessageSave,
  mboloThreadPresence,
  mboloThreadTyping,
  mboloThreadRead,
  mboloStoriesList,
  mboloStoriesCreate,
  mboloDeviceKeysRegister,
} from './mbolo-handlers.js';
import {
  depositAgentCreate,
  depositAgentStatus,
  depositCardSession,
  depositCardStatus,
  webhooksStripe,
  agentMe,
  agentDepositScan,
  agentDepositConfirm,
  agentWithdrawScan,
  agentWithdrawConfirm,
  withdrawAgentCreate,
  withdrawAgentStatus,
  agentApply,
  agentApplication,
  agentsNearby,
  agentUpdateLocation,
  agentPayouts,
  agentFloatTopUpRequestCreate,
  agentFloatTopUpRequestsMine,
} from './agent-handlers.js';
import {
  eventsMine,
  ticketsMine,
  eventCheckIn,
  eventScanStats,
} from './event-handlers.js';
import {
  jekkalCampaigns,
  jekkalCampaignDetail,
  jekkalContribute,
  jekkalMine,
} from './jekkal-handlers.js';
import {
  affiliateMe,
  affiliateLinks,
  affiliateResolve,
  affiliateClick,
  affiliateMboloShare,
} from './affiliate-handlers.js';
import {
  marketplaceSearch,
  marketplaceShopsNearby,
  marketplaceShopGet,
  marketplaceHubsList,
  marketplaceOrderCreate,
  marketplaceOrdersMine,
  marketplaceOrdersMerchant,
  marketplaceCatalogMine,
  marketplaceProductPatch,
  marketplaceProductDelete,
  marketplaceProductView,
  marketplaceAnalytics,
  marketplaceBusinessSettings,
} from './marketplace-handlers.js';
import {
  distributionBrandRegister,
  distributionBrandMine,
  tradeAccountsList,
  tradeAccountUpsert,
  tradeInvoicesMine,
  tradeInvoicesSupplier,
  tradeInvoicePay,
  tradeInvoiceDispute,
  tradeInvoiceDisputeResolve,
  tradeSummaryCheckout,
  buyerPortalSuppliers,
  buyerPortalCatalog,
  supplierReceivables,
  marketplaceOrderGet,
  marketplaceOrderStatus,
  marketplaceOrderConfirm,
  riderActiveDeliveries,
  businessKebuScoreGet,
} from './trade-handlers.js';
import {
  paymentFundsList,
  paymentFundsCreate,
  paymentFundFund,
  paymentFundWithdraw,
  scheduledPaymentsList,
  scheduledPaymentsCreate,
  scheduledPaymentPatch,
} from './scheduled-payment-handlers.js';
import {
  hubParcelsCreate,
  hubParcelsMine,
  hubParcelGet,
  hubParcelInTransit,
  hubParcelArrive,
  hubParcelLastMile,
  hubParcelConfirmPickup,
  hubParcelsOriginCountries,
} from './hub-parcel-handlers.js';
import {
  cronDailyAll,
  cronScheduledPayments,
  cronFinancialIntegrity,
  cronPendingTransactions,
  cronFraudMonitor,
  cronTontineProcessor,
  cronRiderStatus,
  cronDailyFinancialReport,
  cronDeliveryAutoRelease,
  cronAgentMonthlyPayout,
} from './cron/http-handlers.js';
import {
  businessesMine,
  businessDetail,
  businessStatusUpdate,
  businessCommunityStatusUpdate,
  payrollGroupsHandler,
  payrollEmployeesHandler,
  payrollPayHandler,
  payrollRunHandler,
  schoolStudentsHandler,
  schoolPeriodsHandler,
  schoolPeriodStatusHandler,
  schoolPayHandler,
  schoolRemindHandler,
  cooperativeDeliveriesHandler,
  cooperativeVerifyHandler,
  cooperativePayoutHandler,
  offlineSyncHandler,
  trustBlockHandler,
  trustUnblockHandler,
  trustReportHandler,
  businessMembersHandler,
  businessInvitationsMine,
  businessMemberAccept,
  businessMemberRemove,
  businessWalletHandler,
  businessCreditSummaryHandler,
  businessTransferHandler,
} from './org-handlers.js';
import { safeError } from './log-redact.js';

async function adminReportsDaily(req, res) {
  if (req.query.export === '1' || req.query.format) {
    return adminDailyReportExport(req, res);
  }
  return adminDailyReports(req, res);
}

async function adminSupportTicketById(req, res) {
  if (req.method === 'GET') return adminSupportTicketGet(req, res);
  if (req.method === 'POST') return adminSupportTicketReply(req, res);
  if (req.method === 'PATCH') return adminSupportTicketPatch(req, res);
  res.status(405).json({ error: 'Method not allowed' });
}

/** @typedef {{ auth?: boolean, adminAuth?: boolean, handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void> }} RouteDef */

/** @type {Record<string, RouteDef>} */
const ROUTES = {
  'GET health': { auth: false, handler: health },
  'GET platform/config': { auth: false, handler: platformConfig },
  'POST auth/phone': { auth: false, handler: authPhone },
  'POST auth/email': { auth: false, handler: authEmail },
  'POST auth/password/login': { auth: false, handler: authPasswordLogin },
  'POST auth/password/set': { auth: true, handler: authPasswordSet },
  'POST auth/logout': { auth: true, handler: authLogout },
  'POST auth/logout-all': { auth: true, handler: authLogoutAll },
  'GET auth/sessions': { auth: true, handler: authSessionsList },
  'POST auth/sessions/:id/revoke': { auth: true, handler: authSessionRevoke },
  'GET auth/devices': { auth: true, handler: authDevicesList },
  'POST auth/devices/:id/revoke': { auth: true, handler: authDeviceRevoke },
  'POST auth/password/set-with-otp': { auth: false, handler: authPasswordSetWithOtp },
  'POST auth/recover': { auth: false, handler: authRecover },
  'POST auth/verify': { auth: false, handler: authVerify },
  'POST auth/refresh': { auth: false, handler: authRefresh },
  'POST auth/complete-profile': { auth: true, handler: authCompleteProfile },
  'GET culture/feed': { auth: true, handler: cultureFeed },
  'GET trending/feed': { auth: true, handler: trendingFeed },
  'GET trending/alerts/:id': { auth: true, handler: trendingAlertDetail },
  'POST trending/alerts/:id/read': { auth: true, handler: trendingAlertRead },
  'POST trending/alerts/:id/share': { auth: true, handler: trendingAlertShare },
  'GET me': { auth: true, handler: getMe },
  'GET me/summary': { auth: true, handler: getMeSummary },
  'GET me/student-pass': { auth: true, handler: meStudentPass },
  'POST me/student-pass': { auth: true, handler: meStudentPass },
  'PATCH me': { auth: true, handler: meUpdate },
  'POST me/phone': { auth: true, handler: mePhoneRequest },
  'POST me/phone/confirm': { auth: true, handler: mePhoneConfirm },
  'POST me/email': { auth: true, handler: meEmailRequest },
  'POST me/email/confirm': { auth: true, handler: meEmailConfirm },
  'GET users/lookup': { auth: true, handler: usersLookup },
  'GET wallet': { auth: true, handler: getWallet },
  // J4 Money read model + primitives
  'GET money/home': { auth: true, handler: moneyHomeHandler },
  'GET money/activity': { auth: true, handler: moneyActivityHandler },
  'GET money/activity/:reference': { auth: true, handler: moneyReceiptHandler },
  'POST money/preview': { auth: true, handler: moneyPreviewHandler },
  'GET money/intents/:id': { auth: true, handler: moneyIntentHandler },
  'POST money/charges': { auth: true, handler: moneyChargeCreateHandler },
  'GET money/charges/:id': { auth: true, handler: moneyChargeViewHandler },
  'POST money/charges/:id/pay': { auth: true, handler: moneyChargePayHandler },
  'POST money/charges/:id/cancel': { auth: true, handler: moneyChargeCancelHandler },
  'POST money/payments/:reference/refund': { auth: true, handler: moneyRefundHandler },
  'GET transactions': { auth: true, handler: getTransactions },
  'POST transfers/send': { auth: true, handler: transfersSend },
  'POST transfers/:reference/undo': { auth: true, handler: transferUndo },
  'POST transfers/request': { auth: true, handler: transfersRequest },
  'GET transfers/requests': { auth: true, handler: transfersRequestsList },
  'GET transfers/requests/:id': { auth: true, handler: transfersRequestById },
  'POST transfers/requests/:id/accept': { auth: true, handler: transfersRequestAccept },
  'POST transfers/requests/:id/deny': { auth: true, handler: transfersRequestDeny },
  'POST transfers/requests/:id/cancel': { auth: true, handler: transfersRequestCancel },
  'POST cash/in': { auth: true, handler: cashIn },
  'POST cash/out': { auth: true, handler: cashOut },
  'POST deposits/national': { auth: true, handler: depositsNational },
  'POST deposits/agent': { auth: true, handler: depositAgentCreate },
  'GET deposits/agent/:reference': { auth: true, handler: depositAgentStatus },
  'POST withdrawals/agent': { auth: true, handler: withdrawAgentCreate },
  'GET withdrawals/agent/:reference': { auth: true, handler: withdrawAgentStatus },
  'GET invite/share': { auth: true, handler: inviteShare },
  'POST deposits/card/session': { auth: true, handler: depositCardSession },
  'GET deposits/card/:reference': { auth: true, handler: depositCardStatus },
  'POST agent/apply': { auth: true, handler: agentApply },
  'GET agent/application': { auth: true, handler: agentApplication },
  'POST agent/float/topup-request': { auth: true, handler: agentFloatTopUpRequestCreate },
  'GET agent/float/topup-requests/mine': { auth: true, handler: agentFloatTopUpRequestsMine },
  'GET agents/nearby': { auth: true, handler: agentsNearby },
  'PATCH agent/location': { auth: true, handler: agentUpdateLocation },
  'GET agent/payouts': { auth: true, handler: agentPayouts },
  'GET agent/me': { auth: true, handler: agentMe },
  'POST agent/deposits/scan': { auth: true, handler: agentDepositScan },
  'POST agent/deposits/:id/confirm': { auth: true, handler: agentDepositConfirm },
  'POST agent/withdrawals/scan': { auth: true, handler: agentWithdrawScan },
  'POST agent/withdrawals/:id/confirm': { auth: true, handler: agentWithdrawConfirm },
  'GET mbolo/threads': { auth: true, handler: mboloThreads },
  'POST mbolo/threads': { auth: true, handler: mboloThreads },
  'GET mbolo/threads/:id/messages': { auth: true, handler: mboloThreadMessages },
  'POST mbolo/threads/:id/messages': { auth: true, handler: mboloThreadMessages },
  'POST mbolo/threads/:id/members': { auth: true, handler: mboloThreadMembers },
  'GET mbolo/requests': { auth: true, handler: mboloRequests },
  'POST mbolo/threads/:id/accept': { auth: true, handler: mboloRequestAccept },
  'POST mbolo/threads/:id/decline': { auth: true, handler: mboloRequestDecline },
  'POST mbolo/threads/:id/block': { auth: true, handler: mboloRequestBlock },
  'POST mbolo/threads/:id/report': { auth: true, handler: mboloRequestReport },
  'POST mbolo/threads/:id/invite': { auth: true, handler: mboloThreadInvite },
  'POST mbolo/join-group': { auth: true, handler: mboloJoinByInvite },
  'POST mbolo/share': { auth: true, handler: mboloShare },
  'POST mbolo/video/upload-token': { auth: true, handler: mboloVideoUploadToken },
  'POST mbolo/broadcast': { auth: true, handler: mboloBroadcast },
  'GET mbolo/storage/status': { auth: true, handler: mboloStorageStatus },
  'POST mbolo/media/upload-url': { auth: true, handler: mboloMediaUploadUrl },
  'POST mbolo/media/complete': { auth: true, handler: mboloMediaComplete },
  'GET mbolo/vault': { auth: true, handler: mboloVaultList },
  'DELETE mbolo/vault/:id': { auth: true, handler: mboloVaultDelete },
  'GET mbolo/gifs': { auth: true, handler: mboloGifsList },
  'POST mbolo/gifs': { auth: true, handler: mboloGifsCreate },
  'POST mbolo/gifs/:id/use': { auth: true, handler: mboloGifsUse },
  'POST mbolo/messages/:id/save': { auth: true, handler: mboloMessageSave },
  'GET mbolo/threads/:id/presence': { auth: true, handler: mboloThreadPresence },
  'POST mbolo/threads/:id/typing': { auth: true, handler: mboloThreadTyping },
  'POST mbolo/threads/:id/read': { auth: true, handler: mboloThreadRead },
  'GET mbolo/stories': { auth: true, handler: mboloStoriesList },
  'POST mbolo/stories': { auth: true, handler: mboloStoriesCreate },
  'POST mbolo/device-keys': { auth: true, handler: mboloDeviceKeysRegister },
  'GET events': { auth: true, handler: events },
  'POST events': { auth: true, handler: events },
  'GET events/mine': { auth: true, handler: eventsMine },
  'GET tickets/mine': { auth: true, handler: ticketsMine },
  'POST tickets/check-in': { auth: true, handler: eventCheckIn },
  'POST events/:id/tickets': { auth: true, handler: eventsTickets },
  'POST events/:id/check-in': { auth: true, handler: eventCheckIn },
  'GET events/:id/scan-stats': { auth: true, handler: eventScanStats },
  'GET jekkal/campaigns': { auth: true, handler: jekkalCampaigns },
  'POST jekkal/campaigns': { auth: true, handler: jekkalCampaigns },
  'GET jekkal/campaigns/mine': { auth: true, handler: jekkalMine },
  'GET jekkal/campaigns/:id': { auth: true, handler: jekkalCampaignDetail },
  'POST jekkal/campaigns/:id/contribute': { auth: true, handler: jekkalContribute },
  'GET affiliate/me': { auth: true, handler: affiliateMe },
  'POST affiliate/me': { auth: true, handler: affiliateMe },
  'GET affiliate/links': { auth: true, handler: affiliateLinks },
  'POST affiliate/links': { auth: true, handler: affiliateLinks },
  'GET affiliate/resolve/:code': { auth: true, handler: affiliateResolve },
  'POST affiliate/links/:code/click': { auth: true, handler: affiliateClick },
  'POST affiliate/mbolo-share': { auth: true, handler: affiliateMboloShare },
  'GET products': { auth: true, handler: products },
  'POST products': { auth: true, handler: products },
  'GET marketplace/search': { auth: true, handler: marketplaceSearch },
  'GET marketplace/shops/nearby': { auth: true, handler: marketplaceShopsNearby },
  'GET marketplace/shops/:id': { auth: true, handler: marketplaceShopGet },
  'GET marketplace/hubs': { auth: true, handler: marketplaceHubsList },
  'POST marketplace/orders': { auth: true, handler: marketplaceOrderCreate },
  'GET marketplace/orders/mine': { auth: true, handler: marketplaceOrdersMine },
  'GET marketplace/orders/merchant': { auth: true, handler: marketplaceOrdersMerchant },
  'GET marketplace/catalog/mine': { auth: true, handler: marketplaceCatalogMine },
  'PATCH marketplace/products/:id': { auth: true, handler: marketplaceProductPatch },
  'DELETE marketplace/products/:id': { auth: true, handler: marketplaceProductDelete },
  'POST marketplace/products/:id/view': { auth: true, handler: marketplaceProductView },
  'GET marketplace/analytics': { auth: true, handler: marketplaceAnalytics },
  'PATCH marketplace/business/:id/settings': { auth: true, handler: marketplaceBusinessSettings },
  'GET marketplace/orders/:id': { auth: true, handler: marketplaceOrderGet },
  'PATCH marketplace/orders/:id/status': { auth: true, handler: marketplaceOrderStatus },
  'POST marketplace/orders/:id/confirm': { auth: true, handler: marketplaceOrderConfirm },
  'POST distribution/brand/register': { auth: true, handler: distributionBrandRegister },
  'GET distribution/brand/mine': { auth: true, handler: distributionBrandMine },
  'GET distribution/trade-accounts': { auth: true, handler: tradeAccountsList },
  'POST distribution/trade-accounts': { auth: true, handler: tradeAccountUpsert },
  'GET support/contact': { auth: false, handler: supportContactInfo },
  'GET support/tickets/mine': { auth: true, handler: supportTicketsMine },
  'POST support/tickets': { auth: true, handler: supportTicketCreate },
  'GET support/tickets/:id': { auth: true, handler: supportTicketGet },
  'POST support/tickets/:id/reply': { auth: true, handler: supportTicketReply },
  'GET distribution/buyer-portal': { auth: true, handler: buyerPortalSuppliers },
  'GET distribution/buyer-portal/catalog': { auth: true, handler: buyerPortalCatalog },
  'GET distribution/receivables': { auth: true, handler: supplierReceivables },
  'GET distribution/invoices/mine': { auth: true, handler: tradeInvoicesMine },
  'GET distribution/invoices/supplier': { auth: true, handler: tradeInvoicesSupplier },
  'POST distribution/invoices/:id/pay': { auth: true, handler: tradeInvoicePay },
  'POST distribution/invoices/:id/dispute': { auth: true, handler: tradeInvoiceDispute },
  'POST distribution/invoices/:id/dispute-resolve': { auth: true, handler: tradeInvoiceDisputeResolve },
  'GET distribution/trade-summary': { auth: true, handler: tradeSummaryCheckout },
  'GET deliveries/active/mine': { auth: true, handler: riderActiveDeliveries },
  'GET payment-funds': { auth: true, handler: paymentFundsList },
  'POST payment-funds': { auth: true, handler: paymentFundsCreate },
  'POST payment-funds/:id/fund': { auth: true, handler: paymentFundFund },
  'POST payment-funds/:id/withdraw': { auth: true, handler: paymentFundWithdraw },
  'GET scheduled-payments': { auth: true, handler: scheduledPaymentsList },
  'POST scheduled-payments': { auth: true, handler: scheduledPaymentsCreate },
  'PATCH scheduled-payments/:id': { auth: true, handler: scheduledPaymentPatch },
  'GET hubs/parcels/mine': { auth: true, handler: hubParcelsMine },
  'POST hubs/parcels': { auth: true, handler: hubParcelsCreate },
  'GET hubs/parcels/origins': { auth: true, handler: hubParcelsOriginCountries },
  'GET hubs/parcels/:id': { auth: true, handler: hubParcelGet },
  'POST hubs/parcels/:id/in-transit': { auth: true, handler: hubParcelInTransit },
  'POST hubs/parcels/:id/arrive': { auth: true, handler: hubParcelArrive },
  'POST hubs/parcels/:id/last-mile': { auth: true, handler: hubParcelLastMile },
  'POST hubs/parcels/:id/pickup': { auth: true, handler: hubParcelConfirmPickup },
  'GET businesses': { auth: true, handler: businessesList },
  'GET businesses/mine': { auth: true, handler: businessesMine },
  'GET businesses/:id': { auth: true, handler: businessDetail },
  'POST businesses/:id/status': { auth: true, handler: businessStatusUpdate },
  'POST businesses/:id/community-status': { auth: true, handler: businessCommunityStatusUpdate },
  'GET businesses/:id/wallet': { auth: true, handler: businessWalletHandler },
  'GET businesses/:id/credit-summary': { auth: true, handler: businessCreditSummaryHandler },
  'POST businesses/:id/transfer': { auth: true, handler: businessTransferHandler },
  'GET businesses/:id/members': { auth: true, handler: businessMembersHandler },
  'POST businesses/:id/members': { auth: true, handler: businessMembersHandler },
  'GET businesses/invitations/mine': { auth: true, handler: businessInvitationsMine },
  'POST businesses/:id/members/:subId/accept': { auth: true, handler: businessMemberAccept },
  'POST businesses/:id/members/:subId/remove': { auth: true, handler: businessMemberRemove },
  'GET businesses/:id/reviews': { auth: true, handler: businessReviewsList },
  'POST businesses/:id/reviews': { auth: true, handler: businessReviewsCreate },
  'GET businesses/:id/kebu-score': { auth: true, handler: businessKebuScoreGet },
  'GET charts': { auth: true, handler: chartsGet },
  'POST charts/submit': { auth: true, handler: chartsSubmit },
  'POST charts/vote': { auth: true, handler: chartsVote },
  'GET charts/search': { auth: true, handler: chartsSearch },
  'GET geo/search': { auth: true, handler: geoSearch },
  'GET profiles/:id': { auth: true, handler: publicProfileGet },
  'POST polls': { auth: true, handler: pollsAsk },
  'POST polls/:id/vote': { auth: true, handler: pollsVote },
  'GET channels': { auth: true, handler: channelsBrowse },
  'GET channels/mine': { auth: true, handler: channelsMine },
  'POST channels/mine': { auth: true, handler: channelsMine },
  'GET channels/feed': { auth: true, handler: channelsFeed },
  'POST channels/posts': { auth: true, handler: channelsPost },
  'POST channels/posts/:id/delete': { auth: true, handler: channelsPostDelete },
  'GET channels/:id': { auth: true, handler: channelsView },
  'POST channels/:id/follow': { auth: true, handler: channelsFollow },
  'POST businesses': { auth: true, handler: businessesCreate },
  'GET businesses/:id/payroll/groups': { auth: true, handler: payrollGroupsHandler },
  'POST businesses/:id/payroll/groups': { auth: true, handler: payrollGroupsHandler },
  'GET businesses/:id/payroll/employees': { auth: true, handler: payrollEmployeesHandler },
  'POST businesses/:id/payroll/employees': { auth: true, handler: payrollEmployeesHandler },
  'POST businesses/:id/payroll/pay': { auth: true, handler: payrollPayHandler },
  'POST businesses/:id/payroll/run': { auth: true, handler: payrollRunHandler },
  'GET businesses/:id/school/students': { auth: true, handler: schoolStudentsHandler },
  'POST businesses/:id/school/students': { auth: true, handler: schoolStudentsHandler },
  'GET businesses/:id/school/periods': { auth: true, handler: schoolPeriodsHandler },
  'POST businesses/:id/school/periods': { auth: true, handler: schoolPeriodsHandler },
  'GET businesses/:id/school/periods/:subId/status': { auth: true, handler: schoolPeriodStatusHandler },
  'POST businesses/:id/school/pay': { auth: true, handler: schoolPayHandler },
  'POST businesses/:id/school/remind': { auth: true, handler: schoolRemindHandler },
  'GET businesses/:id/cooperative/deliveries': { auth: true, handler: cooperativeDeliveriesHandler },
  'POST businesses/:id/cooperative/deliveries': { auth: true, handler: cooperativeDeliveriesHandler },
  'POST businesses/:id/cooperative/deliveries/:subId/verify': { auth: true, handler: cooperativeVerifyHandler },
  'POST businesses/:id/cooperative/payout': { auth: true, handler: cooperativePayoutHandler },
  'POST offline/sync': { auth: true, handler: offlineSyncHandler },
  'GET trust/blocks': { auth: true, handler: trustBlockHandler },
  'POST trust/block': { auth: true, handler: trustBlockHandler },
  'DELETE trust/block/:id': { auth: true, handler: trustUnblockHandler },
  'POST trust/report': { auth: true, handler: trustReportHandler },
  'GET trust/vouch': { auth: true, handler: vouchHandler },
  'POST trust/vouch': { auth: true, handler: vouchHandler },
  'POST calls/token': { auth: true, handler: callsToken },
  'POST merchants/:id/pay': { auth: true, handler: merchantPay },
  'GET merchants/:id/public': { auth: true, handler: merchantPublic },
  'GET merchant-vouchers/mine': { auth: true, handler: merchantVouchersMine },
  'GET tontine/groups': { auth: true, handler: tontineGroups },
  'POST tontine/groups': { auth: true, handler: tontineGroups },
  'GET tontine/groups/:id': { auth: true, handler: tontineGroupGet },
  'POST tontine/groups/:id/accept': { auth: true, handler: tontineAccept },
  'POST tontine/groups/:id/decline': { auth: true, handler: tontineDecline },
  'POST tontine/groups/:id/leave': { auth: true, handler: tontineLeave },
  'POST tontine/groups/:id/invite': { auth: true, handler: tontineInvite },
  'POST tontine/groups/:id/remove': { auth: true, handler: tontineRemove },
  'POST tontine/groups/:id/start': { auth: true, handler: tontineStart },
  'POST tontine/groups/:id/contribute': { auth: true, handler: tontineContribute },
  'POST tontine/groups/:id/release': { auth: true, handler: tontineRelease },
  'POST tontine/groups/:id/cancel': { auth: true, handler: tontineCancel },
  'GET friends': { auth: true, handler: friendsHandler },
  'POST friends': { auth: true, handler: friendsHandler },
  'GET friends/requests': { auth: true, handler: friendRequestsList },
  'POST friends/requests/:id/respond': { auth: true, handler: friendRequestRespond },
  // Re-enabled groups (previously stranded in api-disabled/ by the old
  // 12-function cap; the single-function router removes that limit)
  'POST auth/pin/set': { auth: true, handler: authPinSet },
  'POST auth/pin/verify': { auth: true, handler: authPinVerify },
  'POST auth/pin/unlock': { auth: true, handler: authPinUnlock },
  'POST auth/biometric': { auth: true, handler: authBiometric },
  'POST auth/device/verify': { auth: true, handler: authDeviceVerify },
  'GET kyc/status': { auth: true, handler: kycStatus },
  'POST kyc/cni/submit': { auth: true, handler: kycCniSubmit },
  'POST kyc/address/submit': { auth: true, handler: kycAddressSubmit },
  'POST kori/convert': { auth: true, handler: koriConvert },
  'GET kori/transactions': { auth: true, handler: koriTransactions },
  'GET kori/reserve': { auth: true, handler: koriReserve },
  'POST roles/:id': { auth: true, handler: rolesAssign },
  'GET sellers/profile': { auth: true, handler: sellersProfile },
  'POST sellers/profile': { auth: true, handler: sellersProfile },
  'GET drivers/profile': { auth: true, handler: driversProfile },
  'POST drivers/profile': { auth: true, handler: driversProfile },
  'GET workers/profile': { auth: true, handler: workersProfile },
  'POST workers/profile': { auth: true, handler: workersProfile },
  'GET workers/receipts': { auth: true, handler: workersReceipts },
  'GET workers/credit-summary': { auth: true, handler: workersCreditSummary },
  'GET deliveries/nearby': { auth: true, handler: deliveriesNearby },
  'POST deliveries': { auth: true, handler: deliveriesCreate },
  'GET deliveries/:id': { auth: true, handler: deliveryDetail },
  'POST deliveries/:id/accept': { auth: true, handler: deliveriesAccept },
  'POST deliveries/:id/claim': { auth: true, handler: deliveriesClaim },
  'POST deliveries/:id/pickup': { auth: true, handler: deliveriesPickup },
  'POST deliveries/:id/deliver': { auth: true, handler: deliveriesDeliver },
  'POST deliveries/:id/confirm': { auth: true, handler: deliveriesConfirm },
  'POST deliveries/:id/dispute': { auth: true, handler: deliveriesDispute },
  'POST deliveries/:id/dispute/evidence': { auth: true, handler: deliveriesDisputeEvidence },
  'POST deliveries/:id/dispute/resolve': { auth: true, handler: deliveriesDisputeResolve },
  'GET sms/preferences': { auth: true, handler: smsPreferencesGet },
  'POST sms/preferences': { auth: true, handler: smsPreferencesUpdate },
  'POST webhooks/julaya': { auth: false, handler: webhooksJulaya },
  'POST webhooks/stripe': { auth: false, handler: webhooksStripe },
  'POST webhooks/kyc/smile': { auth: false, handler: webhooksKycSmile },
  'POST webhooks/kyc/sumsub': { auth: false, handler: webhooksKycSumsub },
  'POST webhooks/sms/inbound': { auth: false, handler: webhooksSmsInbound },
  // Partner API (Kebu / shops) — auth via Bearer JOKO_API_KEY inside handlers
  'POST v1/checkout/sessions': { auth: false, handler: partnerCheckoutSessions },
  'POST v1/payments/collect': { auth: false, handler: partnerPaymentsCollect },
  'GET v1/payments/:reference': { auth: false, handler: partnerPaymentGet },
  'POST v1/payments/:reference/sandbox-complete': { auth: false, handler: partnerPaymentSandboxComplete },
  'POST v1/messages/send': { auth: false, handler: partnerMessagesSend },
  'GET v1/pay/:id': { auth: false, handler: partnerPayPage },
  'POST v1/pay/:id/confirm': { auth: false, handler: partnerPayConfirm },
  'POST v1/pos/sessions': { auth: false, handler: partnerPosSessions },
  'GET v1/pos/:reference': { auth: false, handler: partnerPosGet },
  'POST v1/payouts': { auth: false, handler: partnerPayoutsCreate },
  'GET v1/payouts/:reference': { auth: false, handler: partnerPayoutGet },
  'POST v1/payouts/:reference/sandbox-complete': { auth: false, handler: partnerPayoutSandboxComplete },
  'POST v1/support/agents': { auth: false, handler: partnerSupportAgentsCreate },
  'GET v1/support/agents': { auth: false, handler: partnerSupportAgentsList },
  'POST v1/support/threads': { auth: false, handler: partnerSupportThreadsCreate },
  'GET v1/support/threads': { auth: false, handler: partnerSupportThreadsList },
  'POST v1/support/threads/:id/assign': { auth: false, handler: partnerSupportThreadAssign },
  'POST v1/support/threads/:id/messages': { auth: false, handler: partnerSupportThreadMessage },
  'DELETE friends/:id': { auth: true, handler: friendsRemove },
  'GET notifications': { auth: true, handler: notificationsList },
  'POST notifications/:id/read': { auth: true, handler: notificationsRead },
  'GET cron/daily': { auth: false, handler: cronDailyAll },
  'POST cron/daily': { auth: false, handler: cronDailyAll },
  'GET cron/scheduled-payments': { auth: false, handler: cronScheduledPayments },
  'POST cron/scheduled-payments': { auth: false, handler: cronScheduledPayments },
  'GET cron/financial-integrity': { auth: false, handler: cronFinancialIntegrity },
  'POST cron/financial-integrity': { auth: false, handler: cronFinancialIntegrity },
  'GET cron/pending-transactions': { auth: false, handler: cronPendingTransactions },
  'POST cron/pending-transactions': { auth: false, handler: cronPendingTransactions },
  'GET cron/fraud-monitor': { auth: false, handler: cronFraudMonitor },
  'POST cron/fraud-monitor': { auth: false, handler: cronFraudMonitor },
  'GET cron/tontine-processor': { auth: false, handler: cronTontineProcessor },
  'POST cron/tontine-processor': { auth: false, handler: cronTontineProcessor },
  'GET cron/rider-status': { auth: false, handler: cronRiderStatus },
  'POST cron/rider-status': { auth: false, handler: cronRiderStatus },
  'GET cron/daily-financial-report': { auth: false, handler: cronDailyFinancialReport },
  'POST cron/daily-financial-report': { auth: false, handler: cronDailyFinancialReport },
  'GET cron/delivery-auto-release': { auth: false, handler: cronDeliveryAutoRelease },
  'POST cron/delivery-auto-release': { auth: false, handler: cronDeliveryAutoRelease },
  'GET cron/agent-monthly-payout': { auth: false, handler: cronAgentMonthlyPayout },
  'POST cron/agent-monthly-payout': { auth: false, handler: cronAgentMonthlyPayout },
  // Admin panel (/admin UI → /api/admin/*)
  'POST admin/auth/bootstrap': { adminAuth: false, handler: adminAuthBootstrap },
  'POST admin/auth/login': { adminAuth: false, handler: adminAuthLogin },
  'POST admin/auth/setup-2fa': { adminAuth: false, handler: adminAuthSetup2fa },
  'POST admin/auth/confirm-2fa': { adminAuth: false, handler: adminAuthConfirm2fa },
  'POST admin/auth/verify-2fa': { adminAuth: false, handler: adminAuthVerify2fa },
  'POST admin/auth/logout': { adminAuth: true, handler: adminAuthLogout },
  'GET admin/dashboard': { adminAuth: true, handler: adminDashboard },
  'GET admin/held-transactions': { adminAuth: true, handler: adminHeldTransactionsList },
  'POST admin/held-transactions/:id/approve': { adminAuth: true, handler: adminHeldTransactionApprove },
  'POST admin/held-transactions/:id/reject': { adminAuth: true, handler: adminHeldTransactionReject },
  'GET admin/fraud-alerts': { adminAuth: true, handler: adminFraudAlerts },
  'POST admin/fraud-alerts/:id/ack': { adminAuth: true, handler: adminFraudAlertAck },
  'GET admin/transactions/:id': { adminAuth: true, handler: adminTransactionDetail },
  'POST admin/users/:id/freeze': { adminAuth: true, handler: adminFreezeUser },
  'POST admin/users/:id/unfreeze': { adminAuth: true, handler: adminUnfreezeUser },
  'POST admin/users/:id/credentials/invalidate': { adminAuth: true, handler: adminInvalidateCredentials },
  'POST admin/rails/:id/release': { adminAuth: true, handler: adminReleaseRail },
  'POST admin/refunds': { adminAuth: true, handler: adminIssueRefund },
  'GET admin/support-tickets': { adminAuth: true, handler: adminSupportTicketsList },
  'GET admin/support-tickets/:id': { adminAuth: true, handler: adminSupportTicketById },
  'POST admin/support-tickets/:id': { adminAuth: true, handler: adminSupportTicketById },
  'PATCH admin/support-tickets/:id': { adminAuth: true, handler: adminSupportTicketById },
  'GET admin/reports/daily': { adminAuth: true, handler: adminReportsDaily },
  'GET admin/agents': { adminAuth: true, handler: adminAgentsList },
  'POST admin/agents': { adminAuth: true, handler: adminAgentsCreate },
  'GET admin/agents/reconcile': { adminAuth: true, handler: adminAgentsReconcile },
  'POST admin/agents/:id/float': { adminAuth: true, handler: adminAgentsFloat },
  'POST admin/agents/:id/approve': { adminAuth: true, handler: adminAgentsApprove },
  'POST admin/agents/:id/reject': { adminAuth: true, handler: adminAgentsReject },
  'GET admin/agent-float-requests': { adminAuth: true, handler: adminAgentFloatRequestsList },
  'POST admin/agent-float-requests/:id/approve': { adminAuth: true, handler: adminAgentFloatRequestApprove },
  'POST admin/agent-float-requests/:id/reject': { adminAuth: true, handler: adminAgentFloatRequestReject },
  'PATCH admin/agents/:id': { adminAuth: true, handler: adminAgentsPatch },
  'GET admin/audit-logs': { adminAuth: true, handler: adminAuditLogs },
  'GET admin/users': { adminAuth: true, handler: adminUsersSearch },
  'GET admin/users/:id': { adminAuth: true, handler: adminUserDetail },
  'GET admin/kyc/queue': { adminAuth: true, handler: adminKycQueue },
  'POST admin/kyc/:id/approve': { adminAuth: true, handler: adminKycApprove },
  'POST admin/kyc/:id/reject': { adminAuth: true, handler: adminKycReject },
  'POST admin/kyc/address/approve': { adminAuth: true, handler: adminKycAddressApprove },
  'GET admin/distributors': { adminAuth: true, handler: adminDistributorsList },
  'GET admin/distributors/:id': { adminAuth: true, handler: adminDistributorDetail },
  'PATCH admin/distributors/:id': { adminAuth: true, handler: adminDistributorPatch },
  'GET admin/support/stats': { adminAuth: true, handler: adminSupportStats },
  'GET admin/support/calls': { adminAuth: true, handler: adminSupportCallsList },
  'POST admin/support/calls': { adminAuth: true, handler: adminSupportCallLog },
  'GET admin/ops/health': { adminAuth: true, handler: adminOpsHealth },
  'GET admin/money/position': { adminAuth: true, handler: adminMoneyPosition },
  'GET admin/money/exceptions': { adminAuth: true, handler: adminMoneyExceptions },
  'POST admin/money/statements': { adminAuth: true, handler: adminMoneyImportStatement },
  'GET admin/money/adjustments': { adminAuth: true, handler: adminMoneyAdjustments },
  'POST admin/money/adjustments': { adminAuth: true, handler: adminMoneyAdjustments },
  'POST admin/money/adjustments/:id/approve': { adminAuth: true, handler: adminMoneyAdjustmentApprove },
  'POST admin/money/adjustments/:id/reject': { adminAuth: true, handler: adminMoneyAdjustmentReject },
  // J3 identity, separation of duties, maker-checker
  'GET admin/me': { adminAuth: true, handler: adminMe },
  'GET admin/admins': { adminAuth: true, handler: adminAdminsList },
  'POST admin/admins/:id/roles': { adminAuth: true, handler: adminAdminRoleRequest },
  'POST admin/admins/:id/roles/:subId/revoke': { adminAuth: true, handler: adminAdminRoleRevoke },
  'GET admin/approvals': { adminAuth: true, handler: adminApprovalsList },
  'POST admin/approvals/:id/approve': { adminAuth: true, handler: adminApprovalApprove },
  'POST admin/approvals/:id/reject': { adminAuth: true, handler: adminApprovalReject },
  'POST admin/couriers/:id/approve': { adminAuth: true, handler: adminCourierApprove },
  'POST admin/couriers/:id/suspend': { adminAuth: true, handler: adminCourierSuspend },
  'POST admin/couriers/:id/revoke': { adminAuth: true, handler: adminCourierRevoke },
  'POST admin/agents/:id/suspend': { adminAuth: true, handler: adminAgentsSuspend },
  'GET admin/identity-events': { adminAuth: true, handler: adminIdentityEvents },
  'GET admin/money/lookup': { adminAuth: true, handler: adminMoneyLookupHandler },
  'GET admin/money/limits-usage': { adminAuth: true, handler: adminMoneyLimitsUsageHandler },
};

const PARAM_PATTERNS = [
  [/^money\/activity\/([^/]+)$/, 'money/activity/:reference'],
  [/^money\/intents\/([^/]+)$/, 'money/intents/:id'],
  [/^money\/charges\/([^/]+)\/pay$/, 'money/charges/:id/pay'],
  [/^money\/charges\/([^/]+)\/cancel$/, 'money/charges/:id/cancel'],
  [/^money\/charges\/([^/]+)$/, 'money/charges/:id'],
  [/^money\/payments\/([^/]+)\/refund$/, 'money/payments/:reference/refund'],
  [/^auth\/sessions\/([^/]+)\/revoke$/, 'auth/sessions/:id/revoke'],
  [/^auth\/devices\/([^/]+)\/revoke$/, 'auth/devices/:id/revoke'],
  [/^businesses\/([^/]+)\/members\/([^/]+)\/accept$/, 'businesses/:id/members/:subId/accept'],
  [/^businesses\/([^/]+)\/members\/([^/]+)\/remove$/, 'businesses/:id/members/:subId/remove'],
  [/^admin\/admins\/([^/]+)\/roles\/([^/]+)\/revoke$/, 'admin/admins/:id/roles/:subId/revoke'],
  [/^admin\/admins\/([^/]+)\/roles$/, 'admin/admins/:id/roles'],
  [/^admin\/approvals\/([^/]+)\/approve$/, 'admin/approvals/:id/approve'],
  [/^admin\/approvals\/([^/]+)\/reject$/, 'admin/approvals/:id/reject'],
  [/^admin\/couriers\/([^/]+)\/approve$/, 'admin/couriers/:id/approve'],
  [/^admin\/couriers\/([^/]+)\/suspend$/, 'admin/couriers/:id/suspend'],
  [/^admin\/couriers\/([^/]+)\/revoke$/, 'admin/couriers/:id/revoke'],
  [/^admin\/agents\/([^/]+)\/suspend$/, 'admin/agents/:id/suspend'],
  [/^marketplace\/shops\/([^/]+)$/, 'marketplace/shops/:id'],
  [/^marketplace\/products\/([^/]+)\/view$/, 'marketplace/products/:id/view'],
  [/^marketplace\/products\/([^/]+)$/, 'marketplace/products/:id'],
  [/^marketplace\/business\/([^/]+)\/settings$/, 'marketplace/business/:id/settings'],
  [/^marketplace\/orders\/([^/]+)\/confirm$/, 'marketplace/orders/:id/confirm'],
  [/^marketplace\/orders\/([^/]+)\/status$/, 'marketplace/orders/:id/status'],
  [/^marketplace\/orders\/([^/]+)$/, 'marketplace/orders/:id'],
  [/^admin\/users\/([^/]+)$/, 'admin/users/:id'],
  [/^admin\/distributors\/([^/]+)$/, 'admin/distributors/:id'],
  [/^admin\/kyc\/([^/]+)\/approve$/, 'admin/kyc/:id/approve'],
  [/^admin\/kyc\/([^/]+)\/reject$/, 'admin/kyc/:id/reject'],
  [/^support\/tickets\/([^/]+)\/reply$/, 'support/tickets/:id/reply'],
  [/^support\/tickets\/([^/]+)$/, 'support/tickets/:id'],
  [/^distribution\/invoices\/([^/]+)\/pay$/, 'distribution/invoices/:id/pay'],
  [/^distribution\/invoices\/([^/]+)\/dispute-resolve$/, 'distribution/invoices/:id/dispute-resolve'],
  [/^distribution\/invoices\/([^/]+)\/dispute$/, 'distribution/invoices/:id/dispute'],
  [/^payment-funds\/([^/]+)\/fund$/, 'payment-funds/:id/fund'],
  [/^payment-funds\/([^/]+)\/withdraw$/, 'payment-funds/:id/withdraw'],
  [/^scheduled-payments\/([^/]+)$/, 'scheduled-payments/:id'],
  [/^hubs\/parcels\/([^/]+)\/in-transit$/, 'hubs/parcels/:id/in-transit'],
  [/^hubs\/parcels\/([^/]+)\/arrive$/, 'hubs/parcels/:id/arrive'],
  [/^hubs\/parcels\/([^/]+)\/last-mile$/, 'hubs/parcels/:id/last-mile'],
  [/^hubs\/parcels\/([^/]+)\/pickup$/, 'hubs/parcels/:id/pickup'],
  [/^hubs\/parcels\/(?!mine$|origins$)([^/]+)$/, 'hubs/parcels/:id'],
  [/^events\/([^/]+)\/tickets$/, 'events/:id/tickets'],
  [/^events\/([^/]+)\/check-in$/, 'events/:id/check-in'],
  [/^events\/([^/]+)\/scan-stats$/, 'events/:id/scan-stats'],
  [/^events\/mine$/, 'events/mine'],
  [/^tickets\/mine$/, 'tickets/mine'],
  [/^tickets\/check-in$/, 'tickets/check-in'],
  [/^jekkal\/campaigns\/mine$/, 'jekkal/campaigns/mine'],
  [/^jekkal\/campaigns\/([^/]+)\/contribute$/, 'jekkal/campaigns/:id/contribute'],
  [/^jekkal\/campaigns\/([^/]+)$/, 'jekkal/campaigns/:id'],
  [/^affiliate\/resolve\/([^/]+)$/, 'affiliate/resolve/:code'],
  [/^affiliate\/links\/([^/]+)\/click$/, 'affiliate/links/:code/click'],
  [/^businesses\/mine$/, 'businesses/mine'],
  [/^businesses\/([^/]+)\/payroll\/groups$/, 'businesses/:id/payroll/groups'],
  [/^businesses\/([^/]+)\/payroll\/employees$/, 'businesses/:id/payroll/employees'],
  [/^businesses\/([^/]+)\/payroll\/pay$/, 'businesses/:id/payroll/pay'],
  [/^businesses\/([^/]+)\/payroll\/run$/, 'businesses/:id/payroll/run'],
  [/^businesses\/([^/]+)\/school\/students$/, 'businesses/:id/school/students'],
  [/^businesses\/([^/]+)\/school\/periods\/([^/]+)\/status$/, 'businesses/:id/school/periods/:subId/status'],
  [/^businesses\/([^/]+)\/school\/periods$/, 'businesses/:id/school/periods'],
  [/^businesses\/([^/]+)\/school\/pay$/, 'businesses/:id/school/pay'],
  [/^businesses\/([^/]+)\/school\/remind$/, 'businesses/:id/school/remind'],
  [/^businesses\/([^/]+)\/cooperative\/deliveries\/([^/]+)\/verify$/, 'businesses/:id/cooperative/deliveries/:subId/verify'],
  [/^businesses\/([^/]+)\/cooperative\/deliveries$/, 'businesses/:id/cooperative/deliveries'],
  [/^businesses\/([^/]+)\/cooperative\/payout$/, 'businesses/:id/cooperative/payout'],
  [/^businesses\/([^/]+)\/wallet$/, 'businesses/:id/wallet'],
  [/^businesses\/([^/]+)\/credit-summary$/, 'businesses/:id/credit-summary'],
  [/^businesses\/([^/]+)\/transfer$/, 'businesses/:id/transfer'],
  [/^businesses\/([^/]+)\/members$/, 'businesses/:id/members'],
  [/^businesses\/([^/]+)\/status$/, 'businesses/:id/status'],
  [/^businesses\/([^/]+)\/community-status$/, 'businesses/:id/community-status'],
  [/^businesses\/([^/]+)\/kebu-score$/, 'businesses/:id/kebu-score'],
  [/^businesses\/([^/]+)$/, 'businesses/:id'],
  [/^trust\/block\/([^/]+)$/, 'trust/block/:id'],
  [/^transfers\/([^/]+)\/undo$/, 'transfers/:reference/undo'],
  [/^v1\/payments\/([^/]+)\/sandbox-complete$/, 'v1/payments/:reference/sandbox-complete'],
  [/^v1\/payments\/([^/]+)$/, 'v1/payments/:reference'],
  [/^v1\/payouts\/([^/]+)\/sandbox-complete$/, 'v1/payouts/:reference/sandbox-complete'],
  [/^v1\/payouts\/([^/]+)$/, 'v1/payouts/:reference'],
  [/^v1\/pos\/([^/]+)$/, 'v1/pos/:reference'],
  [/^v1\/support\/threads\/([^/]+)\/assign$/, 'v1/support/threads/:id/assign'],
  [/^v1\/support\/threads\/([^/]+)\/messages$/, 'v1/support/threads/:id/messages'],
  [/^v1\/pay\/([^/]+)\/confirm$/, 'v1/pay/:id/confirm'],
  [/^v1\/pay\/([^/]+)$/, 'v1/pay/:id'],
  [/^mbolo\/threads\/([^/]+)\/messages$/, 'mbolo/threads/:id/messages'],
  [/^mbolo\/threads\/([^/]+)\/members$/, 'mbolo/threads/:id/members'],
  [/^mbolo\/threads\/([^/]+)\/accept$/, 'mbolo/threads/:id/accept'],
  [/^mbolo\/threads\/([^/]+)\/decline$/, 'mbolo/threads/:id/decline'],
  [/^mbolo\/threads\/([^/]+)\/block$/, 'mbolo/threads/:id/block'],
  [/^mbolo\/threads\/([^/]+)\/report$/, 'mbolo/threads/:id/report'],
  [/^mbolo\/threads\/([^/]+)\/invite$/, 'mbolo/threads/:id/invite'],
  [/^mbolo\/threads\/([^/]+)\/presence$/, 'mbolo/threads/:id/presence'],
  [/^mbolo\/threads\/([^/]+)\/typing$/, 'mbolo/threads/:id/typing'],
  [/^mbolo\/threads\/([^/]+)\/read$/, 'mbolo/threads/:id/read'],
  [/^mbolo\/messages\/([^/]+)\/save$/, 'mbolo/messages/:id/save'],
  [/^mbolo\/vault\/([^/]+)$/, 'mbolo/vault/:id'],
  [/^mbolo\/gifs\/([^/]+)\/use$/, 'mbolo/gifs/:id/use'],
  [/^transfers\/requests\/([^/]+)\/accept$/, 'transfers/requests/:id/accept'],
  [/^transfers\/requests\/([^/]+)\/deny$/, 'transfers/requests/:id/deny'],
  [/^transfers\/requests\/([^/]+)\/cancel$/, 'transfers/requests/:id/cancel'],
  [/^transfers\/requests\/([^/]+)$/, 'transfers/requests/:id'],
  [/^trending\/alerts\/([^/]+)\/share$/, 'trending/alerts/:id/share'],
  [/^trending\/alerts\/([^/]+)\/read$/, 'trending/alerts/:id/read'],
  [/^trending\/alerts\/([^/]+)$/, 'trending/alerts/:id'],
  [/^merchants\/([^/]+)\/public$/, 'merchants/:id/public'],
  [/^merchants\/([^/]+)\/pay$/, 'merchants/:id/pay'],
  [/^tontine\/groups\/([^/]+)\/release$/, 'tontine/groups/:id/release'],
  [/^tontine\/groups\/([^/]+)\/accept$/, 'tontine/groups/:id/accept'],
  [/^tontine\/groups\/([^/]+)\/decline$/, 'tontine/groups/:id/decline'],
  [/^tontine\/groups\/([^/]+)\/leave$/, 'tontine/groups/:id/leave'],
  [/^tontine\/groups\/([^/]+)\/invite$/, 'tontine/groups/:id/invite'],
  [/^tontine\/groups\/([^/]+)\/remove$/, 'tontine/groups/:id/remove'],
  [/^tontine\/groups\/([^/]+)\/start$/, 'tontine/groups/:id/start'],
  [/^tontine\/groups\/([^/]+)\/contribute$/, 'tontine/groups/:id/contribute'],
  [/^tontine\/groups\/([^/]+)\/cancel$/, 'tontine/groups/:id/cancel'],
  [/^tontine\/groups\/([^/]+)$/, 'tontine/groups/:id'],
  [/^friends\/requests\/([^/]+)\/respond$/, 'friends/requests/:id/respond'],
  [/^friends\/(?!requests$|requests\/)([^/]+)$/, 'friends/:id'],
  [/^notifications\/([^/]+)\/read$/, 'notifications/:id/read'],
  [/^businesses\/([^/]+)\/reviews$/, 'businesses/:id/reviews'],
  [/^profiles\/([^/]+)$/, 'profiles/:id'],
  [/^polls\/([^/]+)\/vote$/, 'polls/:id/vote'],
  [/^channels\/posts\/([^/]+)\/delete$/, 'channels/posts/:id/delete'],
  [/^channels\/(?!mine$|feed$|posts$)([^/]+)\/follow$/, 'channels/:id/follow'],
  [/^channels\/(?!mine$|feed$|posts$)([^/]+)$/, 'channels/:id'],
  [/^roles\/([^/]+)$/, 'roles/:id'],
  [/^deliveries\/([^/]+)\/dispute\/evidence$/, 'deliveries/:id/dispute/evidence'],
  [/^deliveries\/([^/]+)\/dispute\/resolve$/, 'deliveries/:id/dispute/resolve'],
  [/^deliveries\/([^/]+)\/dispute$/, 'deliveries/:id/dispute'],
  [/^deliveries\/([^/]+)\/accept$/, 'deliveries/:id/accept'],
  [/^deliveries\/([^/]+)\/claim$/, 'deliveries/:id/claim'],
  [/^deliveries\/([^/]+)\/pickup$/, 'deliveries/:id/pickup'],
  [/^deliveries\/([^/]+)\/deliver$/, 'deliveries/:id/deliver'],
  [/^deliveries\/([^/]+)\/confirm$/, 'deliveries/:id/confirm'],
  [/^deliveries\/(?!nearby$)([^/]+)$/, 'deliveries/:id'],
  [/^admin\/agents\/([^/]+)\/float$/, 'admin/agents/:id/float'],
  [/^admin\/agents\/([^/]+)\/approve$/, 'admin/agents/:id/approve'],
  [/^admin\/agents\/([^/]+)\/reject$/, 'admin/agents/:id/reject'],
  [/^admin\/agents\/reconcile$/, 'admin/agents/reconcile'],
  [/^admin\/agent-float-requests\/([^/]+)\/approve$/, 'admin/agent-float-requests/:id/approve'],
  [/^admin\/agent-float-requests\/([^/]+)\/reject$/, 'admin/agent-float-requests/:id/reject'],
  [/^agents\/nearby$/, 'agents/nearby'],
  [/^agent\/payouts$/, 'agent/payouts'],
  [/^deposits\/card\/([^/]+)$/, 'deposits/card/:reference'],
  [/^deposits\/agent\/([^/]+)$/, 'deposits/agent/:reference'],
  [/^withdrawals\/agent\/([^/]+)$/, 'withdrawals/agent/:reference'],
  [/^agent\/withdrawals\/([^/]+)\/confirm$/, 'agent/withdrawals/:id/confirm'],
  [/^agent\/deposits\/([^/]+)\/confirm$/, 'agent/deposits/:id/confirm'],
  [/^admin\/agents\/([^/]+)$/, 'admin/agents/:id'],
  [/^admin\/users\/([^/]+)\/unfreeze$/, 'admin/users/:id/unfreeze'],
  [/^admin\/users\/([^/]+)\/credentials\/invalidate$/, 'admin/users/:id/credentials/invalidate'],
  [/^admin\/held-transactions\/([^/]+)\/approve$/, 'admin/held-transactions/:id/approve'],
  [/^admin\/held-transactions\/([^/]+)\/reject$/, 'admin/held-transactions/:id/reject'],
  [/^admin\/fraud-alerts\/([^/]+)\/ack$/, 'admin/fraud-alerts/:id/ack'],
  [/^admin\/transactions\/([^/]+)$/, 'admin/transactions/:id'],
  [/^admin\/users\/([^/]+)\/freeze$/, 'admin/users/:id/freeze'],
  [/^admin\/rails\/([^/]+)\/release$/, 'admin/rails/:id/release'],
  [/^admin\/money\/adjustments\/([^/]+)\/approve$/, 'admin/money/adjustments/:id/approve'],
  [/^admin\/money\/adjustments\/([^/]+)\/reject$/, 'admin/money/adjustments/:id/reject'],
  [/^admin\/support-tickets\/([^/]+)$/, 'admin/support-tickets/:id'],
];

function matchRoute(method, path) {
  const direct = ROUTES[`${method} ${path}`];
  if (direct) return { route: direct, params: {}, key: path };

  for (const [regex, key] of PARAM_PATTERNS) {
    const m = path.match(regex);
    if (m) {
      const route = ROUTES[`${method} ${key}`];
      if (route) {
        const dec = (v) => {
          try {
            return decodeURIComponent(v);
          } catch {
            return v;
          }
        };
        const params = { id: dec(m[1]) };
        if (key.includes(':subId') && m[2]) params.subId = dec(m[2]);
        if (key.includes(':reference') && m[1]) params.reference = dec(m[1]);
        return { route, params, key };
      }
    }
  }

  return null;
}

function enforceHttps(req, res) {
  if (process.env.NODE_ENV !== 'production') return true;
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto !== 'https') {
    res.status(403).json({ error: 'HTTPS required' });
    return false;
  }
  return true;
}

async function assertAdminRouteAccess(req, res, requireAuth) {
  if (!requireAuth) return true;
  const session = await getAdminFromBearer(req.headers.authorization);
  if (session) {
    req.adminId = session.adminId;
    req.adminSessionId = session.sessionId;
    req.admin = session.admin;
    return true;
  }
  // J3: the shared ADMIN_API_KEY is retired — it was an unattributable
  // god-mode credential. Operators authenticate as themselves (password +
  // TOTP) and are authorized by their AdminRoleGrant rows only.
  if (req.headers['x-admin-key']) {
    res.status(401).json({ error: 'The shared admin key is retired — sign in as an operator.', code: 'legacy_admin_key_retired' });
    return false;
  }
  res.status(401).json({ error: 'Admin authorization required' });
  return false;
}

/** Route table snapshot (method, pattern, auth kind) — used by the data-exposure sweep. */
export function listRoutes() {
  return Object.entries(ROUTES).map(([k, r]) => {
    const [method, ...rest] = k.split(' ');
    const auth = r.adminAuth ? 'admin' : r.partnerAuth ? 'partner' : r.auth ? 'user' : 'public';
    return { method, path: rest.join(' '), auth };
  });
}

export async function dispatchApi(req, res, pathSegments) {
  setCors(res);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Admin-Key, X-Api-Key, X-Device-Id, X-Step-Up-Token, X-Low-Data, Idempotency-Key',
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!enforceHttps(req, res)) return;

  const path = Array.isArray(pathSegments) ? pathSegments.filter(Boolean).join('/') : String(pathSegments ?? '');
  const matched = matchRoute(req.method, path);
  if (!matched) {
    res.status(404).json({ error: 'Not found', path: `/api/${path}` });
    return;
  }

  if (matched.params && Object.keys(matched.params).length) {
    req.query = { ...req.query, ...matched.params };
  }

  // Never let credential material out, whatever a handler serializes.
  const rawJson = res.json.bind(res);
  res.json = (body) => {
    const stripped = new Set();
    const clean = scrubSecrets(body, 0, (k) => stripped.add(k));
    if (stripped.size) {
      console.warn(`[scrubber] stripped ${[...stripped].join(',')} on ${req.method} ${matched.key ?? path}`);
    }
    return rawJson(clean);
  };

  let userId = null;
  try {
    // Rate limits run inside the single dispatcher so EVERY route is covered.
    const routeKey = `${req.method} ${path}`;
    await enforceAuthRouteLimits(routeKey, req);

    if (matched.route.adminAuth) {
      if (!(await assertAdminRouteAccess(req, res, true))) return;
    } else if (matched.route.adminAuth === false && path.startsWith('admin/')) {
      // Public admin auth endpoints (login, bootstrap, 2FA setup)
    } else if (matched.route.auth) {
      userId = await getUserIdFromRequest(req);
      if (!userId) {
        // Tell the user WHY — a locked account hidden behind a generic
        // "Invalid or expired token" is an unrecoverable dead end.
        const authErr = req._authError;
        // Pre-launch, no real user data at stake yet: always echo the
        // precise internal reason. A non-technical founder can only ever
        // hand us a screenshot — this makes that screenshot conclusive
        // instead of another guessing round. (Gate this behind a flag
        // once the app has real users.)
        const debug = process.env.NODE_ENV === 'production' ? undefined : authErr?.debug;
        if (authErr?.code === 'account_locked') {
          res.status(423).json({
            error: 'Compte verrouillé après plusieurs codes PIN erronés — utilise « Récupérer mon accès » pour le débloquer.',
            code: 'account_locked',
            debug,
          });
        } else if (authErr?.code === 'account_frozen') {
          res.status(423).json({
            error: 'Compte suspendu — contacte le support K21.',
            code: 'account_frozen',
            debug,
          });
        } else if (authErr?.code === 'session_inactive') {
          res.status(401).json({
            error: 'Session expirée après 30 min d’inactivité — reconnecte-toi.',
            code: 'session_inactive',
            debug,
          });
        } else if (authErr?.code === 'token_expired') {
          res.status(401).json({
            error: 'Ta session a expiré — reconnecte-toi.',
            code: 'token_expired',
            debug,
          });
        } else if (authErr?.code === 'user_not_found') {
          res.status(401).json({
            error: 'Compte introuvable — reconnecte-toi.',
            code: 'user_not_found',
            debug,
          });
        } else if (authErr?.code === 'no_token') {
          res.status(401).json({ error: 'Non connecté.', code: 'no_token', debug });
        } else {
          res.status(401).json({
            error: 'Session invalide — reconnecte-toi.',
            code: authErr?.code ?? 'token_invalid',
            debug,
          });
        }
        return;
      }
      req.userId = userId;
      await enforceRateLimit(userId);
      await enforceSensitiveRouteLimit(routeKey, userId);
    } else if (path.startsWith('admin/')) {
      if (!(await assertAdminRouteAccess(req, res, matched.route.adminAuth !== false))) return;
    }

    // J3: the permission matrix is enforced centrally for EVERY route
    // (actor, operator permission, active role, cash-out / sensitive-change
    // guards). A route without a policy is refused.
    if (!(await enforceRoutePolicy(req, res, `${req.method} ${matched.key}`))) return;

    if (userId && isSensitiveRoute(routeKey)) {
      await withIdempotency(req, res, { userId, routeKey }, () => matched.route.handler(req, res));
    } else {
      await matched.route.handler(req, res);
    }
  } catch (error) {
    if (error instanceof TooManyRequestsError || error instanceof RateLimitError || error instanceof SecurityBlockError) {
      if (!res.headersSent) res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    console.error('[api]', path, safeError(error));
    captureServerError(error, { path: `/api/${path}`, method: req.method, userId });
    if (!res.headersSent) {
      const prismaInit =
        error.name === 'PrismaClientInitializationError' ||
        error.code === 'P1001' ||
        error.message?.includes('DATABASE_URL');
      if (prismaInit) {
        res.status(503).json({
          error: databaseConfigured() ? 'Database temporarily unavailable' : 'Server not configured — DATABASE_URL missing',
          code: 'db_unavailable',
        });
        return;
      }
      if (error.code === 'auth_not_configured' || error.message?.includes('Missing or invalid JWT')) {
        res.status(503).json({
          error: 'Connexion temporairement indisponible. Réessaie dans quelques minutes.',
          code: 'auth_not_configured',
        });
        return;
      }
      // Prisma P2021/P2022: table or column missing — the deployed code is
      // newer than the database. Say so, instead of a mute 500.
      if (error.code === 'P2021' || error.code === 'P2022') {
        res.status(503).json({
          error: 'Mise à jour en cours — la base de données n’est pas encore synchronisée. Réessaie dans quelques minutes.',
          code: 'db_schema_outdated',
        });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  } finally {
    await logApiCall(req, res, userId ?? req.adminId ?? null);
  }
}

export async function prepareApiBody(req) {
  // Read the raw stream ourselves so webhook HMACs verify the exact bytes.
  if (req.rawBody == null && req.body == null && req.readable) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.rawBody = Buffer.concat(chunks).toString('utf8');
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.includes('application/x-www-form-urlencoded')) {
      req.body = Object.fromEntries(new URLSearchParams(req.rawBody).entries());
    } else {
      try {
        req.body = req.rawBody ? JSON.parse(req.rawBody) : {};
      } catch {
        req.body = {};
      }
    }
    return;
  }
  if (typeof req.body === 'string' && req.rawBody == null) req.rawBody = req.body;
  req.body = await readJson(req);
}

export { validationError };
