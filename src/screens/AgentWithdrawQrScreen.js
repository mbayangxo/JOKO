import AgentCashScreen from './AgentCashScreen';

/** J6: cash-out at an agent — funds held at request, PIN authorization of the bound point. */
export default function AgentWithdrawQrScreen(props) {
  return <AgentCashScreen {...props} kind="cash_out" />;
}
