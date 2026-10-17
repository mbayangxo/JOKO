import AgentCashScreen from './AgentCashScreen';

/** J6: cash-in at an agent — see AgentCashScreen (secure handoff, no bearer QR). */
export default function AgentDepositQrScreen(props) {
  return <AgentCashScreen {...props} kind="cash_in" />;
}
