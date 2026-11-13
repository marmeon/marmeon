/** The state of one service. */
export function Badge({ state }: { state: string }) {
  return (
    <span data-badge="" data-state={state}>
      {state}
    </span>
  );
}
