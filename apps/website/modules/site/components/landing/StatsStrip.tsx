/** Four numbers under the hero. `HeroSection` counts each from the code that holds it (the packages, the chain's steps, the fakes, the MCP tools), so none can drift from the page it describes. */
export function StatsStrip({ packages, layers, fakes, tools }: { packages: number; layers: number; fakes: number; tools: number }) {
  const stats = [
    { value: packages, label: 'packages, released as one version' },
    { value: layers, label: 'layers where a typo is a compile error, from the migration to the form error' },
    { value: fakes, label: 'fakes that come with createTestApp()' },
    { value: tools, label: 'MCP tools your coding agent can call' },
  ];
  return (
    <dl className="stats">
      {stats.map(({ value, label }) => (
        <div key={label} className="stat">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
