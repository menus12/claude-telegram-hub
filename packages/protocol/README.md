# @claude-telegram-hub/protocol

The versioned, deployment-agnostic **seam** shared by the hub and the thin channel: message
types, the session↔hub wire protocol, hub/channel config schemas, and rendering/notice helpers.
Defined once as [Zod](https://zod.dev) schemas with inferred TypeScript types so the two
artifacts can't drift.

- **Wire protocol & versioning:** [`docs/protocol.md`](../../docs/protocol.md)
- **Config contract:** [`docs/configuration.md`](../../docs/configuration.md)

```ts
import {
  PROTOCOL_VERSION,
  isProtocolCompatible,
  inboundMessageSchema,
  sessionToHubFrameSchema,
  loadHubConfig,
  resolveChannelConfig,
} from "@claude-telegram-hub/protocol";
```

No runtime deps beyond `zod`; no `process`/filesystem access (loaders take an explicit `env`
map), so it stays isomorphic and trivially testable.
