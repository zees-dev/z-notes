/* Mermaid on first use. The build resolves every `mermaid` import but this
   file's own to this facade (server/frontend.ts `lazyMermaid`). The diagram
   block only calls initialize (sync), parse and render (both awaited), so a
   facade that queues every initialize and replays it, in order, on the real
   module keeps the ADR 0010 locks exactly as written while the ~640 KB of
   mermaid chunks stay out of the island's static graph until a doc actually
   holds a fence. Verified against @blocknote/diagram-block 0.54.2's dist:
   re-check which mermaid members it calls on any BlockNote bump. */
type Mermaid = (typeof import('mermaid'))['default'];
type Config = Parameters<Mermaid['initialize']>[0];

const configs: Config[] = [];
let real: Promise<Mermaid> | null = null;
let loaded: Mermaid | null = null;

const load = () =>
  (real ||= import('mermaid').then((m) => {
    for (const c of configs) m.default.initialize(c);
    return (loaded = m.default);
  }));

export default {
  initialize(config: Config) {
    configs.push(config);
    loaded?.initialize(config);
  },
  parse: async (...a: Parameters<Mermaid['parse']>) => (await load()).parse(...a),
  render: async (...a: Parameters<Mermaid['render']>) => (await load()).render(...a),
};
