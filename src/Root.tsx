import { createCsvHistoricalAdapter } from "./adapter/csv-historical.ts";
import { OpenChartsProvider } from "./adapter/provider.tsx";
import { Terminal } from "./terminal/Terminal.tsx";

const adapter = createCsvHistoricalAdapter();

export function Root() {
  return (
    <OpenChartsProvider adapter={adapter}>
      <Terminal />
    </OpenChartsProvider>
  );
}
